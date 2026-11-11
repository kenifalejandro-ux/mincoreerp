// El resumen de una unidad en el Control TV (la pantalla de la gerencia): los viajes de su
// conductor, cómo rinde la unidad, cuánto tardó contra lo normal de su ruta, su última carga y sus
// alertas abiertas. Todo sale de lo que ya existe; no se guarda nada nuevo. Respeta el alcance: una
// unidad fuera del grifo o sede de quien mira responde igual que una que no existe.
import type { PoolClient } from "pg";

import { LITROS_POR_GALON } from "../../server/shared/utils/unidades";
import type { AmbitoVales } from "./alcance";
import type { CombustibleService } from "./combustible.service";
import { canalDeFila, TIPOS_CRITICOS } from "./canalesAlertas";
import { getViaje, recorridoClave, unidadVisible } from "./viajes.service";

/** Cuántos días mira el resumen según el período que elige quien está en la pantalla (24 h = 1 día). */
const DIAS_DEL_PERIODO = { "24h": 1, "7d": 7, "30d": 30 } as const;
export type PeriodoUnidadTv = keyof typeof DIAS_DEL_PERIODO;
const num = (x: unknown) => Number(x ?? 0);

/** Los viajes de un conductor: los que tiene ahora (en ruta y programados), los terminados y
 *  anulados del período elegido, y cuántos hizo en ese tiempo como titular y como relevo. Los
 *  contadores por estado cuentan solo los de titular; el relevo sale aparte, por viaje completo. */
async function conductor(client: PoolClient, tenantId: string, dni: string, dias: number) {
  const r = await client.query(
    `SELECT
       count(*) FILTER (WHERE v.conductor_dni = $2 AND v.estado = 'en_curso')::int AS en_ruta,
       count(*) FILTER (WHERE v.conductor_dni = $2 AND v.estado = 'programado')::int AS programados,
       count(*) FILTER (WHERE v.conductor_dni = $2 AND v.estado = 'cerrado'
                          AND COALESCE(v.fin_en, v.creado_en) >= now() - make_interval(days => $3))::int AS terminados,
       count(*) FILTER (WHERE v.conductor_dni = $2 AND v.estado = 'anulado'
                          AND v.creado_en >= now() - make_interval(days => $3))::int AS anulados,
       count(*) FILTER (WHERE v.conductor_dni = $2 AND v.estado <> 'anulado'
                          AND COALESCE(v.inicio_en, v.creado_en) >= now() - make_interval(days => $3))::int AS como_titular,
       count(*) FILTER (WHERE v.conductor_dni IS DISTINCT FROM $2 AND v.estado <> 'anulado'
                          AND COALESCE(v.inicio_en, v.creado_en) >= now() - make_interval(days => $3)
                          AND (v.relevo_dni = $2 OR EXISTS (
                                SELECT 1 FROM combustible_viaje_turnos t
                                 WHERE t.tenant_id = v.tenant_id AND t.viaje_id = v.id
                                   AND t.conductor_dni = $2)))::int AS como_relevo
       FROM combustible_viajes v
      WHERE v.tenant_id = $1 AND (v.conductor_dni = $2 OR v.relevo_dni = $2 OR EXISTS (
              SELECT 1 FROM combustible_viaje_turnos t
               WHERE t.tenant_id = v.tenant_id AND t.viaje_id = v.id AND t.conductor_dni = $2))`,
    [tenantId, dni, dias]
  );
  return r.rows[0] as {
    en_ruta: number;
    programados: number;
    terminados: number;
    anulados: number;
    como_titular: number;
    como_relevo: number;
  };
}

/** Cómo rinde la unidad en el período elegido, contra sus pares (misma marca y modelo) y contra su
 *  propio pasado. Es el reporte de consumo por equipo que ya existe, recortado a esta unidad. */
async function rendimiento(
  client: PoolClient,
  tenantId: string,
  equipoId: number,
  servicio: CombustibleService,
  dias: number
) {
  const hasta = new Date();
  const reporte = await servicio.reporteConsumoEquipos(
    client,
    tenantId,
    new Date(hasta.getTime() - dias * 86_400_000).toISOString(),
    hasta.toISOString()
  );
  const e = reporte.equipos.find((x) => x.equipo_id === equipoId);
  if (!e?.periodo) return null;
  const consumo = e.periodo.consumo ?? 0;
  // Odómetro: km por galón; horómetro: galones por hora.
  const valor =
    consumo > 0
      ? e.medidor === "odometro"
        ? { valor: LITROS_POR_GALON / consumo, unidad: "km/gal" }
        : { valor: consumo / LITROS_POR_GALON, unidad: "gal/h" }
      : null;
  return {
    rendimiento: valor,
    cargado_gal: e.litros_cargados / LITROS_POR_GALON,
    vs_pares_pct: e.vs_pares_pct,
    vs_pasado_pct: e.vs_pasado_pct,
    diagnostico: e.diagnostico,
  };
}

/** La estadía que suele pasar la unidad en las paradas de esta ruta (los viajes cerrados de los
 *  últimos 90 días), para compararla con la de este viaje. Con menos de 3 viajes no hay referencia. */
