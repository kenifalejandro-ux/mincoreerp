// La pestaña «Detalle» del Control TV (gerencia): lo que hace falta para decidir y que el resumen no
// trae: el consumo anterior para comparar, la urea del período, las últimas recepciones contra su
// factura, las unidades que más se desvían y cuánto cuesta comprar en ruta. Todo sale de lo que ya
// existe; no se guarda nada nuevo. Solo con Combustible (lo decide quien llama).
import type { PoolClient } from "pg";

import { LITROS_POR_GALON, litrosSql } from "../../server/shared/utils/unidades";
import { agregarAmbitoVales, filtroHechoDeGrifo, type AmbitoVales } from "./alcance";
import type { CombustibleService } from "./combustible.service";
import { INICIO_SQL, PERIODO, type PeriodoTv } from "./controlTv.service";

const num = (x: unknown) => Number(x ?? 0);

/** El combustible que llegó a unidades en el período anterior (igual de largo), para decir «▲ 12 %». */
async function consumoAnteriorGal(
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
    `d.despachado_en >= ${INICIO_SQL} - ($3::int * $4::interval)`,
    `d.despachado_en < ${INICIO_SQL}`,
  ];
  agregarAmbitoVales(condiciones, valores, "d", ambito);
  const r = await client.query(
    `SELECT COALESCE(SUM(${litrosSql("t")}), 0) / ${LITROS_POR_GALON} AS gal
       FROM combustible_despachos d
       LEFT JOIN combustible t ON t.id = COALESCE(d.combustible_id, d.tanque_excedente_id)
                              AND t.tenant_id = d.tenant_id
      WHERE ${condiciones.join(" AND ")}`,
    valores
  );
  return num(r.rows[0].gal);
}

/** La urea del período: lo que salió del almacén y lo comprado en ruta, por hora o por día, lo que
 *  entró al almacén y el período anterior. En litros. */
async function urea(client: PoolClient, tenantId: string, periodo: PeriodoTv) {
  const { unidad, n, paso } = PERIODO[periodo];
  const base = [tenantId, unidad, n, paso];
  const serie = await client.query<{
    t: Date;
    grupo: string | null;
    l: string | null;
    costo: string | null;
  }>(
    `WITH b AS (
       SELECT generate_series(${INICIO_SQL}, date_trunc($2::text, now(), 'America/Lima'),
                              $4::interval) AS t),
     v AS (
       SELECT date_trunc($2::text, d.despachado_en, 'America/Lima') AS t,
              CASE WHEN d.origen = 'almacen' THEN 'almacen' ELSE 'ruta' END AS grupo,
              SUM(d.cantidad) AS l, SUM(d.cantidad * d.costo_unitario) AS costo
         FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.producto = 'urea' AND d.anulada_en IS NULL
          AND d.despachado_en >= ${INICIO_SQL}
        GROUP BY 1, 2)
     SELECT b.t, v.grupo, v.l, v.costo FROM b LEFT JOIN v ON v.t = b.t ORDER BY b.t`,
    base
  );
  const porCorte = new Map<string, { almacen_l: number; ruta_l: number; costo: number }>();
  for (const f of serie.rows) {
    const k = f.t.toISOString();
    const fila = porCorte.get(k) ?? { almacen_l: 0, ruta_l: 0, costo: 0 };
    if (f.grupo === "almacen") fila.almacen_l = num(f.l);
    if (f.grupo === "ruta") fila.ruta_l = num(f.l);
    fila.costo += num(f.costo);
    porCorte.set(k, fila);
  }
  const puntos = [...porCorte].map(([t, v]) => ({ t, ...v, l: v.almacen_l + v.ruta_l }));
  const total = puntos.reduce(
    (a, p) => ({
      l: a.l + p.l,
      almacen_l: a.almacen_l + p.almacen_l,
      ruta_l: a.ruta_l + p.ruta_l,
      costo: a.costo + p.costo,
    }),
    { l: 0, almacen_l: 0, ruta_l: 0, costo: 0 }
  );
  const antes = await client.query(
    `SELECT COALESCE(SUM(d.cantidad), 0) AS l FROM combustible_despachos d
      WHERE d.tenant_id = $1 AND d.producto = 'urea' AND d.anulada_en IS NULL
        AND d.despachado_en >= ${INICIO_SQL} - ($3::int * $4::interval)
        AND d.despachado_en < ${INICIO_SQL}`,
    base
  );
  const entro = await client.query(
    `SELECT count(*)::int AS entradas, COALESCE(SUM(r.cantidad), 0) AS l,
            COALESCE(SUM(r.cantidad * r.costo_unitario), 0) AS costo
       FROM combustible_recepciones r
      WHERE r.tenant_id = $1 AND r.producto = 'urea' AND r.anulada_en IS NULL
        AND r.recibido_en >= ${INICIO_SQL}`,
    base
  );
  return {
    total,
    anterior_l: num(antes.rows[0].l),
    serie: puntos,
    entro: {
      entradas: entro.rows[0].entradas as number,
      l: num(entro.rows[0].l),
      costo: num(entro.rows[0].costo),
    },
  };
}

