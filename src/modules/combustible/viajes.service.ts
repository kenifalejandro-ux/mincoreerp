// Viajes (0123): A → B de una unidad. Las cargas del viaje se derivan de los
// despachos de esa unidad dentro de su ventana; ver la migración.
import type { PoolClient } from "pg";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { esViolacionUnicidad } from "../../server/shared/utils/pgError";
import type {
  CrearViajeInput,
  EditarViajeInput,
  ListarViajesQuery,
} from "../../server/schemas/combustible.schema";
import { agregarAmbitoVales, type AmbitoVales } from "./alcance";

export type Producto = "combustible" | "urea";

const LITROS_POR_GALON = 3.785411784;

// La carga en ruta desde una tanqueta (0114) no tiene tanque: mide en galones.
const LITROS_DE_D = `d.cantidad * CASE WHEN c.unidad = 'gal' OR d.tanqueta_origen_id IS NOT NULL
                                      THEN ${LITROS_POR_GALON} ELSE 1 END`;

/** Desde cuándo cuenta una carga para el viaje: el margen previo (la tanqueada
 *  antes de salir), pero nunca antes de que termine el viaje anterior de la
 *  misma unidad -- si no, la misma carga caería en dos viajes. */
const VENTANAS_SQL = `
  SELECT v.*,
         CASE WHEN v.inicio_en IS NULL THEN NULL ELSE GREATEST(
           v.inicio_en - make_interval(hours => $2::int),
           COALESCE((
             SELECT max(p.fin_en) FROM combustible_viajes p
              WHERE p.tenant_id = v.tenant_id AND p.equipo_id = v.equipo_id
                AND p.estado <> 'anulado' AND p.id <> v.id AND p.inicio_en < v.inicio_en
           ), '1900-01-01'::timestamptz)
         ) END AS ventana_desde,
         COALESCE(v.fin_en, now()) AS ventana_hasta
    FROM combustible_viajes v`;

async function margenPrevioHoras(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query(
    `SELECT viaje_margen_previo_horas FROM combustible_config WHERE tenant_id = $1`,
    [tenantId]
  );
  return r.rows[0]?.viaje_margen_previo_horas ?? 6;
}

// ── Lugares ────────────────────────────────────────────────────────────────

export async function listarLugares(client: PoolClient, tenantId: string) {
  const r = await client.query(
    `SELECT id, nombre, activo FROM combustible_lugares
      WHERE tenant_id = $1 ORDER BY lower(nombre)`,
    [tenantId]
  );
  return r.rows;
}

export async function crearLugar(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  nombre: string
) {
  try {
    const r = await client.query(
      `INSERT INTO combustible_lugares (tenant_id, nombre, creado_por)
       VALUES ($1, $2, $3) RETURNING id, nombre, activo`,
      [tenantId, nombre.trim(), usuarioId]
    );
    return r.rows[0];
  } catch (err) {
    if (esViolacionUnicidad(err)) throw new AppError(409, `El lugar "${nombre}" ya existe`);
    throw err;
  }
}

// ── Viajes ─────────────────────────────────────────────────────────────────

/** Serializa todo lo que toca los viajes de una unidad: sin esto, dos altas
 *  simultáneas pasan las dos el chequeo de traslape. */
async function bloquearUnidad(client: PoolClient, tenantId: string, equipoId: number) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `viaje:${tenantId}:${equipoId}`,
  ]);
}

async function validarLugares(client: PoolClient, tenantId: string, ids: number[]) {
  const r = await client.query(
    `SELECT id FROM combustible_lugares WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND activo`,
    [tenantId, ids]
  );
  if (r.rowCount !== new Set(ids).size) throw new AppError(400, "El origen o el destino no existe");
}

async function validarSinTraslape(
  client: PoolClient,
  tenantId: string,
  equipoId: number,
  inicio: string,
  fin: string | null,
  excluirId: number | null
) {
  const r = await client.query(
    `SELECT numero FROM combustible_viajes
      WHERE tenant_id = $1 AND equipo_id = $2 AND estado <> 'anulado'
        AND ($5::bigint IS NULL OR id <> $5)
        AND tstzrange(inicio_en, COALESCE(fin_en, 'infinity')) &&
            tstzrange($3::timestamptz, COALESCE($4::timestamptz, 'infinity'))
      LIMIT 1`,
    [tenantId, equipoId, inicio, fin, excluirId]
  );
  if (r.rows[0]) {
    throw new AppError(409, `La unidad ya está en el viaje V-${r.rows[0].numero} en esas fechas`);
  }
}

