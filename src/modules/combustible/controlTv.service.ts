// El resumen del Control TV (la pantalla de la gerencia): la flota por estado y, si la empresa tiene
// Combustible, lo que hay en tanques, tanquetas y cisternas, las alertas y la urea por envase. Todo
// sale de lo que ya existe, en una sola consulta con una sola conexión: no se guarda nada nuevo.
// Combustible y Urea son OPCIONALES: sin ese módulo el bloque no se arma (la pantalla lo omite), no
// hay 403 ni error.
import type { PoolClient } from "pg";

import { LITROS_POR_GALON } from "../../server/shared/utils/unidades";
import type { AlcanceCombustible } from "./alcance";
import { listarCompras } from "./comprasCisterna.service";
import type { CombustibleService } from "./combustible.service";
import { detencionDe } from "./motivosDetencion";
import { listarTanquetas } from "./tanquetas.service";
import { posicion, type FilaParada } from "./viajes.service";

export interface ContextoControlTv {
  alcance: AlcanceCombustible;
  /** La empresa y el usuario tienen Combustible: sin él no hay bloque de combustible ni de urea. */
  combustible: boolean;
  /** Además, ve la pestaña de Urea. */
  urea: boolean;
}

const num = (x: unknown) => Number(x ?? 0);
const aGalones = (cantidad: unknown, unidad: unknown) =>
  unidad === "L" ? num(cantidad) / LITROS_POR_GALON : num(cantidad);

interface FilaViajeVivo {
  tipo: string | null;
  estado: "programado" | "en_curso";
  paradas: (FilaParada & { lugar_id: number })[] | null;
  descanso_motivo: string | null;
  descansando: boolean;
}

/** La flota por estado: en ruta, retornando, en parada, descansando o detenida (avería, accidente...),
 *  más cuántas unidades de cada tipo hay en operación. */
async function flota(client: PoolClient, tenantId: string) {
  const r = await client.query<FilaViajeVivo>(
    `SELECT e.tipo, v.estado,
            (SELECT json_agg(json_build_object('orden', p.orden, 'lugar_id', p.lugar_id,
                      'llegada_en', p.llegada_en, 'salida_en', p.salida_en) ORDER BY p.orden)
               FROM combustible_viaje_paradas p
              WHERE p.tenant_id = v.tenant_id AND p.viaje_id = v.id) AS paradas,
            d.motivo AS descanso_motivo, d.id IS NOT NULL AS descansando
       FROM combustible_viajes v
       JOIN equipos e ON e.id = v.equipo_id AND e.tenant_id = v.tenant_id
       LEFT JOIN LATERAL (
         SELECT d.id, d.motivo FROM combustible_viaje_descansos d
          WHERE d.tenant_id = v.tenant_id AND d.viaje_id = v.id AND d.fin_en IS NULL AND d.detiene
          LIMIT 1) d ON true
      WHERE v.tenant_id = $1 AND v.estado IN ('programado', 'en_curso')`,
    [tenantId]
  );
  const c = {
    programados: 0,
    en_ruta: 0,
    retornando: 0,
    en_parada: 0,
    descansando: 0,
    detenidas: 0,
  };
  const porTipo = new Map<string, number>();
  let activos = 0;
  for (const v of r.rows) {
    if (v.estado === "programado") {
      c.programados += 1;
      continue;
    }
    activos += 1;
    const tipo = (v.tipo ?? "").trim() || "Otro";
    porTipo.set(tipo, (porTipo.get(tipo) ?? 0) + 1);
    if (v.descansando) {
      c[detencionDe(v.descanso_motivo) ? "detenidas" : "descansando"] += 1;
      continue;
    }
    const p = v.paradas ?? [];
    const pos = posicion(p);
    if (pos.tipo === "en_parada") c.en_parada += 1;
    else if (pos.tipo === "en_marcha" && pos.hacia > 1 && pos.hacia === p.length - 1) {
      c[p[pos.hacia].lugar_id === p[0].lugar_id ? "retornando" : "en_ruta"] += 1;
    } else c.en_ruta += 1;
  }
  return {
    activos,
    ...c,
    por_tipo: [...porTipo].map(([tipo, cantidad]) => ({ tipo, cantidad })),
  };
}

