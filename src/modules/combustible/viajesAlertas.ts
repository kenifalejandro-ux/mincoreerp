/** src/modules/combustible/viajesAlertas.ts
 *
 * Las alertas de un VIAJE (migración 0188, tabla `viaje_alertas`): demorado, detenido y creado por el
 * conductor. Son de Viajes y funcionan solas: no leen ni escriben nada de Combustible. Antes vivían en
 * `combustible_alertas`, y una empresa con Viajes y sin Combustible no tenía dónde verlas.
 *
 * Los tres tipos son ESTADOS: se abren una sola vez por viaje y tipo (índice único parcial) y se
 * cierran solos cuando el viaje llega, se cierra, se anula o la detención termina. Por eso aquí no
 * hay resolución manual ni congelado.
 *
 * Lo que ve cada persona (`GET /api/erp/viajes/alertas`) tiene la misma forma que la Bandeja de
 * Combustible, para que la misma pantalla sirva a las dos fuentes. Si la empresa tiene Combustible,
 * el alcance por grifo de cada usuario recorta también estas alertas. */
import type { PoolClient } from "pg";
import type { Request } from "express";

import type { Paginacion } from "../../server/shared/utils/pagination";
import type { AlcanceCombustible } from "./alcance";
import { viajesDemorados, viajesDetenidos, type ViajeDetenido } from "./viajes.service";

export const TIPOS_DE_ALERTA_DE_VIAJE = [
  "viaje_demorado",
  "viaje_detenido",
  "viaje_creado_por_conductor",
] as const;
export type TipoAlertaDeViaje = (typeof TIPOS_DE_ALERTA_DE_VIAJE)[number];

/** Las que salen en rojo en la Bandeja y el contador: la demora y la detención. «Creado por el
 *  conductor» es un aviso para que la oficina lo siga, no una urgencia. */
const TIPOS_CRITICOS_DE_VIAJE: readonly string[] = ["viaje_demorado", "viaje_detenido"];

/** Los eventos de tiempo real de estas alertas (los que escucha la Bandeja). */
export const EVENTO_ALERTA_DE_VIAJE_CREADA = "viajes.alerta_creada";
export const EVENTO_ALERTAS_DE_VIAJE_ACTUALIZADAS = "viajes.alertas_actualizadas";

export interface AlertaDeViajeNueva {
  tipo: TipoAlertaDeViaje;
  viajeId: number;
  detalle: Record<string, unknown>;
}

export const ESTADOS_DE_ALERTA_DE_VIAJE = [
  "sin_leer",
  "pendientes",
  "resueltas",
  "congeladas",
  "todas",
] as const;

export interface FiltrosAlertasDeViaje {
  soloNoLeidas?: boolean;
  estado?: (typeof ESTADOS_DE_ALERTA_DE_VIAJE)[number];
  id?: number;
  tipo?: string;
  grifoInternoId?: number;
  /** Días de calendario (AAAA-MM-DD), de Lima. */
  desde?: string;
  hasta?: string;
  texto?: string;
}

// ── Abrir y cerrar ─────────────────────────────────────────────────────────

/** Abre las alertas. El grifo es el de la unidad del viaje. Una abierta por viaje y tipo: si ya había,
 *  no se repite (devuelve solo las que nacieron). */
export async function crearAlertasDeViaje(
  client: PoolClient,
  tenantId: string,
  filas: AlertaDeViajeNueva[]
) {
  if (filas.length === 0) return [];
  const valores: unknown[] = [tenantId];
  const lineas = filas.map((f) => {
    const base = valores.length;
    valores.push(f.tipo, f.viajeId, JSON.stringify(f.detalle));
    return `($1::uuid, $${base + 1}::text, $${base + 2}::bigint, $${base + 3}::jsonb)`;
  });
  const r = await client.query(
    `INSERT INTO viaje_alertas (tenant_id, tipo, viaje_id, detalle, grifo_interno_id)
     SELECT n.tenant_id, n.tipo, n.viaje_id, n.detalle,
            (SELECT e.grifo_interno_id
               FROM combustible_viajes v
               JOIN equipos e ON e.tenant_id = v.tenant_id AND e.id = v.equipo_id
              WHERE v.tenant_id = n.tenant_id AND v.id = n.viaje_id)
       FROM (VALUES ${lineas.join(", ")}) AS n(tenant_id, tipo, viaje_id, detalle)
     ON CONFLICT (tenant_id, viaje_id, tipo) WHERE resuelta_en IS NULL DO NOTHING
     RETURNING id, tipo, viaje_id, detalle, creado_en, grifo_interno_id`,
    valores
  );
  return r.rows;
}