function validarMedidores(inicio: number | null | undefined, fin: number | null | undefined) {
  if (inicio != null && fin != null && fin < inicio) {
    throw new AppError(400, "El medidor de llegada no puede ser menor que el de salida");
  }
}

export async function crearViaje(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: CrearViajeInput
) {
  validarMedidores(data.medidor_inicio, data.medidor_fin);
  const equipo = await client.query(
    `SELECT id, conductor_nombre, conductor_dni FROM equipos WHERE tenant_id = $1 AND id = $2`,
    [tenantId, data.equipo_id]
  );
  if (!equipo.rows[0]) throw new AppError(404, "La unidad no existe");
  await validarLugares(client, tenantId, [data.origen_id, data.destino_id]);

  await bloquearUnidad(client, tenantId, data.equipo_id);
  if (data.inicio_en) {
    await validarSinTraslape(
      client,
      tenantId,
      data.equipo_id,
      data.inicio_en,
      data.fin_en ?? null,
      null
    );
  }

  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`viaje-numero:${tenantId}`]);
  const sig = await client.query(
    `SELECT COALESCE(max(numero), 0) + 1 AS n FROM combustible_viajes WHERE tenant_id = $1`,
    [tenantId]
  );

  // Sin conductor en el formulario, se copia el asignado a la unidad hoy.
  const conductorNombre =
    data.conductor_nombre !== undefined ? data.conductor_nombre : equipo.rows[0].conductor_nombre;
  const conductorDni =
    data.conductor_dni !== undefined ? data.conductor_dni : equipo.rows[0].conductor_dni;
  const estado = !data.inicio_en ? "programado" : data.fin_en ? "cerrado" : "en_curso";

  const r = await client.query(
    `INSERT INTO combustible_viajes (
       tenant_id, numero, equipo_id, conductor_nombre, conductor_dni, origen_id, destino_id,
       inicio_en, fin_en, medidor_inicio, medidor_fin, cuenta_como, estado, observaciones,
       creado_por, cerrado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      tenantId,
      sig.rows[0].n,
      data.equipo_id,
      conductorNombre || null,
      conductorDni || null,
      data.origen_id,
      data.destino_id,
      data.inicio_en ?? null,
      data.fin_en ?? null,
      data.medidor_inicio ?? null,
      data.medidor_fin ?? null,
      data.cuenta_como,
      estado,
      data.observaciones || null,
      usuarioId,
      estado === "cerrado" ? usuarioId : null,
    ]
  );
  return getViaje(client, tenantId, r.rows[0].id);
}

async function viajeParaCambiar(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT * FROM combustible_viajes WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  const v = r.rows[0];
  if (!v) throw new AppError(404, "El viaje no existe");
  await bloquearUnidad(client, tenantId, v.equipo_id);
  // Releer bajo el candado: otro request pudo cambiarlo mientras esperaba.
  const fresco = await client.query(`SELECT * FROM combustible_viajes WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  if (fresco.rows[0].estado === "anulado") throw new AppError(409, "El viaje está anulado");
  return fresco.rows[0];
}

async function ahora(client: PoolClient): Promise<string> {
  const r = await client.query(`SELECT now() AS t`);
  return new Date(r.rows[0].t).toISOString();
}

// Un reloj de celular algo corrido no convierte una marca en línea en una
// "sin señal"; más de esto sí.
const TOLERANCIA_RELOJ_MS = 5 * 60_000;
// Una marca encolada que llega después de una semana ya no se puede creer.
const MAX_ATRASO_COLA_MS = 7 * 24 * 3_600_000;

export type OrigenHora = "servidor" | "manual" | "dispositivo";

/** Qué hora vale para una marca de salida o llegada. `manual` es la oficina
 *  corrigiendo un olvido (con motivo). `marcadoEn` es la hora del celular: solo
 *  vale si la marca llegó TARDE (estuvo en la cola sin señal); si llegó en el
 *  momento, manda el reloj del servidor. */
