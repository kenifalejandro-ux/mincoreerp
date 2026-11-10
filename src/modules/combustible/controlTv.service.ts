// El resumen del Control TV (la pantalla de la gerencia): la flota por estado y, si la empresa tiene
// Combustible, lo que hay en tanques, tanquetas y cisternas, las alertas y la urea por envase. Todo
// sale de lo que ya existe, en una sola consulta con una sola conexión: no se guarda nada nuevo.
// Combustible y Urea son OPCIONALES: sin ese módulo el bloque no se arma (la pantalla lo omite), no
// hay 403 ni error.
import type { PoolClient } from "pg";

import { LITROS_POR_GALON, litrosSql } from "../../server/shared/utils/unidades";
import {
  agregarAmbitoVales,
  filtroHechoDeGrifo,
  unidadEnAlcance,
  type AlcanceCombustible,
  type AmbitoVales,
} from "./alcance";
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
  /** Quien mira (el alcance de los vales incluye lo que cargó él mismo). */
  usuarioId: string;
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
async function flota(client: PoolClient, tenantId: string, alcance: AlcanceCombustible) {
  const fU = unidadEnAlcance(alcance, "e", 2);
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
      WHERE v.tenant_id = $1 AND v.estado IN ('programado', 'en_curso') AND ${fU.sql}`,
    [tenantId, ...fU.valores]
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

// ── Últimos eventos ────────────────────────────────────────────────────────

export interface EventoTv {
  t: string;
  tipo: "carga" | "compra_ruta" | "recepcion" | "llegada" | "detenida";
  titulo: string;
  detalle: string;
}

/** Los últimos 5 movimientos de la empresa: cargas a unidades, compras en ruta, recepciones de
 *  cisterna, llegadas a una parada y unidades detenidas. Las dos primeras clases solo si tiene
 *  Combustible; las llegadas y las detenciones salen de Viajes. */
async function eventos(client: PoolClient, tenantId: string, ctx: ContextoControlTv) {
  const todos: (EventoTv & { ms: number })[] = [];
  const poner = (t: Date, tipo: EventoTv["tipo"], titulo: string, detalle: string) =>
    todos.push({ t: new Date(t).toISOString(), ms: new Date(t).getTime(), tipo, titulo, detalle });

  if (ctx.combustible) {
    const valores: unknown[] = [tenantId];
    const condiciones = [
      "d.tenant_id = $1",
      "d.producto = 'combustible'",
      "d.anulada_en IS NULL",
      "d.tipo_destino IS DISTINCT FROM 'reserva_cubeta'",
      "d.despachado_en >= now() - interval '7 days'",
    ];
    agregarAmbitoVales(condiciones, valores, "d", {
      alcance: ctx.alcance,
      usuarioId: ctx.usuarioId,
      grifos: null,
    });
    const cargas = await client.query(
      `SELECT d.despachado_en AS t, d.origen, e.placa_codigo AS placa,
              ${litrosSql("t")} / ${LITROS_POR_GALON} AS gal
         FROM combustible_despachos d
         LEFT JOIN equipos e ON e.id = d.equipo_id AND e.tenant_id = d.tenant_id
         LEFT JOIN combustible t ON t.id = COALESCE(d.combustible_id, d.tanque_excedente_id)
                                AND t.tenant_id = d.tenant_id
        WHERE ${condiciones.join(" AND ")}
        ORDER BY d.despachado_en DESC LIMIT 5`,
      valores
    );
    for (const c of cargas.rows) {
      const origen =
        c.origen === "tanqueta"
          ? "desde tanqueta"
          : c.origen === "compra_externa"
            ? "compra en ruta"
            : "desde el tanque";
      const compra = c.origen === "compra_externa";
      poner(
        c.t,
        compra ? "compra_ruta" : "carga",
        compra ? "Compra en ruta" : `Carga ${c.placa ?? "a unidad"}`,
        `${c.placa && compra ? `${c.placa} · ` : ""}${num(c.gal).toFixed(1)} gal · ${origen}`
      );
    }
    const fHecho = filtroHechoDeGrifo(ctx.alcance, "r", 2);
    const recepciones = await client.query(
      `SELECT r.recibido_en AS t, c.tanque_nombre,
              (r.cantidad + r.cantidad_derivada)
                / CASE WHEN c.unidad = 'L' THEN ${LITROS_POR_GALON} ELSE 1 END AS gal
         FROM combustible_recepciones r
         JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.producto = 'combustible' AND r.anulada_en IS NULL
          AND ${fHecho.sql}
        ORDER BY r.recibido_en DESC LIMIT 5`,
      [tenantId, ...fHecho.valores]
    );
    for (const r of recepciones.rows) {
      poner(
        r.t,
        "recepcion",
        "Recepción de cisterna",
        `${num(r.gal).toFixed(0)} gal · ${r.tanque_nombre}`
      );
    }
  }

  const fLl = unidadEnAlcance(ctx.alcance, "e", 2);
  const llegadas = await client.query(
    `SELECT p.llegada_en AS t, e.placa_codigo AS placa, v.conductor_nombre AS conductor, l.nombre AS lugar
       FROM combustible_viaje_paradas p
       JOIN combustible_viajes v ON v.id = p.viaje_id AND v.tenant_id = p.tenant_id
       JOIN equipos e ON e.id = v.equipo_id AND e.tenant_id = v.tenant_id
       JOIN combustible_lugares l ON l.id = p.lugar_id AND l.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.orden > 0 AND p.llegada_en IS NOT NULL AND v.estado <> 'anulado'
        AND ${fLl.sql}
      ORDER BY p.llegada_en DESC LIMIT 5`,
    [tenantId, ...fLl.valores]
  );
  for (const l of llegadas.rows) {
    poner(
      l.t,
      "llegada",
      `Llegada a ${l.lugar}`,
      `${l.placa}${l.conductor ? ` · ${l.conductor}` : ""}`
    );
  }
  const detenidas = await client.query(
    `SELECT d.inicio_en AS t, e.placa_codigo AS placa, d.conductor_nombre AS conductor, d.motivo
       FROM combustible_viaje_descansos d
       JOIN combustible_viajes v ON v.id = d.viaje_id AND v.tenant_id = d.tenant_id
       JOIN equipos e ON e.id = v.equipo_id AND e.tenant_id = v.tenant_id
      WHERE d.tenant_id = $1 AND d.detiene AND v.estado <> 'anulado'
        AND ${fLl.sql}
      ORDER BY d.inicio_en DESC LIMIT 10`,
    [tenantId, ...fLl.valores]
  );
  for (const d of detenidas.rows) {
    const motivo = detencionDe(d.motivo);
    if (motivo) {
      poner(
        d.t,
        "detenida",
        `Detenida por ${motivo.toLowerCase()}`,
        `${d.placa}${d.conductor ? ` · ${d.conductor}` : ""}`
      );
    }
  }
  return todos
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map(({ ms: _ms, ...e }) => e);
}

/** La empresa y las sedes que quien mira tiene a la vista, para el encabezado de la pantalla. Con
 *  alcance «todo» no se listan sedes: el encabezado dice «Todas las sedes». */
async function encabezado(client: PoolClient, tenantId: string, alcance: AlcanceCombustible) {
  const e = await client.query<{ nombre: string }>(`SELECT nombre FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  let sedes: string[] | null = null;
  if (!alcance.todo) {
    const r = await client.query<{ nombre: string }>(
      `SELECT DISTINCT s.nombre FROM grifos_internos g
         JOIN sedes s ON s.id = g.sede_id AND s.tenant_id = g.tenant_id
        WHERE g.tenant_id = $1 AND g.id = ANY($2::int[]) ORDER BY s.nombre`,
      [tenantId, alcance.grifos]
    );
    sedes = r.rows.map((x) => x.nombre);
  }
  return { empresa: e.rows[0]?.nombre ?? "", sedes };
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
    ...(await encabezado(client, tenantId, ctx.alcance)),
    flota: await flota(client, tenantId, ctx.alcance),
    eventos: await eventos(client, tenantId, ctx),
    ...(ctx.combustible
      ? { combustible: await combustible(client, tenantId, ctx.alcance, servicio) }
      : {}),
    ...(ctx.combustible && ctx.urea ? { urea: await urea(client, tenantId, servicio) } : {}),
  };
}