/** Los viajes que ya tienen abierta una alerta de ese tipo, de entre los que se pasan. */
async function viajesConAlertaAbierta(
  client: PoolClient,
  tenantId: string,
  tipo: "viaje_demorado" | "viaje_detenido",
  viajeIds: number[]
): Promise<Set<number>> {
  if (viajeIds.length === 0) return new Set();
  const r = await client.query<{ viaje_id: string }>(
    `SELECT DISTINCT viaje_id FROM viaje_alertas
      WHERE tenant_id = $1 AND tipo = $2 AND resuelta_en IS NULL
        AND viaje_id = ANY($3::bigint[])`,
    [tenantId, tipo, viajeIds]
  );
  return new Set(r.rows.map((f) => Number(f.viaje_id)));
}

/** Cierra las alertas abiertas de ese tipo de los viajes que YA NO están en esa situación: los que se
 *  pasan son los que siguen en ella. Lo resuelve el hecho, no una persona. */
async function resolverAlertasDeViaje(
  client: PoolClient,
  tenantId: string,
  tipo: "viaje_demorado" | "viaje_detenido",
  viajeIdsVigentes: number[]
): Promise<number> {
  const r = await client.query(
    `UPDATE viaje_alertas SET resuelta_en = now()
      WHERE tenant_id = $1 AND tipo = $2 AND resuelta_en IS NULL
        AND NOT (viaje_id = ANY($3::bigint[]))`,
    [tenantId, tipo, viajeIdsVigentes]
  );
  return r.rowCount ?? 0;
}

/** Cierra la alerta «viaje creado por el conductor» de los viajes que ya terminaron (cerrados o
 *  anulados); con `viajeId`, solo la de ese viaje. Se mira el ESTADO del viaje y no la operación que
 *  se hizo: llegar a una parada o editar no la cierran, terminar el viaje sí, por cualquier camino. */
async function resolverViajesCreadosPorConductorTerminados(
  client: PoolClient,
  tenantId: string,
  viajeId?: number
): Promise<number> {
  const r = await client.query(
    `UPDATE viaje_alertas a SET resuelta_en = now()
      WHERE a.tenant_id = $1 AND a.tipo = 'viaje_creado_por_conductor' AND a.resuelta_en IS NULL
        AND ($2::bigint IS NULL OR a.viaje_id = $2)
        AND EXISTS (SELECT 1 FROM combustible_viajes v
                     WHERE v.tenant_id = a.tenant_id AND v.id = a.viaje_id
                       AND v.estado IN ('cerrado', 'anulado'))`,
    [tenantId, viajeId ?? null]
  );
  return r.rowCount ?? 0;
}

/** Cierra la alerta abierta de ese tipo de UN viaje: la detención terminó. */
async function resolverAlertaDeUnViaje(
  client: PoolClient,
  tenantId: string,
  tipo: "viaje_demorado" | "viaje_detenido",
  viajeId: number
): Promise<number> {
  const r = await client.query(
    `UPDATE viaje_alertas SET resuelta_en = now()
      WHERE tenant_id = $1 AND tipo = $2 AND viaje_id = $3 AND resuelta_en IS NULL`,
    [tenantId, tipo, viajeId]
  );
  return r.rowCount ?? 0;
}

/** De esos viajes, los que SIGUEN en curso, leídos con candado: si otra transacción lo está cerrando o
 *  anulando, espera a que termine y mira el estado nuevo. Se usa justo antes de abrir alertas, para no
 *  dejar una de un viaje que acaba de cerrarse. */