async function horaDeLaMarca(
  client: PoolClient,
  manual: string | undefined,
  marcadoEn: string | undefined
): Promise<{ hora: string; origen: OrigenHora }> {
  if (manual) return { hora: manual, origen: "manual" };
  const servidor = await ahora(client);
  if (marcadoEn) {
    const atraso = Date.parse(servidor) - Date.parse(marcadoEn);
    if (atraso < -TOLERANCIA_RELOJ_MS) {
      throw new AppError(
        400,
        "La hora del celular está adelantada: revisa la fecha y hora del equipo"
      );
    }
    if (atraso > MAX_ATRASO_COLA_MS) {
      throw new AppError(400, "La marca tiene más de 7 días: pide a la oficina que la registre");
    }
    if (atraso > TOLERANCIA_RELOJ_MS) return { hora: marcadoEn, origen: "dispositivo" };
  }
  return { hora: servidor, origen: "servidor" };
}

const normalizarDni = (dni: unknown) => String(dni ?? "").trim();

/** El conductor solo marca SUS viajes. 404 y no 403: no confirma que exista. */
function exigirConductor(v: { conductor_dni: string | null }, dni: string | undefined) {
  if (dni === undefined) return;
  if (!normalizarDni(dni) || normalizarDni(v.conductor_dni) !== normalizarDni(dni)) {
    throw new AppError(404, "El viaje no existe");
  }
}

export interface MarcaInicio {
  medidor_inicio?: number | null;
  inicio_en?: string;
  marcado_en?: string;
  cliente_uuid?: string;
  ruta_por_confirmar?: boolean;
  nota_ruta?: string | null;
}

export interface MarcaFin {
  medidor_fin?: number | null;
  fin_en?: string;
  marcado_en?: string;
  cliente_uuid?: string;
}

/** La lectura con que la unidad llegó del viaje anterior; si ese viaje no la
 *  tiene, la de su última carga. Es lo que el conductor ve colapsado antes de
 *  escribir lo que marca su tablero. */
export async function medidorPrevio(
  client: PoolClient,
  tenantId: string,
  equipoId: number,
  hasta?: string
) {
  const eq = await client.query(
    `SELECT tipo_medidor FROM equipos WHERE tenant_id = $1 AND id = $2`,
    [tenantId, equipoId]
  );
  if (!eq.rows[0]) throw new AppError(404, "La unidad no existe");
  const tipo: "horometro" | "odometro" | null = eq.rows[0].tipo_medidor;
  if (!tipo) return { tipo_medidor: null, valor: null, fuente: null };
  const col = tipo === "horometro" ? "lectura_horometro" : "lectura_odometro";
  const limite = hasta ?? (await ahora(client));
  const viaje = await client.query(
    `SELECT medidor_fin AS m, fin_en AS t FROM combustible_viajes
      WHERE tenant_id = $1 AND equipo_id = $2 AND estado = 'cerrado'
        AND medidor_fin IS NOT NULL AND fin_en <= $3
      ORDER BY fin_en DESC LIMIT 1`,
    [tenantId, equipoId, limite]
  );
  const carga = await client.query(
    `SELECT ${col} AS m, despachado_en AS t FROM combustible_despachos
      WHERE tenant_id = $1 AND equipo_id = $2 AND anulada_en IS NULL
        AND ${col} IS NOT NULL AND despachado_en <= $3
      ORDER BY despachado_en DESC, id DESC LIMIT 1`,
    [tenantId, equipoId, limite]
  );
  const a = viaje.rows[0];
  const b = carga.rows[0];
  const gana = a && (!b || new Date(a.t) >= new Date(b.t)) ? a : b;
  return {
    tipo_medidor: tipo,
    valor: gana ? Number(gana.m) : null,
    fuente: gana ? (gana === a ? "viaje" : "carga") : null,
  };
}