// ── Consumo y entrada de combustible por período ───────────────────────────

export const PERIODOS_TV = ["24h", "7d", "30d"] as const;
export type PeriodoTv = (typeof PERIODOS_TV)[number];

/** 24 h se agrupa por hora; 7 y 30 días, por día. Los cortes son de la hora de Lima. */
export const PERIODO: Record<PeriodoTv, { unidad: "hour" | "day"; n: number; paso: string }> = {
  "24h": { unidad: "hour", n: 24, paso: "1 hour" },
  "7d": { unidad: "day", n: 7, paso: "1 day" },
  "30d": { unidad: "day", n: 30, paso: "1 day" },
};
export const INICIO_SQL = `date_trunc($2::text, now(), 'America/Lima') - ($3::int - 1) * $4::interval`;

type Grupo = "interno" | "tanqueta" | "ruta";
const GRUPOS: Grupo[] = ["interno", "tanqueta", "ruta"];

/** Lo que llegó a una unidad, en galones y en soles, por hora o por día y por origen: grifo
 *  interno, tanqueta o compra en ruta. El vale que solo llena una tanqueta desde el tanque
 *  (destino «reserva_cubeta») es un traspaso entre depósitos y NO cuenta: el combustible se cuenta
 *  cuando de ahí se carga a una unidad. Los cortes vacíos salen en 0 para que la gráfica no tenga huecos. */