async function viajesEnCurso(
  client: PoolClient,
  tenantId: string,
  ids: number[]
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const r = await client.query(
    `SELECT id FROM combustible_viajes
      WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND estado = 'en_curso'
      ORDER BY id FOR SHARE`,
    [tenantId, ids]
  );
  return new Set(r.rows.map((x) => Number(x.id)));
}

// ── El motor ───────────────────────────────────────────────────────────────

/** La fila de la alerta `viaje_detenido` de una detención abierta. */
function alertaDeDetencion(d: ViajeDetenido): AlertaDeViajeNueva {
  return {
    tipo: "viaje_detenido",
    viajeId: d.viaje_id,
    detalle: {
      viajeNumero: d.numero,
      unidad: d.placa_codigo ?? d.codigo_interno ?? null,
      conductor: d.conductor_nombre,
      detencion: d.detencion,
      motivo: d.motivo,
      donde: d.donde,
      desde: d.desde,
      marcadoPor: d.marcado_por,
    },
  };
}

/** La alerta de «unidad detenida» de UN viaje, al instante: se llama cuando alguien marca el comienzo
 *  o el fin de un descanso, para no esperar la pasada de cada hora del worker. Abre la alerta si el
 *  viaje tiene una detención abierta (y no tenía alerta), la cierra si ya no hay ninguna. El worker
 *  sigue de red de seguridad (viaje cerrado o anulado con la detención abierta). */
export async function evaluarDetencionDeUnViaje(
  client: PoolClient,
  tenantId: string,
  viajeId: number
) {
  const [detenido] = await viajesDetenidos(client, tenantId, viajeId);
  if (!detenido) {
    const cerradas = await resolverAlertaDeUnViaje(client, tenantId, "viaje_detenido", viajeId);
    return { cambio: cerradas > 0 };
  }
  const abiertas = await viajesConAlertaAbierta(client, tenantId, "viaje_detenido", [viajeId]);
  if (abiertas.has(viajeId)) return { cambio: false };
  await crearAlertasDeViaje(client, tenantId, [alertaDeDetencion(detenido)]);
  return { cambio: true };
}

/** Un viaje que se cerró o se anuló ya no está demorado ni detenido: se cierran sus alertas al
 *  instante, sin esperar al worker. Devuelve si había alguna abierta. */
export async function cerrarAlertasDeUnViaje(
  client: PoolClient,
  tenantId: string,
  viajeId: number
) {
  let cerradas = 0;
  for (const tipo of ["viaje_demorado", "viaje_detenido"] as const) {
    cerradas += await resolverAlertaDeUnViaje(client, tenantId, tipo, viajeId);
  }
  // La de «creado por el conductor» solo se cierra si el viaje terminó (cerrado o anulado).
  cerradas += await resolverViajesCreadosPorConductorTerminados(client, tenantId, viajeId);
  return cerradas > 0;
}

/** El conductor creó su propio viaje (0179): una alerta de ESTADO para que la oficina lo siga. Se abre
 *  una sola vez por viaje (índice único parcial) y se cierra sola al terminar el viaje. */
export async function abrirAlertaViajeCreadoPorConductor(
  client: PoolClient,
  tenantId: string,
  viaje: { id: number; numero: number; unidad: string | null; conductor: string | null },
  detalle: { de: string | null; a: string | null; unidadNueva: boolean }
) {
  await crearAlertasDeViaje(client, tenantId, [
    {
      tipo: "viaje_creado_por_conductor",
      viajeId: viaje.id,
      detalle: {
        viajeNumero: viaje.numero,
        unidad: viaje.unidad,
        conductor: viaje.conductor,
        ...detalle,
      },
    },
  ]);
  return true;
}

/** VIAJES EN RUTA: un viaje demorado (pasó la hora estimada de llegada del tramo, sin contar lo
 *  detenido) y uno detenido (avería, accidente, huaico, bloqueo o tráfico abierto). Los dos son
 *  ESTADOS: primero se cierran las alertas de los viajes que ya llegaron, se cerraron o salieron de esa
 *  situación, y después se abren las de los que entraron. Una alerta abierta por viaje y tipo; la
 *  demora cuenta solo el tiempo en marcha, así que una avería no la dispara: eso es lo que avisa
 *  `viaje_detenido`. */