export async function iniciarViaje(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  data: MarcaInicio,
  /** Presente cuando marca el propio conductor: solo su viaje. */
  dniConductor?: string
) {
  const v = await viajeParaCambiar(client, tenantId, id);
  exigirConductor(v, dniConductor);
  // Reintento de la cola: la marca ya entró, se devuelve como quedó.
  if (data.cliente_uuid && v.inicio_cliente_uuid === data.cliente_uuid) {
    return { antes: v, despues: await getViaje(client, tenantId, id), repetido: true };
  }
  if (v.estado !== "programado") throw new AppError(409, "El viaje ya salió");
  const { hora: inicio, origen } = await horaDeLaMarca(client, data.inicio_en, data.marcado_en);
  const previo = await medidorPrevio(client, tenantId, v.equipo_id, inicio);
  if (previo.tipo_medidor && data.medidor_inicio == null) {
    throw new AppError(
      400,
      `Falta el ${previo.tipo_medidor === "horometro" ? "horómetro" : "odómetro"} de salida`
    );
  }
  if (previo.valor !== null && data.medidor_inicio != null && data.medidor_inicio < previo.valor) {
    throw new AppError(
      400,
      `El medidor de salida (${data.medidor_inicio}) es menor que el último registrado (${previo.valor})`
    );
  }
  await validarSinTraslape(client, tenantId, v.equipo_id, inicio, null, id);
  await client.query(
    `UPDATE combustible_viajes
        SET inicio_en = $2, medidor_previo = $3, medidor_inicio = $4, estado = 'en_curso',
            iniciado_por = $5, ruta_por_confirmar = $6, nota_ruta = $7,
            inicio_origen_hora = $8, inicio_cliente_uuid = $9
      WHERE id = $1`,
    [
      id,
      inicio,
      previo.valor,
      data.medidor_inicio ?? null,
      usuarioId,
      data.ruta_por_confirmar ?? false,
      data.nota_ruta || null,
      origen,
      data.cliente_uuid ?? null,
    ]
  );
  return { antes: v, despues: await getViaje(client, tenantId, id), repetido: false };
}

export async function cerrarViaje(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  data: MarcaFin,
  dniConductor?: string
) {
  const v = await viajeParaCambiar(client, tenantId, id);
  exigirConductor(v, dniConductor);
  if (data.cliente_uuid && v.fin_cliente_uuid === data.cliente_uuid) {
    const despues = await getViaje(client, tenantId, id);
    return { antes: v, despues, fin: despues.fin_en, repetido: true };
  }
  if (v.estado === "programado") throw new AppError(409, "El viaje todavía no salió");
  if (v.estado !== "en_curso") throw new AppError(409, "El viaje ya está cerrado");
  const { hora: fin, origen } = await horaDeLaMarca(client, data.fin_en, data.marcado_en);
  if (Date.parse(fin) <= new Date(v.inicio_en).getTime()) {
    throw new AppError(400, "La llegada tiene que ser posterior a la salida");
  }
  if (v.medidor_inicio != null && data.medidor_fin == null) {
    throw new AppError(400, "Falta el medidor de llegada");
  }
  validarMedidores(v.medidor_inicio == null ? null : Number(v.medidor_inicio), data.medidor_fin);
  await validarSinTraslape(client, tenantId, v.equipo_id, v.inicio_en, fin, id);
  await client.query(
    `UPDATE combustible_viajes
        SET fin_en = $2, medidor_fin = $3, estado = 'cerrado', cerrado_por = $4,
            fin_origen_hora = $5, fin_cliente_uuid = $6
      WHERE id = $1`,
    [id, fin, data.medidor_fin ?? null, usuarioId, origen, data.cliente_uuid ?? null]
  );
  return { antes: v, despues: await getViaje(client, tenantId, id), fin, repetido: false };
}