/** Las últimas recepciones de combustible, con lo que decía la factura y la diferencia. La
 *  diferencia se marca solo donde se sabe lo facturado; la tolerancia es la de la empresa. */
async function ultimasRecepciones(client: PoolClient, tenantId: string, ambito: AmbitoVales) {
  const f = filtroHechoDeGrifo(ambito.alcance, "r", 2);
  const gal = (col: string, u: string) =>
    `(${col} / CASE WHEN ${u} = 'L' THEN ${LITROS_POR_GALON} ELSE 1 END)`;
  const recibido = gal("(r.cantidad + r.cantidad_derivada)", "c.unidad");
  const facturado = `COALESCE(${gal("co.cantidad_facturada", "co.unidad")}, ${gal("r.cantidad_documento", "c.unidad")})`;
  const r = await client.query(
    `SELECT r.id, r.recibido_en, g.nombre AS proveedor, r.numero_documento AS factura,
            ${recibido} AS recibido_gal, ${facturado} AS facturado_gal,
            r.cantidad * r.costo_unitario AS costo,
            COALESCE((SELECT cc.tolerancia_diferencia_compra FROM combustible_config cc
                       WHERE cc.tenant_id = $1), 3) AS tolerancia_gal
       FROM combustible_recepciones r
       JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
       LEFT JOIN combustible_grifos g ON g.id = r.grifo_id AND g.tenant_id = r.tenant_id
       LEFT JOIN combustible_compras_cisterna co ON co.id = r.compra_id AND co.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.producto = 'combustible' AND r.anulada_en IS NULL AND ${f.sql}
      ORDER BY r.recibido_en DESC, r.id DESC LIMIT 6`,
    [tenantId, ...f.valores]
  );
  return r.rows.map((x) => ({
    id: x.id,
    recibido_en: new Date(x.recibido_en).toISOString(),
    proveedor: x.proveedor ?? null,
    factura: x.factura ?? null,
    recibido_gal: num(x.recibido_gal),
    facturado_gal: x.facturado_gal == null ? null : num(x.facturado_gal),
    diferencia_gal: x.facturado_gal == null ? null : num(x.recibido_gal) - num(x.facturado_gal),
    tolerancia_gal: num(x.tolerancia_gal),
    costo: num(x.costo),
  }));
}

/** Las unidades que más se apartan de lo normal: contra sus pares (misma marca y modelo) y contra su
 *  propio pasado. Es el reporte de consumo por equipo que ya existe, recortado a las 6 más urgentes. */