export async function evaluarViajesEnRuta(client: PoolClient, tenantId: string) {
  const demorados = await viajesDemorados(client, tenantId);
  const detenidos = await viajesDetenidos(client, tenantId);
  await resolverAlertasDeViaje(
    client,
    tenantId,
    "viaje_demorado",
    demorados.map((d) => d.viaje_id)
  );
  await resolverAlertasDeViaje(
    client,
    tenantId,
    "viaje_detenido",
    detenidos.map((d) => d.viaje_id)
  );
  // Red de seguridad de «creado por el conductor»: si un viaje terminó por un camino que no cerró su
  // alerta al instante, aquí se cierra.
  await resolverViajesCreadosPorConductorTerminados(client, tenantId);
  const yaDemorados = await viajesConAlertaAbierta(
    client,
    tenantId,
    "viaje_demorado",
    demorados.map((d) => d.viaje_id)
  );
  const yaDetenidos = await viajesConAlertaAbierta(
    client,
    tenantId,
    "viaje_detenido",
    detenidos.map((d) => d.viaje_id)
  );
  // Lo leído arriba pudo quedar viejo: un viaje que se cerró o se anuló mientras tanto no abre alerta.
  // Se bloquean solo los candidatos a alerta nueva, no los que ya tienen una abierta.
  const candidatosDemorados = demorados.filter((d) => !yaDemorados.has(d.viaje_id));
  const candidatosDetenidos = detenidos.filter((d) => !yaDetenidos.has(d.viaje_id));
  const aunEnCurso = await viajesEnCurso(client, tenantId, [
    ...new Set([...candidatosDemorados, ...candidatosDetenidos].map((d) => d.viaje_id)),
  ]);
  const nuevosDemorados = candidatosDemorados.filter((d) => aunEnCurso.has(d.viaje_id));
  const nuevosDetenidos = candidatosDetenidos.filter((d) => aunEnCurso.has(d.viaje_id));
  const unidad = (v: { placa_codigo: string | null; codigo_interno: string | null }) =>
    v.placa_codigo ?? v.codigo_interno ?? null;
  await crearAlertasDeViaje(client, tenantId, [
    ...nuevosDemorados.map((d) => ({
      tipo: "viaje_demorado" as const,
      viajeId: d.viaje_id,
      detalle: {
        viajeNumero: d.numero,
        unidad: unidad(d),
        conductor: d.conductor_nombre,
        de: d.de,
        a: d.a,
        salidaEn: d.salida_en,
        marchaMin: d.marcha_min,
        esperadoMin: d.esperado_min,
        demoraMin: d.demora_min,
        viajesDeHistorial: d.esperado_viajes,
        baseDelHistorial: d.esperado_base,
      },
    })),
    ...nuevosDetenidos.map(alertaDeDetencion),
  ]);
  return { demorados: nuevosDemorados, detenidos: nuevosDetenidos };
}

// ── Lo que ve la Bandeja ───────────────────────────────────────────────────

/** El WHERE común del listado y de los contadores. Con alcance por grifo (Combustible), solo las de su
 *  grifo o sin grifo; sin Combustible no hay alcance y se ven todas. `incluirEstado` en false lo usa el
 *  resumen, que cuenta cada estado por separado. */