export async function editarViaje(
  client: PoolClient,
  tenantId: string,
  id: number,
  data: EditarViajeInput
) {
  // Con cambio de unidad se toman los dos candados en orden ascendente: dos
  // correcciones cruzadas (A→B y B→A) no se esperan una a la otra.
  const previo = await client.query(
    `SELECT equipo_id FROM combustible_viajes WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  if (!previo.rows[0]) throw new AppError(404, "El viaje no existe");
  const unidades = [previo.rows[0].equipo_id as number];
  if (data.equipo_id !== undefined && data.equipo_id !== unidades[0]) unidades.push(data.equipo_id);
  for (const u of unidades.sort((a, b) => a - b)) await bloquearUnidad(client, tenantId, u);

  const v = await viajeParaCambiar(client, tenantId, id);
  const def = <T>(nuevo: T | undefined, actual: T) => (nuevo === undefined ? actual : nuevo);
  const iso = (x: unknown) => (x ? new Date(x as string).toISOString() : null);
  const equipo = def(data.equipo_id, Number(v.equipo_id));
  const inicio = def(data.inicio_en, iso(v.inicio_en));
  const fin = def(data.fin_en, iso(v.fin_en));
  const origen = def(data.origen_id, Number(v.origen_id));
  const destino = def(data.destino_id, Number(v.destino_id));
  const medIni = def(
    data.medidor_inicio,
    v.medidor_inicio == null ? null : Number(v.medidor_inicio)
  );
  const medFin = def(data.medidor_fin, v.medidor_fin == null ? null : Number(v.medidor_fin));

  if (v.estado === "programado") {
    if (
      data.inicio_en !== undefined ||
      data.fin_en !== undefined ||
      data.medidor_inicio !== undefined ||
      data.medidor_fin !== undefined
    ) {
      throw new AppError(
        400,
        "Un viaje programado no tiene salida ni medidores: se cargan al iniciarlo"
      );
    }
  } else {
    if (!inicio) throw new AppError(400, "El viaje tiene que tener hora de salida");
    if (fin && Date.parse(fin) <= Date.parse(inicio)) {
      throw new AppError(400, "La llegada tiene que ser posterior a la salida");
    }
    // Un viaje cerrado no vuelve a "en curso" editándolo: borrar la llegada
    // reabriría un viaje que ya se reportó.
    if (v.estado === "cerrado" && !fin) {
      throw new AppError(400, "Un viaje cerrado tiene que tener hora de llegada");
    }
    validarMedidores(medIni, medFin);
  }
  if (origen === destino)
    throw new AppError(400, "El origen y el destino tienen que ser distintos");
  if (data.origen_id !== undefined || data.destino_id !== undefined) {
    await validarLugares(client, tenantId, [origen, destino]);
  }
  if (equipo !== Number(v.equipo_id)) {
    const e = await client.query(`SELECT 1 FROM equipos WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      equipo,
    ]);
    if (!e.rows[0]) throw new AppError(404, "La unidad no existe");
  }
  if (v.estado !== "programado") {
    await validarSinTraslape(client, tenantId, equipo, inicio!, fin, id);
  }
  // Cambiar la ruta o la unidad es justamente confirmarla, salvo que se diga
  // lo contrario.
  const cambioRuta =
    origen !== Number(v.origen_id) ||
    destino !== Number(v.destino_id) ||
    equipo !== Number(v.equipo_id);
  const rutaPorConfirmar = def(data.ruta_por_confirmar, cambioRuta ? false : v.ruta_por_confirmar);

  await client.query(
    `UPDATE combustible_viajes
        SET equipo_id = $12, conductor_nombre = $2, conductor_dni = $3, origen_id = $4,
            destino_id = $5, inicio_en = $6, fin_en = $7, medidor_inicio = $8, medidor_fin = $9,
            cuenta_como = $10, observaciones = $11, ruta_por_confirmar = $13,
            estado = CASE WHEN estado = 'programado' THEN 'programado'
                          WHEN $7::timestamptz IS NULL THEN 'en_curso' ELSE 'cerrado' END
      WHERE id = $1`,
    [
      id,
      def(data.conductor_nombre, v.conductor_nombre) || null,
      def(data.conductor_dni, v.conductor_dni) || null,
      origen,
      destino,
      inicio,
      fin,
      medIni,
      medFin,
      def(data.cuenta_como, Number(v.cuenta_como)),
      def(data.observaciones, v.observaciones) || null,
      equipo,
      rutaPorConfirmar,
    ]
  );
  return { antes: v, despues: await getViaje(client, tenantId, id) };
}

export async function anularViaje(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  motivo: string
) {
  const v = await viajeParaCambiar(client, tenantId, id);
  await client.query(
    `UPDATE combustible_viajes
        SET estado = 'anulado', motivo_anulacion = $2, anulado_por = $3, anulado_en = now()
      WHERE id = $1`,
    [id, motivo, usuarioId]
  );
  return v;
}

// ── Consultas ──────────────────────────────────────────────────────────────

const COLUMNAS_VIAJE = `
  v.id, v.numero, v.equipo_id, e.placa_codigo, e.codigo_interno, e.tipo AS equipo_tipo,
  e.tipo_medidor, v.conductor_nombre, v.conductor_dni,
  v.origen_id, lo.nombre AS origen, v.destino_id, ld.nombre AS destino,
  v.inicio_en, v.fin_en, v.medidor_previo, v.medidor_inicio, v.medidor_fin,
  v.medidor_fin - v.medidor_inicio AS recorrido,
  v.medidor_inicio - v.medidor_previo AS recorrido_sin_viaje,
  v.ruta_por_confirmar, v.nota_ruta, v.inicio_origen_hora, v.fin_origen_hora,
  v.cuenta_como, v.estado, v.observaciones, v.motivo_anulacion,
  v.ventana_desde, v.ventana_hasta`;