async function combustible(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible,
  servicio: CombustibleService
) {
  const grifos = alcance.todo ? null : alcance.grifos;
  // Una consulta tras otra: una sola conexión no admite varias a la vez (pg lo desaconseja).
  const tanques = await servicio.getAll(client, tenantId, alcance);
  const tanquetas = await listarTanquetas(client, tenantId, alcance, { soloActivas: true });
  const cisternas = await servicio.listarCisternasConSaldo(client, tenantId, grifos);
  const compras = await listarCompras(client, tenantId, alcance, true);
  const alertas = await servicio.contarAlertas(client, tenantId, {}, alcance);
  const activos = tanques.filter((t: { activo: boolean }) => t.activo);
  const porLlegar = compras.filter((c: { estado: string }) => c.estado === "por_llegar");
  return {
    tanques: activos.map((t: Record<string, unknown>) => ({
      id: t.id,
      nombre: t.tanque_nombre,
      tipo_combustible: t.tipo_combustible,
      unidad: t.unidad,
      capacidad: num(t.capacidad_total),
      minimo: t.nivel_minimo == null ? null : num(t.nivel_minimo),
      nivel: t.nivel_teorico ?? t.nivel_actual ?? null,
      costo_promedio: t.costo_promedio == null ? null : num(t.costo_promedio),
    })),
    total_en_tanques_gal: activos.reduce(
      (s: number, t: Record<string, unknown>) =>
        s + aGalones(t.nivel_teorico ?? t.nivel_actual, t.unidad),
      0
    ),
    tanquetas: {
      saldo_total_gal: tanquetas.reduce((s, t) => s + Math.max(0, num(t.saldo)), 0),
      items: tanquetas.map((t) => ({
        id: t.id,
        codigo: t.codigo,
        grifo: t.grifo_nombre,
        saldo: num(t.saldo),
        capacidad: num(t.capacidad),
        equipo_asignado: t.asignada_vigente ? t.equipo_asignado : null,
      })),
    },
    cisternas: {
      con_saldo: cisternas.length,
      saldo_gal: cisternas.reduce((s, c) => s + aGalones(c.saldo, c.unidad), 0),
      por_llegar: porLlegar.length,
      por_llegar_gal: porLlegar.reduce(
        (s: number, c: { cantidad_facturada: unknown; unidad: unknown }) =>
          s + aGalones(c.cantidad_facturada, c.unidad),
        0
      ),
    },
    alertas: {
      criticas: num(alertas.criticasPendientes),
      por_revisar: num(alertas.porRevisar),
    },
  };
}

async function urea(client: PoolClient, tenantId: string, servicio: CombustibleService) {
  const u = await servicio.getEstadoStockUrea(client, tenantId);
  return {
    stock_l: u.stockL,
    minimo_l: u.stockMinimoL,
    maximo_l: u.stockMaximoL,
    autonomia_dias: u.autonomiaDias,
    consumo_diario_l: u.consumoDiarioL,
    en_ruta_mes: u.enRutaMes,
    envases: u.envases.map((e) => ({
      nombre: e.nombre,
      unidades: e.unidades,
      litros: e.litros,
      entraron_mes: e.entraronMes,
      salieron_mes: e.salieronMes,
      ultimo_conteo: e.ultimoConteo ?? null,
    })),
  };
}

/** El resumen completo. Los bloques de combustible y urea solo aparecen si el contexto los permite. */
export async function resumenControlTv(
  client: PoolClient,
  tenantId: string,
  ctx: ContextoControlTv,
  servicio: CombustibleService
) {
  return {
    generado_en: new Date().toISOString(),
    flota: await flota(client, tenantId),
    ...(ctx.combustible
      ? { combustible: await combustible(client, tenantId, ctx.alcance, servicio) }
      : {}),
    ...(ctx.combustible && ctx.urea ? { urea: await urea(client, tenantId, servicio) } : {}),
  };
}