async function estadiaNormal(client: PoolClient, tenantId: string, viajeId: number, clave: string) {
  const r = await client.query(
    `WITH por_viaje AS (
       SELECT v.id, SUM(EXTRACT(EPOCH FROM (p.salida_en - p.llegada_en)) / 60) AS minutos
         FROM combustible_viajes v
         JOIN combustible_viaje_paradas p ON p.viaje_id = v.id AND p.tenant_id = v.tenant_id
        WHERE v.tenant_id = $1 AND v.estado = 'cerrado' AND v.id <> $2
          AND v.fin_en >= now() - interval '90 days'
          AND ${recorridoClave("v")} = $3
          AND p.orden > 0 AND p.llegada_en IS NOT NULL AND p.salida_en IS NOT NULL
        GROUP BY v.id)
     SELECT count(*)::int AS viajes, AVG(minutos) AS media FROM por_viaje`,
    [tenantId, viajeId, clave]
  );
  const { viajes, media } = r.rows[0];
  return viajes >= 3 ? { minutos: Math.round(num(media)), viajes: Number(viajes) } : null;
}

/** La última carga de combustible y la última de urea de la unidad. */
async function ultimasCargas(client: PoolClient, tenantId: string, equipoId: number) {
  const r = await client.query(
    `SELECT DISTINCT ON (d.producto) d.producto, d.despachado_en, d.cantidad, d.origen,
            CASE WHEN d.producto = 'urea' THEN 'L' ELSE COALESCE(c.unidad, 'L') END AS unidad
       FROM combustible_despachos d
       LEFT JOIN combustible c ON c.id = COALESCE(d.combustible_id, d.tanque_excedente_id)
                              AND c.tenant_id = d.tenant_id
      WHERE d.tenant_id = $1 AND d.equipo_id = $2 AND d.anulada_en IS NULL
        AND d.tipo_destino IS DISTINCT FROM 'reserva_cubeta'
      ORDER BY d.producto, d.despachado_en DESC`,
    [tenantId, equipoId]
  );
  return r.rows.map((x) => ({
    producto: x.producto as "combustible" | "urea",
    en: new Date(x.despachado_en).toISOString(),
    cantidad: num(x.cantidad),
    unidad: x.unidad as string,
    origen: x.origen as string,
  }));
}

export type GravedadAlerta = "critica" | "media" | "info";
const RANGO: Record<GravedadAlerta, number> = { critica: 0, media: 1, info: 2 };

/** Qué tan grave es una alerta, con las mismas reglas que la campanita: crítica si va al momento o es
 *  urgente (TIPOS_CRITICOS); media si va en el resumen del día; info si es solo un aviso en el ERP. */
export function gravedadDeAlerta(tipo: string): GravedadAlerta {
  if ((TIPOS_CRITICOS as readonly string[]).includes(tipo)) return "critica";
  return canalDeFila(tipo) === "resumen" ? "media" : "info";
}

/** Las alertas abiertas (sin resolver) sobre la unidad: las de sus viajes y las de sus vales. */
async function alertasAbiertas(client: PoolClient, tenantId: string, equipoId: number) {
  const r = await client.query(
    `SELECT a.tipo, a.creado_en
       FROM combustible_alertas a
      WHERE a.tenant_id = $1 AND a.resuelta_en IS NULL
        AND (a.viaje_id IN (SELECT v.id FROM combustible_viajes v
                             WHERE v.tenant_id = $1 AND v.equipo_id = $2)
             OR a.despacho_id IN (SELECT d.id FROM combustible_despachos d
                                   WHERE d.tenant_id = $1 AND d.equipo_id = $2))
      ORDER BY a.creado_en DESC`,
    [tenantId, equipoId]
  );
  const todas = r.rows.map((x) => ({
    tipo: x.tipo as string,
    creado_en: new Date(x.creado_en).toISOString(),
    gravedad: gravedadDeAlerta(x.tipo as string),
  }));
  // Primero las más graves; a igual gravedad, las más nuevas (ya vienen así de la consulta).
  const ordenadas = todas
    .map((a, i) => ({ a, i }))
    .sort((x, y) => RANGO[x.a.gravedad] - RANGO[y.a.gravedad] || x.i - y.i)
    .map((x) => x.a);
  return {
    total: todas.length,
    criticas: todas.filter((a) => a.gravedad === "critica").length,
    ultimas: ordenadas.slice(0, 3),
  };
}

/** Todo el resumen de la unidad del viaje; null si el viaje no existe o la unidad es de otro grifo. */
export async function resumenDeUnidad(
  client: PoolClient,
  tenantId: string,
  viajeId: number,
  ambito: AmbitoVales,
  servicio: CombustibleService,
  periodo: PeriodoUnidadTv = "30d"
) {
  const dias = DIAS_DEL_PERIODO[periodo];
  const viaje = await getViaje(client, tenantId, viajeId);
  if (!viaje) return null;
  if (!(await unidadVisible(client, tenantId, viaje.equipo_id, ambito))) return null;
  const dni: string | null = viaje.conductor_dni ?? null;
  const clave: string | null = viaje.recorrido_clave ?? null;
  return {
    dias,
    conductor: dni ? { dni, ...(await conductor(client, tenantId, dni, dias)) } : null,
    rendimiento: await rendimiento(client, tenantId, Number(viaje.equipo_id), servicio, dias),
    estadia_normal: clave ? await estadiaNormal(client, tenantId, viajeId, clave) : null,
    ultimas_cargas: await ultimasCargas(client, tenantId, Number(viaje.equipo_id)),
    alertas: await alertasAbiertas(client, tenantId, Number(viaje.equipo_id)),
  };
}