const JOINS_VIAJE = `
  JOIN equipos e ON e.id = v.equipo_id AND e.tenant_id = v.tenant_id
  JOIN combustible_lugares lo ON lo.id = v.origen_id AND lo.tenant_id = v.tenant_id
  JOIN combustible_lugares ld ON ld.id = v.destino_id AND ld.tenant_id = v.tenant_id`;

/** Lista de viajes con lo que se cargó en cada uno (del producto pedido) y
 *  cuánto se aparta del promedio de su ruta. La cantidad sale en la unidad del
 *  producto: galones para combustible, litros para urea. */
export async function listarViajes(
  client: PoolClient,
  tenantId: string,
  q: ListarViajesQuery,
  ambito?: AmbitoVales
) {
  const margen = await margenPrevioHoras(client, tenantId);
  const valores: unknown[] = [tenantId, margen, q.producto];
  const cond: string[] = ["v.tenant_id = $1"];
  if (q.estado) {
    valores.push(q.estado);
    cond.push(`v.estado = $${valores.length}`);
  } else {
    cond.push(`v.estado <> 'anulado'`);
  }
  if (q.equipo_id) {
    valores.push(q.equipo_id);
    cond.push(`v.equipo_id = $${valores.length}`);
  }
  if (q.desde) {
    valores.push(q.desde);
    cond.push(`(v.inicio_en IS NULL OR v.inicio_en >= $${valores.length}::timestamptz)`);
  }
  if (q.hasta) {
    valores.push(q.hasta);
    cond.push(`(v.inicio_en IS NULL OR v.inicio_en <= $${valores.length}::timestamptz)`);
  }
  const condCargas: string[] = [
    "d.tenant_id = v.tenant_id",
    "d.equipo_id = v.equipo_id",
    "d.producto = $3",
    "d.anulada_en IS NULL",
    "d.despachado_en > v.ventana_desde",
    "d.despachado_en <= v.ventana_hasta",
  ];
  agregarAmbitoVales(condCargas, valores, "d", ambito);
  const divisor = q.producto === "combustible" ? LITROS_POR_GALON : 1;

  const r = await client.query(
    `
    WITH v AS (${VENTANAS_SQL} WHERE v.tenant_id = $1),
    base AS (
      SELECT ${COLUMNAS_VIAJE},
             COALESCE(cg.cargas, 0) AS cargas,
             COALESCE(cg.litros, 0) / ${divisor} AS cantidad
        FROM v ${JOINS_VIAJE}
        LEFT JOIN LATERAL (
          SELECT count(*) AS cargas, SUM(${LITROS_DE_D}) AS litros
            FROM combustible_despachos d
            LEFT JOIN combustible c
              ON c.id = COALESCE(d.combustible_id, d.tanque_excedente_id) AND c.tenant_id = d.tenant_id
           WHERE ${condCargas.join(" AND ")}
        ) cg ON true
       WHERE ${cond.join(" AND ")}
    )
    SELECT b.*,
           b.cantidad / b.cuenta_como AS cantidad_por_viaje,
           -- Promedio por viaje de la MISMA unidad en la MISMA ruta (solo
           -- viajes cerrados: uno en curso todavía no terminó de cargar).
           AVG(b.cantidad / b.cuenta_como) FILTER (WHERE b.estado = 'cerrado' AND NOT b.ruta_por_confirmar)
             OVER (PARTITION BY b.origen_id, b.destino_id, b.equipo_id) AS promedio_ruta_unidad,
           COUNT(*) FILTER (WHERE b.estado = 'cerrado' AND NOT b.ruta_por_confirmar)
             OVER (PARTITION BY b.origen_id, b.destino_id, b.equipo_id) AS viajes_ruta_unidad,
           AVG(b.cantidad / b.cuenta_como) FILTER (WHERE b.estado = 'cerrado' AND NOT b.ruta_por_confirmar)
             OVER (PARTITION BY b.origen_id, b.destino_id) AS promedio_ruta,
           COUNT(*) FILTER (WHERE b.estado = 'cerrado' AND NOT b.ruta_por_confirmar)
             OVER (PARTITION BY b.origen_id, b.destino_id) AS viajes_ruta
      FROM base b
     ORDER BY b.inicio_en DESC NULLS FIRST
    `,
    valores
  );
  return r.rows;
}