async function consumo(
  client: PoolClient,
  tenantId: string,
  periodo: PeriodoTv,
  ambito: AmbitoVales
) {
  const { unidad, n, paso } = PERIODO[periodo];
  const valores: unknown[] = [tenantId, unidad, n, paso];
  const condiciones = [
    "d.tenant_id = $1",
    "d.producto = 'combustible'",
    "d.anulada_en IS NULL",
    "d.tipo_destino IS DISTINCT FROM 'reserva_cubeta'",
    `d.despachado_en >= ${INICIO_SQL}`,
  ];
  agregarAmbitoVales(condiciones, valores, "d", ambito);
  const r = await client.query<{
    t: Date;
    grupo: Grupo | null;
    gal: string | null;
    costo: string | null;
  }>(
    `WITH b AS (
       SELECT generate_series(${INICIO_SQL}, date_trunc($2::text, now(), 'America/Lima'),
                              $4::interval) AS t),
     v AS (
       SELECT date_trunc($2::text, d.despachado_en, 'America/Lima') AS t,
              CASE WHEN d.origen = 'tanqueta' THEN 'tanqueta'
                   WHEN d.origen IN ('tanque_propio', 'excedente_recepcion') THEN 'interno'
                   ELSE 'ruta' END AS grupo,
              SUM(${litrosSql("t")}) / ${LITROS_POR_GALON} AS gal,
              SUM(d.cantidad * d.costo_unitario) AS costo
         FROM combustible_despachos d
         LEFT JOIN combustible t ON t.id = COALESCE(d.combustible_id, d.tanque_excedente_id)
                                AND t.tenant_id = d.tenant_id
        WHERE ${condiciones.join(" AND ")}
        GROUP BY 1, 2)
     SELECT b.t, v.grupo, v.gal, v.costo FROM b LEFT JOIN v ON v.t = b.t ORDER BY b.t`,
    valores
  );
  const porCorte = new Map<string, Record<Grupo, { gal: number; costo: number }>>();
  for (const f of r.rows) {
    const clave = f.t.toISOString();
    const fila =
      porCorte.get(clave) ??
      (Object.fromEntries(GRUPOS.map((g) => [g, { gal: 0, costo: 0 }])) as Record<
        Grupo,
        { gal: number; costo: number }
      >);
    if (f.grupo) fila[f.grupo] = { gal: num(f.gal), costo: num(f.costo) };
    porCorte.set(clave, fila);
  }
  const total = { gal: 0, costo: 0, interno_gal: 0, tanqueta_gal: 0, ruta_gal: 0 };
  const serie = [...porCorte].map(([t, g]) => {
    const gal = GRUPOS.reduce((s, k) => s + g[k].gal, 0);
    const costo = GRUPOS.reduce((s, k) => s + g[k].costo, 0);
    total.gal += gal;
    total.costo += costo;
    for (const k of GRUPOS) total[`${k}_gal` as const] += g[k].gal;
    return {
      t,
      gal,
      costo,
      interno_gal: g.interno.gal,
      tanqueta_gal: g.tanqueta.gal,
      ruta_gal: g.ruta.gal,
    };
  });
  return { periodo, agrupado_por: unidad === "hour" ? "hora" : "dia", total, serie };
}

/** Lo que entró a la empresa en el período: lo recibido (al tanque y lo que sobró para tanquetas y
 *  cisternas), lo que decían las facturas y la diferencia, más las últimas recepciones. Todo en
 *  galones. La diferencia solo se calcula en las recepciones que vienen de una compra registrada. */