function condiciones(
  tenantId: string,
  filtros: FiltrosAlertasDeViaje,
  alcance: AlcanceCombustible,
  incluirEstado: boolean
) {
  const cond: string[] = ["a.tenant_id = $1"];
  const valores: unknown[] = [tenantId];
  const param = (v: unknown) => {
    valores.push(v);
    return `$${valores.length}`;
  };
  if (filtros.id !== undefined) cond.push(`a.id = ${param(filtros.id)}`);
  if (filtros.soloNoLeidas) cond.push("a.leida_en IS NULL");
  if (incluirEstado && filtros.estado === "sin_leer") cond.push("a.leida_en IS NULL");
  if (incluirEstado && filtros.estado === "pendientes") cond.push("a.resuelta_en IS NULL");
  if (incluirEstado && filtros.estado === "resueltas") cond.push("a.resuelta_en IS NOT NULL");
  // Estas alertas no se congelan: nunca hay congeladas.
  if (incluirEstado && filtros.estado === "congeladas") cond.push("FALSE");
  if (filtros.tipo !== undefined) cond.push(`a.tipo = ${param(filtros.tipo)}`);
  if (filtros.grifoInternoId !== undefined) {
    cond.push(`a.grifo_interno_id = ${param(filtros.grifoInternoId)}`);
  }
  // Días de LIMA, no de UTC: «hoy» para quien revisa es su día.
  if (filtros.desde !== undefined) {
    cond.push(
      `a.creado_en >= (${param(filtros.desde)}::date::timestamp AT TIME ZONE 'America/Lima')`
    );
  }
  if (filtros.hasta !== undefined) {
    cond.push(
      `a.creado_en < ((${param(filtros.hasta)}::date + 1)::timestamp AT TIME ZONE 'America/Lima')`
    );
  }
  if (filtros.texto !== undefined) {
    const patron = param(`%${filtros.texto.replace(/[\\%_]/g, "\\$&")}%`);
    cond.push(
      `(a.tipo ILIKE ${patron} OR a.detalle::text ILIKE ${patron} OR gi.nombre ILIKE ${patron})`
    );
  }
  if (!alcance.todo) {
    cond.push(
      `(a.grifo_interno_id IS NULL OR a.grifo_interno_id = ANY(${param(alcance.grifos)}::int[]))`
    );
  }
  return { cond, valores };
}

/** La lista de la Bandeja de Viajes. Mismas columnas que la de Combustible (lo que no aplica va en
 *  null) para que la misma pantalla sirva a las dos. */
export async function listarAlertasDeViaje(
  client: PoolClient,
  tenantId: string,
  filtros: FiltrosAlertasDeViaje,
  { pageSize, offset }: Paginacion,
  alcance: AlcanceCombustible
) {
  const { cond, valores } = condiciones(tenantId, filtros, alcance, true);
  valores.push(TIPOS_CRITICOS_DE_VIAJE, pageSize, offset);
  const n = valores.length;
  const r = await client.query(
    `SELECT a.id, a.tipo, NULL::text AS serie_talonario, NULL::int AS n_vale,
            NULL::int AS despacho_id, NULL::int AS combustible_id, NULL::int AS recepcion_id,
            NULL::bigint AS lectura_id, a.viaje_id, 'combustible'::text AS producto, a.detalle,
            a.creado_en, a.leida_en, a.resuelta_en, NULL::uuid AS resuelta_por,
            NULL::timestamptz AS congelada_en, a.grifo_interno_id,
            gi.nombre AS grifo_nombre, s.nombre AS sede_nombre,
            FALSE AS revisable, (a.tipo = ANY($${n - 2}::text[])) AS critica,
            COUNT(*) OVER() AS total_count
       FROM viaje_alertas a
       LEFT JOIN grifos_internos gi ON gi.id = a.grifo_interno_id AND gi.tenant_id = a.tenant_id
       LEFT JOIN sedes s ON s.id = gi.sede_id AND s.tenant_id = gi.tenant_id
      WHERE ${cond.join(" AND ")}
      ORDER BY a.creado_en DESC, a.id DESC
      LIMIT $${n - 1} OFFSET $${n}`,
    valores
  );
  return r.rows;
}

/** Los contadores de la Bandeja de Viajes: cuántas hay en cada estado, con los demás filtros
 *  aplicados. Mismos nombres que los de Combustible. */