async function desvios(
  client: PoolClient,
  tenantId: string,
  periodo: PeriodoTv,
  servicio: CombustibleService
) {
  const hasta = new Date();
  const horas = { "24h": 24, "7d": 168, "30d": 720 }[periodo];
  const reporte = await servicio.reporteConsumoEquipos(
    client,
    tenantId,
    new Date(hasta.getTime() - horas * 3_600_000).toISOString(),
    hasta.toISOString()
  );
  return reporte.equipos
    .filter((e) => e.periodo && (e.vs_pares_pct !== null || e.vs_pasado_pct !== null))
    .sort(
      (a, b) =>
        Math.max(Math.abs(b.vs_pares_pct ?? 0), Math.abs(b.vs_pasado_pct ?? 0)) -
        Math.max(Math.abs(a.vs_pares_pct ?? 0), Math.abs(a.vs_pasado_pct ?? 0))
    )
    .slice(0, 6)
    .map((e) => {
      const consumo = e.periodo?.consumo ?? 0;
      // Odómetro: km por galón; horómetro: galones por hora.
      const rendimiento =
        consumo > 0
          ? e.medidor === "odometro"
            ? { valor: LITROS_POR_GALON / consumo, unidad: "km/gal" }
            : { valor: consumo / LITROS_POR_GALON, unidad: "gal/h" }
          : null;
      return {
        equipo_id: e.equipo_id,
        placa: e.placa_codigo,
        tipo: e.tipo,
        cargado_gal: e.litros_cargados / LITROS_POR_GALON,
        rendimiento,
        vs_pares_pct: e.vs_pares_pct,
        vs_pasado_pct: e.vs_pasado_pct,
        diagnostico: e.diagnostico,
      };
    });
}

/** Lo comprado en ruta, por grifo, y cuánto se pagó de más contra cargar en el grifo interno (al
 *  precio al que salió el combustible interno en el período). */
async function compraRuta(
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
  const filas = await client.query(
    `SELECT CASE WHEN d.origen = 'compra_externa' THEN 'ruta' ELSE 'interno' END AS grupo,
            COALESCE(g.nombre, 'Sin identificar') AS grifo, count(*)::int AS compras,
            SUM(${litrosSql("t")}) / ${LITROS_POR_GALON} AS gal,
            SUM(d.cantidad * d.costo_unitario) AS costo
       FROM combustible_despachos d
       LEFT JOIN combustible t ON t.id = COALESCE(d.combustible_id, d.tanque_excedente_id)
                              AND t.tenant_id = d.tenant_id
       LEFT JOIN combustible_grifos g ON g.id = d.grifo_id AND g.tenant_id = d.tenant_id
      WHERE ${condiciones.join(" AND ")}
      GROUP BY 1, 2`,
    valores
  );
  const interno = filas.rows.filter((f) => f.grupo === "interno");
  const galInt = interno.reduce((s, f) => s + num(f.gal), 0);
  const precioInterno = galInt > 0 ? interno.reduce((s, f) => s + num(f.costo), 0) / galInt : null;
  const porGrifo = filas.rows
    .filter((f) => f.grupo === "ruta")
    .map((f) => ({
      grifo: f.grifo as string,
      gal: num(f.gal),
      compras: f.compras as number,
      precio_gal: num(f.gal) > 0 ? num(f.costo) / num(f.gal) : 0,
    }))
    .sort((a, b) => b.gal - a.gal);
  const sobrecosto =
    precioInterno === null
      ? null
      : porGrifo.reduce((s, g) => s + g.gal * (g.precio_gal - precioInterno), 0);
  return {
    gal: porGrifo.reduce((s, g) => s + g.gal, 0),
    compras: porGrifo.reduce((s, g) => s + g.compras, 0),
    precio_interno_gal: precioInterno,
    sobrecosto,
    por_grifo: porGrifo,
  };
}

/** Todo lo de la pestaña «Detalle». La urea solo si quien mira ve Urea. */
export async function detalleControlTv(
  client: PoolClient,
  tenantId: string,
  periodo: PeriodoTv,
  ambito: AmbitoVales,
  servicio: CombustibleService,
  conUrea: boolean
) {
  return {
    periodo,
    consumo_anterior_gal: await consumoAnteriorGal(client, tenantId, periodo, ambito),
    ...(conUrea ? { urea: await urea(client, tenantId, periodo) } : {}),
    recepciones: await ultimasRecepciones(client, tenantId, ambito),
    desvios: await desvios(client, tenantId, periodo, servicio),
    compra_ruta: await compraRuta(client, tenantId, periodo, ambito),
  };
}