async function entrada(
  client: PoolClient,
  tenantId: string,
  periodo: PeriodoTv,
  alcance: AlcanceCombustible
) {
  const { unidad, n, paso } = PERIODO[periodo];
  const valores: unknown[] = [tenantId, unidad, n, paso];
  const f = filtroHechoDeGrifo(alcance, "r", valores.length + 1);
  valores.push(...f.valores);
  const gal = (col: string, u: string) =>
    `(${col} / CASE WHEN ${u} = 'L' THEN ${LITROS_POR_GALON} ELSE 1 END)`;
  const desde = `
    FROM combustible_recepciones r
    JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
    LEFT JOIN combustible_compras_cisterna co ON co.id = r.compra_id AND co.tenant_id = r.tenant_id
   WHERE r.tenant_id = $1 AND r.producto = 'combustible' AND r.anulada_en IS NULL
     AND r.recibido_en >= ${INICIO_SQL} AND ${f.sql}`;
  const recibido = gal("r.cantidad + r.cantidad_derivada", "c.unidad");
  const dif = `(${recibido} - ${gal("co.cantidad_facturada", "co.unidad")})`;
  const resumen = await client.query(
    `SELECT count(*)::int AS recepciones,
            COALESCE(SUM(${gal("r.cantidad", "c.unidad")}), 0) AS al_tanque_gal,
            COALESCE(SUM(${gal("r.cantidad_derivada", "c.unidad")}), 0) AS derivado_gal,
            COALESCE(SUM(r.cantidad * r.costo_unitario), 0) AS costo,
            COALESCE(SUM(CASE WHEN r.compra_id IS NOT NULL
                              THEN ${gal("co.cantidad_facturada", "co.unidad")} END), 0) AS facturado_gal,
            COALESCE(SUM(CASE WHEN r.compra_id IS NOT NULL THEN ${dif} END), 0) AS diferencia_gal
       ${desde}`,
    valores
  );
  const ultimas = await client.query(
    `SELECT r.id, r.recibido_en, c.tanque_nombre, ${recibido} AS gal,
            r.cantidad * r.costo_unitario AS costo, co.numero_documento AS compra_documento,
            CASE WHEN r.compra_id IS NOT NULL THEN ${dif} END AS diferencia_gal
       ${desde} ORDER BY r.recibido_en DESC, r.id DESC LIMIT 5`,
    valores
  );
  const x = resumen.rows[0];
  return {
    recepciones: x.recepciones as number,
    recibido_gal: num(x.al_tanque_gal) + num(x.derivado_gal),
    al_tanque_gal: num(x.al_tanque_gal),
    derivado_gal: num(x.derivado_gal),
    costo: num(x.costo),
    facturado_gal: num(x.facturado_gal),
    diferencia_gal: num(x.diferencia_gal),
    ultimas: ultimas.rows.map((u) => ({
      id: u.id,
      recibido_en: new Date(u.recibido_en).toISOString(),
      tanque: u.tanque_nombre,
      gal: num(u.gal),
      costo: num(u.costo),
      compra_documento: u.compra_documento ?? null,
      diferencia_gal: u.diferencia_gal == null ? null : num(u.diferencia_gal),
    })),
  };
}

/** El nivel de cada tanque en el período, con sus lecturas de varilla (no se inventa nada entre una
 *  y otra: son los puntos medidos), más su capacidad y su mínimo. */
async function niveles(
  client: PoolClient,
  tenantId: string,
  periodo: PeriodoTv,
  alcance: AlcanceCombustible,
  servicio: CombustibleService
) {
  const { unidad, n, paso } = PERIODO[periodo];
  const tanques = (await servicio.getAll(client, tenantId, alcance)).filter(
    (t: { activo: boolean }) => t.activo
  );
  if (tanques.length === 0) return [];
  const lecturas = await client.query<{ combustible_id: number; t: Date; nivel: string }>(
    `SELECT combustible_id, leido_en AS t, nivel FROM combustible_lecturas
      WHERE tenant_id = $1 AND anulada_en IS NULL AND combustible_id = ANY($5::int[])
        AND leido_en >= ${INICIO_SQL}
      ORDER BY leido_en`,
    [tenantId, unidad, n, paso, tanques.map((t: { id: number }) => t.id)]
  );
  return tanques.map((t: Record<string, unknown>) => ({
    id: t.id,
    nombre: t.tanque_nombre,
    unidad: t.unidad,
    capacidad: num(t.capacidad_total),
    minimo: t.nivel_minimo == null ? null : num(t.nivel_minimo),
    nivel_actual: t.nivel_teorico ?? t.nivel_actual ?? null,
    puntos: lecturas.rows
      .filter((l) => l.combustible_id === t.id)
      .map((l) => ({ t: new Date(l.t).toISOString(), nivel: num(l.nivel) })),
  }));
}

/** El consumo, la entrada y el nivel de los tanques del período. Solo con Combustible: sin él, el
 *  que llama no lo pide. */
export async function consumoControlTv(
  client: PoolClient,
  tenantId: string,
  periodo: PeriodoTv,
  ambito: AmbitoVales,
  servicio: CombustibleService
) {
  return {
    consumo: await consumo(client, tenantId, periodo, ambito),
    entrada: await entrada(client, tenantId, periodo, ambito.alcance),
    niveles: await niveles(client, tenantId, periodo, ambito.alcance, servicio),
  };
}