export async function getViaje(client: PoolClient, tenantId: string, id: number) {
  const margen = await margenPrevioHoras(client, tenantId);
  const r = await client.query(
    `WITH v AS (${VENTANAS_SQL} WHERE v.tenant_id = $1 AND v.id = $3)
     SELECT ${COLUMNAS_VIAJE} FROM v ${JOINS_VIAJE}`,
    [tenantId, margen, id]
  );
  return r.rows[0] ?? null;
}

/** Las cargas del viaje, de los dos productos, una por una. */
export async function cargasDelViaje(
  client: PoolClient,
  tenantId: string,
  id: number,
  ambito?: AmbitoVales
) {
  const viaje = await getViaje(client, tenantId, id);
  if (!viaje) return null;
  const ruta = await estadisticasRuta(
    client,
    tenantId,
    Number(viaje.origen_id),
    Number(viaje.destino_id),
    Number(viaje.id)
  );
  if (!viaje.inicio_en) return { viaje, cargas: [], ruta };
  const valores: unknown[] = [tenantId, viaje.equipo_id, viaje.ventana_desde, viaje.ventana_hasta];
  const cond = [
    "d.tenant_id = $1",
    "d.equipo_id = $2",
    "d.anulada_en IS NULL",
    "d.despachado_en > $3",
    "d.despachado_en <= $4",
  ];
  agregarAmbitoVales(cond, valores, "d", ambito);
  const r = await client.query(
    `SELECT d.id, d.producto, d.origen, d.despachado_en, d.cantidad,
            CASE WHEN c.unidad = 'gal' OR d.tanqueta_origen_id IS NOT NULL THEN 'gal'
                 WHEN d.producto = 'urea' THEN 'L' ELSE COALESCE(c.unidad, 'L') END AS unidad,
            ${LITROS_DE_D} AS litros,
            d.serie_talonario, d.n_vale, d.conductor_nombre,
            d.lectura_horometro, d.lectura_odometro,
            c.tanque_nombre, g.nombre AS grifo
       FROM combustible_despachos d
       LEFT JOIN combustible c
         ON c.id = COALESCE(d.combustible_id, d.tanque_excedente_id) AND c.tenant_id = d.tenant_id
       LEFT JOIN combustible_grifos g ON g.id = d.grifo_id AND g.tenant_id = d.tenant_id
      WHERE ${cond.join(" AND ")}
      ORDER BY d.despachado_en`,
    valores
  );
  return { viaje, cargas: r.rows, ruta };
}

/** Cuánto suele durar y consumir esta ruta: los últimos 20 viajes cerrados y
 *  confirmados (sin el propio). Da la llegada estimada de un viaje en curso y
 *  la comparación de uno cerrado. */
export async function estadisticasRuta(
  client: PoolClient,
  tenantId: string,
  origenId: number,
  destinoId: number,
  excluirId: number
) {
  const margen = await margenPrevioHoras(client, tenantId);
  const r = await client.query(
    `WITH v AS (${VENTANAS_SQL}
       WHERE v.tenant_id = $1 AND v.origen_id = $3 AND v.destino_id = $4 AND v.id <> $5
         AND v.estado = 'cerrado' AND NOT v.ruta_por_confirmar
       ORDER BY v.fin_en DESC LIMIT 20)
     SELECT count(*)::int AS viajes,
            avg(extract(epoch FROM v.fin_en - v.inicio_en) / 60) AS duracion_min,
            avg(COALESCE(cg.combustible_l, 0) / ${LITROS_POR_GALON} / v.cuenta_como) AS combustible_gal,
            avg(COALESCE(cg.urea_l, 0) / v.cuenta_como) AS urea_l
       FROM v
       LEFT JOIN LATERAL (
         SELECT SUM(${LITROS_DE_D}) FILTER (WHERE d.producto = 'combustible') AS combustible_l,
                SUM(${LITROS_DE_D}) FILTER (WHERE d.producto = 'urea') AS urea_l
           FROM combustible_despachos d
           LEFT JOIN combustible c
             ON c.id = COALESCE(d.combustible_id, d.tanque_excedente_id) AND c.tenant_id = d.tenant_id
          WHERE d.tenant_id = v.tenant_id AND d.equipo_id = v.equipo_id AND d.anulada_en IS NULL
            AND d.despachado_en > v.ventana_desde AND d.despachado_en <= v.ventana_hasta
       ) cg ON true`,
    [tenantId, margen, origenId, destinoId, excluirId]
  );
  const f = r.rows[0];
  const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  return {
    viajes: Number(f?.viajes ?? 0),
    duracion_min: num(f?.duracion_min),
    combustible_gal: num(f?.combustible_gal),
    urea_l: num(f?.urea_l),
  };
}