export async function contarAlertasDeViaje(
  client: PoolClient,
  tenantId: string,
  filtros: FiltrosAlertasDeViaje,
  alcance: AlcanceCombustible
) {
  const { cond, valores } = condiciones(tenantId, filtros, alcance, false);
  valores.push(TIPOS_CRITICOS_DE_VIAJE);
  const r = await client.query<{
    sin_leer: string;
    pendientes: string;
    resueltas: string;
    criticas_pendientes: string;
    total: string;
  }>(
    `SELECT count(*) FILTER (WHERE a.leida_en IS NULL) AS sin_leer,
            count(*) FILTER (WHERE a.resuelta_en IS NULL) AS pendientes,
            count(*) FILTER (WHERE a.resuelta_en IS NOT NULL) AS resueltas,
            count(*) FILTER (WHERE a.resuelta_en IS NULL
                               AND a.tipo = ANY($${valores.length}::text[])) AS criticas_pendientes,
            count(*) AS total
       FROM viaje_alertas a
       LEFT JOIN grifos_internos gi ON gi.id = a.grifo_interno_id AND gi.tenant_id = a.tenant_id
      WHERE ${cond.join(" AND ")}`,
    valores
  );
  const f = r.rows[0];
  return {
    sinLeer: Number(f.sin_leer),
    pendientes: Number(f.pendientes),
    // Ninguna de estas alertas se revisa a mano ni se congela: se cierran solas.
    porRevisar: 0,
    resueltas: Number(f.resueltas),
    congeladas: 0,
    criticasPendientes: Number(f.criticas_pendientes),
    total: Number(f.total),
  };
}

/** Marca como leídas las alertas indicadas (o todas las no leídas EN EL ALCANCE de quien aprieta). La
 *  lectura es compartida, y por eso el alcance importa: una persona de una sede no apaga la alerta de
 *  otra que ni siquiera puede abrir. */
export async function marcarAlertasDeViajeLeidas(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible,
  ids?: number[]
) {
  const valores: unknown[] = [tenantId];
  const cond = ["tenant_id = $1", "leida_en IS NULL"];
  if (ids && ids.length > 0) {
    valores.push(ids);
    cond.push(`id = ANY($${valores.length}::bigint[])`);
  }
  if (!alcance.todo) {
    valores.push(alcance.grifos);
    cond.push(`(grifo_interno_id IS NULL OR grifo_interno_id = ANY($${valores.length}::int[]))`);
  }
  await client.query(
    `UPDATE viaje_alertas SET leida_en = now() WHERE ${cond.join(" AND ")}`,
    valores
  );
}

// ── Filtros de la query ────────────────────────────────────────────────────

function esDiaDeCalendario(fecha: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).toISOString().slice(0, 10) === fecha;
}

/** Los filtros de la Bandeja desde la query, con las mismas reglas que la de Combustible. Un valor
 *  malformado es 400 y no se ignora: un filtro descartado en silencio muestra «no hay alertas» cuando
 *  sí las hay, que es justo lo que no puede pasar en esta pantalla. */
export function filtrosAlertasDeViajeDe(
  q: Request["query"]
): FiltrosAlertasDeViaje | { error: string } {
  const texto = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const filtros: FiltrosAlertasDeViaje = { soloNoLeidas: q.solo_no_leidas === "true" };
  const estado = texto(q.estado);
  if (estado !== undefined) {
    if (!(ESTADOS_DE_ALERTA_DE_VIAJE as readonly string[]).includes(estado)) {
      return { error: "estado inválido" };
    }
    filtros.estado = estado as FiltrosAlertasDeViaje["estado"];
  }
  const id = texto(q.id);
  if (id !== undefined) {
    const n = Number(id);
    // Seguro y no solo entero: un 1e20 es «entero» para JS y desborda el BIGINT.
    if (!Number.isSafeInteger(n) || n <= 0) return { error: "id inválido" };
    filtros.id = n;
  }
  const tipo = texto(q.tipo);
  if (tipo !== undefined) {
    if (!/^[a-z_]{1,60}$/.test(tipo)) return { error: "tipo inválido" };
    filtros.tipo = tipo;
  }
  const grifo = texto(q.grifo_interno_id);
  if (grifo !== undefined) {
    const n = Number(grifo);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) {
      return { error: "grifo_interno_id inválido" };
    }
    filtros.grifoInternoId = n;
  }
  for (const campo of ["desde", "hasta"] as const) {
    const fecha = texto(q[campo]);
    if (fecha === undefined) continue;
    if (!esDiaDeCalendario(fecha)) return { error: `${campo} inválido (AAAA-MM-DD)` };
    filtros[campo] = fecha;
  }
  const buscar = texto(q.q);
  if (buscar !== undefined) filtros.texto = buscar.slice(0, 100);
  return filtros;
}