// ── El conductor ───────────────────────────────────────────────────────────

/** Lo que ve el conductor: sus viajes programados y en curso, y el último que
 *  cerró, con lo cargado de cada producto. Los programados traen el medidor
 *  previo para mostrarlo bloqueado. */
export async function viajesDelConductor(client: PoolClient, tenantId: string, dni: string) {
  const d = normalizarDni(dni);
  if (!d) return [];
  const margen = await margenPrevioHoras(client, tenantId);
  const r = await client.query(
    `WITH v AS (${VENTANAS_SQL}
       WHERE v.tenant_id = $1 AND trim(v.conductor_dni) = $3
         AND (v.estado IN ('programado', 'en_curso') OR v.id = (
           SELECT u.id FROM combustible_viajes u
            WHERE u.tenant_id = $1 AND trim(u.conductor_dni) = $3 AND u.estado = 'cerrado'
            ORDER BY u.fin_en DESC LIMIT 1)))
     SELECT ${COLUMNAS_VIAJE},
            COALESCE(cg.cargas, 0) AS cargas,
            COALESCE(cg.combustible_l, 0) / ${LITROS_POR_GALON} AS combustible_gal,
            COALESCE(cg.urea_l, 0) AS urea_l
       FROM v ${JOINS_VIAJE}
       LEFT JOIN LATERAL (
         SELECT count(*) AS cargas,
                SUM(${LITROS_DE_D}) FILTER (WHERE d.producto = 'combustible') AS combustible_l,
                SUM(${LITROS_DE_D}) FILTER (WHERE d.producto = 'urea') AS urea_l
           FROM combustible_despachos d
           LEFT JOIN combustible c
             ON c.id = COALESCE(d.combustible_id, d.tanque_excedente_id) AND c.tenant_id = d.tenant_id
          WHERE d.tenant_id = v.tenant_id AND d.equipo_id = v.equipo_id AND d.anulada_en IS NULL
            AND d.despachado_en > v.ventana_desde AND d.despachado_en <= v.ventana_hasta
       ) cg ON true
      ORDER BY CASE v.estado WHEN 'en_curso' THEN 0 WHEN 'programado' THEN 1 ELSE 2 END,
               v.creado_en`,
    [tenantId, margen, d]
  );
  const filas = [];
  for (const fila of r.rows) {
    // Sus cargas y cuánto suele tardar la ruta (solo para estimar la llegada):
    // nada de promedios de consumo ni comparaciones con otros conductores.
    const detalle =
      fila.inicio_en && fila.estado !== "programado"
        ? await cargasDelViaje(client, tenantId, Number(fila.id))
        : null;
    const ruta =
      fila.estado === "programado" || fila.estado === "en_curso"
        ? await estadisticasRuta(
            client,
            tenantId,
            Number(fila.origen_id),
            Number(fila.destino_id),
            Number(fila.id)
          )
        : null;
    filas.push({
      ...fila,
      previo:
        fila.estado === "programado" ? await medidorPrevio(client, tenantId, fila.equipo_id) : null,
      cargas_detalle: detalle?.cargas ?? [],
      duracion_ruta_min: ruta?.duracion_min ?? null,
    });
  }
  return filas;
}

/** Los perfiles de conductor con DNI, para elegirlos al programar: el viaje le
 *  aparece al conductor por su DNI, así que tipearlo a mano es el punto débil. */
export async function listarConductores(client: PoolClient, tenantId: string) {
  const r = await client.query(
    `SELECT id, nombre, dni FROM usuarios
      WHERE tenant_id = $1 AND rol = 'conductor_ruta' AND activo AND dni IS NOT NULL
      ORDER BY lower(nombre)`,
    [tenantId]
  );
  return r.rows;
}
