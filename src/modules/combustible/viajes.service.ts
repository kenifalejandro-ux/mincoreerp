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
import { repartirPorTramo } from "./viajesTramos";
import { LITROS_POR_GALON } from "../../server/shared/utils/unidades";

export type Producto = "combustible" | "urea";

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
  if (r.rowCount !== new Set(ids).size) {
    throw new AppError(400, "Algún lugar del recorrido no existe");
  }
}

/** Copia las marcas de los extremos del viaje a sus paradas: la salida de la
 *  parada 0 y la llegada de la última son `inicio_en`/`medidor_inicio` y
 *  `fin_en`/`medidor_fin`. Se llama después de cada cambio del viaje, así
 *  ninguna vía (marcar, cerrar, corregir) deja las dos tablas contradiciéndose.
 *  Las dos primeras paradas también siguen a `origen_id`/`destino_id`: es la
 *  "ida" del viaje (ver la migración 0148). */
async function sincronizarExtremos(client: PoolClient, tenantId: string, viajeId: number) {
  await client.query(
    `UPDATE combustible_viaje_paradas p
        SET lugar_id = CASE p.orden WHEN 0 THEN v.origen_id WHEN 1 THEN v.destino_id
                                    ELSE p.lugar_id END,
            salida_en = CASE WHEN p.orden = 0 THEN v.inicio_en ELSE p.salida_en END,
            salida_medidor = CASE WHEN p.orden = 0 THEN v.medidor_inicio ELSE p.salida_medidor END
       FROM combustible_viajes v
      WHERE v.tenant_id = p.tenant_id AND v.id = p.viaje_id
        AND p.tenant_id = $1 AND p.viaje_id = $2 AND p.orden <= 1`,
    [tenantId, viajeId]
  );
  // El primer turno sigue a la salida del viaje y el último, a su llegada.
  await client.query(
    `UPDATE combustible_viaje_turnos t SET inicio_en = v.inicio_en, medidor_inicio = v.medidor_inicio
       FROM combustible_viajes v
      WHERE v.tenant_id = t.tenant_id AND v.id = t.viaje_id AND t.tenant_id = $1 AND t.viaje_id = $2
        AND v.inicio_en IS NOT NULL
        AND t.id = (SELECT id FROM combustible_viaje_turnos WHERE tenant_id = $1 AND viaje_id = $2
                     ORDER BY inicio_en LIMIT 1)`,
    [tenantId, viajeId]
  );
  await client.query(
    `UPDATE combustible_viaje_turnos t SET fin_en = v.fin_en, medidor_fin = v.medidor_fin
       FROM combustible_viajes v
      WHERE v.tenant_id = t.tenant_id AND v.id = t.viaje_id AND t.tenant_id = $1 AND t.viaje_id = $2
        AND v.estado = 'cerrado' AND v.fin_en IS NOT NULL
        AND t.id = (SELECT id FROM combustible_viaje_turnos WHERE tenant_id = $1 AND viaje_id = $2
                     ORDER BY inicio_en DESC LIMIT 1)`,
    [tenantId, viajeId]
  );
  await client.query(
    `UPDATE combustible_viaje_paradas p
        SET llegada_en = v.fin_en, llegada_medidor = v.medidor_fin
       FROM combustible_viajes v
      WHERE v.tenant_id = p.tenant_id AND v.id = p.viaje_id
        AND p.tenant_id = $1 AND p.viaje_id = $2
        AND p.orden = (SELECT max(orden) FROM combustible_viaje_paradas
                        WHERE tenant_id = $1 AND viaje_id = $2)`,
    [tenantId, viajeId]
  );
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
        AND inicio_en IS NOT NULL
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

interface TurnoNuevo {
  dni: string;
  nombre: string | null;
  inicio: string;
  medidor: number | null;
  lugarId: number | string;
  fin?: string | null;
  medidorFin?: number | null;
}

/** Abre un turno de conducción (con su fin si el viaje ya cerró). */
async function abrirTurno(client: PoolClient, tenantId: string, viajeId: number, t: TurnoNuevo) {
  await client.query(
    `INSERT INTO combustible_viaje_turnos (
       tenant_id, viaje_id, conductor_dni, conductor_nombre, inicio_en, medidor_inicio, fin_en,
       medidor_fin, lugar)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
             (SELECT nombre FROM combustible_lugares WHERE tenant_id = $1 AND id = $9))`,
    [
      tenantId,
      viajeId,
      t.dni,
      t.nombre,
      t.inicio,
      t.medidor,
      t.fin ?? null,
      t.medidorFin ?? null,
      t.lugarId,
    ]
  );
}

/** Nadie va al volante de dos viajes en curso a la vez. El candado es por persona: dos viajes de
 *  unidades distintas no comparten el de la unidad. */
async function exigirLibreParaManejar(
  client: PoolClient,
  tenantId: string,
  dni: string,
  excluirViajeId: number
) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `viaje-conductor:${tenantId}:${dni}`,
  ]);
  const r = await client.query(
    `SELECT v.numero FROM combustible_viaje_turnos t
       JOIN combustible_viajes v ON v.id = t.viaje_id AND v.tenant_id = t.tenant_id
      WHERE t.tenant_id = $1 AND t.fin_en IS NULL AND t.conductor_dni = $2
        AND v.estado = 'en_curso' AND v.id <> $3 LIMIT 1`,
    [tenantId, dni, excluirViajeId]
  );
  if (r.rows[0]) {
    throw new AppError(409, `Ya va al volante del viaje V-${r.rows[0].numero}: termínalo antes`);
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
  // Sin `paradas`, el viaje es origen → destino. Con ellas, la "ida" son las dos primeras.
  const paradas = data.paradas ?? [data.origen_id!, data.destino_id!];
  if (paradas.length > 2 && data.fin_en) {
    throw new AppError(
      400,
      "Un viaje con varias paradas no se registra ya terminado: se marca parada por parada"
    );
  }
  await validarLugares(client, tenantId, paradas);

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
  // El conductor se identifica por su DNI ("Mi viaje" lo busca por ahí): un
  // viaje sin él no lo ve nadie y no se puede iniciar. Mejor frenarlo al
  // programarlo que descubrirlo cuando el conductor no encuentra su viaje.
  if (!String(conductorDni ?? "").trim()) {
    throw new AppError(
      400,
      "La unidad no tiene conductor asignado: asígnalo en Equipos antes de programar el viaje"
    );
  }
  const estado = !data.inicio_en ? "programado" : data.fin_en ? "cerrado" : "en_curso";

  // El relevo se elige al programar: otra persona, conductor activo con DNI de esta empresa.
  const dniRelevo = normalizarDni(data.relevo_dni);
  const sale = data.sale ?? "titular";
  let nombreRelevo: string | null = null;
  if (dniRelevo) {
    if (dniRelevo === normalizarDni(conductorDni)) {
      throw new AppError(400, "El relevo tiene que ser otra persona que el titular");
    }
    const u = await client.query(
      `SELECT nombre FROM usuarios
        WHERE tenant_id = $1 AND rol = 'conductor_ruta' AND activo AND dni = $2`,
      [tenantId, dniRelevo]
    );
    if (!u.rows[0]) throw new AppError(400, "El relevo tiene que ser un conductor activo con DNI");
    nombreRelevo = u.rows[0].nombre;
  }

  const r = await client.query(
    `INSERT INTO combustible_viajes (
       tenant_id, numero, equipo_id, conductor_nombre, conductor_dni, origen_id, destino_id,
       inicio_en, fin_en, medidor_inicio, medidor_fin, estado, observaciones,
       creado_por, cerrado_por, relevo_dni, relevo_nombre, sale_primero)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      tenantId,
      sig.rows[0].n,
      data.equipo_id,
      conductorNombre || null,
      conductorDni || null,
      paradas[0],
      paradas[1],
      data.inicio_en ?? null,
      data.fin_en ?? null,
      data.medidor_inicio ?? null,
      data.medidor_fin ?? null,
      estado,
      data.observaciones || null,
      usuarioId,
      estado === "cerrado" ? usuarioId : null,
      dniRelevo || null,
      nombreRelevo,
      sale,
    ]
  );
  await client.query(
    `INSERT INTO combustible_viaje_paradas (tenant_id, viaje_id, orden, lugar_id)
     SELECT $1, $2, (t.o - 1)::smallint, t.lugar
       FROM unnest($3::bigint[]) WITH ORDINALITY AS t(lugar, o)`,
    [tenantId, r.rows[0].id, paradas]
  );
  if (data.inicio_en) {
    // Registro retroactivo: el viaje ya salió, con quien salió manejando.
    await abrirTurno(client, tenantId, r.rows[0].id, {
      dni: sale === "relevo" ? dniRelevo : normalizarDni(conductorDni),
      nombre: sale === "relevo" ? nombreRelevo : (conductorNombre ?? null),
      inicio: data.inicio_en,
      medidor: data.medidor_inicio ?? null,
      lugarId: paradas[0],
      fin: data.fin_en ?? null,
      medidorFin: data.medidor_fin ?? null,
    });
  }
  await sincronizarExtremos(client, tenantId, r.rows[0].id);
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

interface ViajeConRelevo {
  estado: string;
  conductor_dni: string | null;
  relevo_dni: string | null;
  sale_primero: string;
}

/** El DNI de quien sale manejando al iniciar el viaje: el titular o su relevo. */
const quienSale = (v: ViajeConRelevo) =>
  normalizarDni(v.sale_primero === "relevo" ? v.relevo_dni : v.conductor_dni);

/** Quién va al volante: el turno abierto; antes de salir, quien sale manejando; y en un viaje que
 *  ya cerró, el último que lo manejó (o el titular si no tiene turnos). */
async function dniAlVolante(client: PoolClient, tenantId: string, id: number, v: ViajeConRelevo) {
  if (v.estado === "programado") return quienSale(v);
  const t = await client.query(
    `SELECT conductor_dni FROM combustible_viaje_turnos
      WHERE tenant_id = $1 AND viaje_id = $2 ORDER BY inicio_en DESC LIMIT 1`,
    [tenantId, id]
  );
  return t.rows[0] ? normalizarDni(t.rows[0].conductor_dni) : normalizarDni(v.conductor_dni);
}

/** Marca el que va al volante. El titular o el relevo que NO maneja recibe un 409 (el viaje es
 *  suyo, pero el mando lo tiene el otro); cualquier otro, 404: no confirma que el viaje exista. */
async function exigirAlVolante(
  client: PoolClient,
  tenantId: string,
  id: number,
  v: ViajeConRelevo,
  dni: string | undefined
) {
  if (dni === undefined) return;
  const d = normalizarDni(dni);
  if (d && d === (await dniAlVolante(client, tenantId, id, v))) return;
  if (d && (d === normalizarDni(v.conductor_dni) || d === normalizarDni(v.relevo_dni))) {
    throw new AppError(409, "El viaje lo maneja el otro conductor en este momento");
  }
  throw new AppError(404, "El viaje no existe");
}

/** Descansar lo hace cualquiera de los dos del viaje, maneje o no. */
function exigirDelViaje(v: ViajeConRelevo, dni: string | undefined) {
  if (dni === undefined) return;
  const d = normalizarDni(dni);
  if (!d || (d !== normalizarDni(v.conductor_dni) && d !== normalizarDni(v.relevo_dni))) {
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
  await exigirAlVolante(client, tenantId, id, v, dniConductor);
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
  const sale = quienSale(v);
  await exigirLibreParaManejar(client, tenantId, sale, id);
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
  await abrirTurno(client, tenantId, id, {
    dni: sale,
    nombre: v.sale_primero === "relevo" ? v.relevo_nombre : v.conductor_nombre,
    inicio,
    medidor: data.medidor_inicio ?? null,
    lugarId: v.origen_id,
  });
  await sincronizarExtremos(client, tenantId, id);
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
  await exigirAlVolante(client, tenantId, id, v, dniConductor);
  if (data.cliente_uuid && v.fin_cliente_uuid === data.cliente_uuid) {
    const despues = await getViaje(client, tenantId, id);
    return { antes: v, despues, fin: despues.fin_en, repetido: true };
  }
  if (v.estado === "programado") throw new AppError(409, "El viaje todavía no salió");
  if (v.estado !== "en_curso") throw new AppError(409, "El viaje ya está cerrado");
  // El conductor no cierra con el descanso abierto; la oficina que cierra por él lo termina.
  if (dniConductor !== undefined) await exigirSinDescansoAbierto(client, tenantId, id);
  const paradasDelViaje = await leerParadas(client, tenantId, id);
  if (paradasDelViaje.length > 2) {
    const pos = posicion(paradasDelViaje);
    if (pos.tipo !== "en_marcha" || pos.hacia !== paradasDelViaje.length - 1) {
      throw new AppError(
        409,
        "Este viaje tiene varias paradas: la llegada final se marca desde la última parada"
      );
    }
  }
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
    `UPDATE combustible_viaje_descansos
        SET fin_en = $3, fin_por = 'oficina', fin_origen_hora = $4, cerrado_por = $5
      WHERE tenant_id = $1 AND viaje_id = $2 AND fin_en IS NULL AND inicio_en < $3::timestamptz`,
    [tenantId, id, fin, origen, usuarioId]
  );
  await client.query(
    `UPDATE combustible_viaje_turnos SET fin_en = $3, medidor_fin = $4
      WHERE tenant_id = $1 AND viaje_id = $2 AND fin_en IS NULL AND inicio_en < $3::timestamptz`,
    [tenantId, id, fin, data.medidor_fin ?? null]
  );
  await client.query(
    `UPDATE combustible_viajes
        SET fin_en = $2, medidor_fin = $3, estado = 'cerrado', cerrado_por = $4,
            fin_origen_hora = $5, fin_cliente_uuid = $6
      WHERE id = $1`,
    [id, fin, data.medidor_fin ?? null, usuarioId, origen, data.cliente_uuid ?? null]
  );
  await sincronizarExtremos(client, tenantId, id);
  return { antes: v, despues: await getViaje(client, tenantId, id), fin, repetido: false };
}

// ── Llegar y salir de cada parada ──────────────────────────────────────────

interface FilaParada {
  orden: number;
  llegada_en: Date | null;
  llegada_medidor: string | null;
  salida_en: Date | null;
  salida_medidor: string | null;
  llegada_cliente_uuid: string | null;
  salida_cliente_uuid: string | null;
}

async function leerParadas(
  client: PoolClient,
  tenantId: string,
  viajeId: number
): Promise<FilaParada[]> {
  const r = await client.query(
    `SELECT orden, llegada_en, llegada_medidor, salida_en, salida_medidor,
            llegada_cliente_uuid, salida_cliente_uuid
       FROM combustible_viaje_paradas
      WHERE tenant_id = $1 AND viaje_id = $2 ORDER BY orden`,
    [tenantId, viajeId]
  );
  return r.rows;
}

type Posicion =
  | { tipo: "sin_salir" }
  | { tipo: "en_marcha"; hacia: number }
  | { tipo: "en_parada"; en: number }
  | { tipo: "terminado" };

/** En qué punto del recorrido va el viaje, según las marcas de sus paradas. */
function posicion(p: FilaParada[]): Posicion {
  for (let i = 0; i < p.length - 1; i++) {
    if (p[i].salida_en == null)
      return i === 0 ? { tipo: "sin_salir" } : { tipo: "en_parada", en: i };
    if (p[i + 1].llegada_en == null) return { tipo: "en_marcha", hacia: i + 1 };
  }
  return { tipo: "terminado" };
}

export interface MarcaParada {
  medidor?: number | null;
  /** Hora a mano (la oficina marca por quien se olvidó; con motivo). */
  hora?: string;
  marcado_en?: string;
  cliente_uuid?: string;
  /** La parada a la que el que marca cree que llega (o de la que sale). */
  orden?: number;
}

export interface ResultadoMarca {
  antes: Record<string, unknown>;
  despues: Record<string, unknown> | null;
  repetido: boolean;
  /** La parada marcada; null si fue un reintento. */
  orden: number | null;
  /** La llegada a la última parada cierra el viaje. */
  cierra: boolean;
}

async function validarMarcaDeParada(
  client: PoolClient,
  hora: string,
  despuesDe: Date,
  mensaje: string
) {
  if (Date.parse(hora) <= despuesDe.getTime()) throw new AppError(400, mensaje);
  if (Date.parse(hora) > Date.parse(await ahora(client)) + TOLERANCIA_RELOJ_MS) {
    throw new AppError(400, "La hora de la marca no puede ser futura");
  }
}

function validarMedidorDeParada(
  v: { medidor_inicio: string | null },
  medidor: number | null | undefined,
  previo: string | null,
  que: "llegada" | "salida"
) {
  if (v.medidor_inicio != null && medidor == null)
    throw new AppError(400, `Falta el medidor de ${que}`);
  if (medidor != null && previo != null && medidor < Number(previo)) {
    throw new AppError(
      400,
      `El medidor (${medidor}) es menor que el último del viaje (${Number(previo)})`
    );
  }
}

async function guardarMarcaDeParada(
  client: PoolClient,
  tenantId: string,
  viajeId: number,
  orden: number,
  que: "llegada" | "salida",
  valores: { hora: string; medidor: number | null; origen: OrigenHora; uuid: string | null }
) {
  try {
    await client.query(
      `UPDATE combustible_viaje_paradas
          SET ${que}_en = $4, ${que}_medidor = $5, ${que}_origen_hora = $6,
              ${que}_cliente_uuid = $7
        WHERE tenant_id = $1 AND viaje_id = $2 AND orden = $3`,
      [tenantId, viajeId, orden, valores.hora, valores.medidor, valores.origen, valores.uuid]
    );
  } catch (err) {
    if (esViolacionUnicidad(err)) throw new AppError(409, "Esa marca ya se usó en otro viaje");
    throw err;
  }
}

/** El conductor (o la oficina por él) llega a la siguiente parada. Llegar a la
 *  última cierra el viaje. Una marca que ya no corresponde (el viaje avanzó, o
 *  está cerrado) se rechaza con 409; el reintento de la cola devuelve el viaje
 *  como quedó. */
export async function llegarAParada(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  data: MarcaParada,
  dniConductor?: string
): Promise<ResultadoMarca> {
  const v = await viajeParaCambiar(client, tenantId, id);
  await exigirAlVolante(client, tenantId, id, v, dniConductor);
  const paradas = await leerParadas(client, tenantId, id);
  const uuid = data.cliente_uuid ?? null;
  if (
    uuid &&
    (v.fin_cliente_uuid === uuid || paradas.some((p) => p.llegada_cliente_uuid === uuid))
  ) {
    return {
      antes: v,
      despues: await getViaje(client, tenantId, id),
      repetido: true,
      orden: null,
      cierra: false,
    };
  }
  if (v.estado === "programado") throw new AppError(409, "El viaje todavía no salió");
  if (v.estado !== "en_curso") throw new AppError(409, "El viaje ya está cerrado");
  await exigirSinDescansoAbierto(client, tenantId, id);
  const pos = posicion(paradas);
  if (pos.tipo !== "en_marcha") {
    throw new AppError(409, "El viaje no va en camino a una parada: marca primero la salida");
  }
  if (data.orden !== undefined && data.orden !== pos.hacia) {
    throw new AppError(
      409,
      `Esa llegada ya no corresponde: el viaje va hacia la parada ${pos.hacia}`
    );
  }
  if (pos.hacia === paradas.length - 1) {
    const r = await cerrarViaje(
      client,
      tenantId,
      usuarioId,
      id,
      {
        medidor_fin: data.medidor,
        fin_en: data.hora,
        marcado_en: data.marcado_en,
        cliente_uuid: uuid ?? undefined,
      },
      dniConductor
    );
    return {
      antes: r.antes,
      despues: r.despues,
      repetido: r.repetido,
      orden: pos.hacia,
      cierra: true,
    };
  }
  const anterior = paradas[pos.hacia - 1];
  const { hora, origen } = await horaDeLaMarca(client, data.hora, data.marcado_en);
  await validarMarcaDeParada(
    client,
    hora,
    anterior.salida_en as Date,
    "La llegada tiene que ser posterior a la salida de la parada anterior"
  );
  validarMedidorDeParada(v, data.medidor, anterior.salida_medidor, "llegada");
  await guardarMarcaDeParada(client, tenantId, id, pos.hacia, "llegada", {
    hora,
    medidor: data.medidor ?? null,
    origen,
    uuid,
  });
  return {
    antes: v,
    despues: await getViaje(client, tenantId, id),
    repetido: false,
    orden: pos.hacia,
    cierra: false,
  };
}

/** Sale de una parada intermedia hacia la siguiente. La salida de la primera
 *  parada es iniciar el viaje. */
export async function salirDeParada(
  client: PoolClient,
  tenantId: string,
  _usuarioId: string,
  id: number,
  data: MarcaParada,
  dniConductor?: string
): Promise<ResultadoMarca> {
  const v = await viajeParaCambiar(client, tenantId, id);
  await exigirAlVolante(client, tenantId, id, v, dniConductor);
  const paradas = await leerParadas(client, tenantId, id);
  const uuid = data.cliente_uuid ?? null;
  if (uuid && paradas.some((p) => p.salida_cliente_uuid === uuid)) {
    return {
      antes: v,
      despues: await getViaje(client, tenantId, id),
      repetido: true,
      orden: null,
      cierra: false,
    };
  }
  if (v.estado === "programado") throw new AppError(409, "El viaje todavía no salió");
  if (v.estado !== "en_curso") throw new AppError(409, "El viaje ya está cerrado");
  await exigirSinDescansoAbierto(client, tenantId, id);
  const pos = posicion(paradas);
  if (pos.tipo !== "en_parada") {
    throw new AppError(409, "El viaje no está en una parada: marca primero la llegada");
  }
  if (data.orden !== undefined && data.orden !== pos.en) {
    throw new AppError(409, `Esa salida ya no corresponde: el viaje está en la parada ${pos.en}`);
  }
  const parada = paradas[pos.en];
  const { hora, origen } = await horaDeLaMarca(client, data.hora, data.marcado_en);
  await validarMarcaDeParada(
    client,
    hora,
    parada.llegada_en as Date,
    "La salida tiene que ser posterior a la llegada a la parada"
  );
  validarMedidorDeParada(v, data.medidor, parada.llegada_medidor, "salida");
  await guardarMarcaDeParada(client, tenantId, id, pos.en, "salida", {
    hora,
    medidor: data.medidor ?? null,
    origen,
    uuid,
  });
  return {
    antes: v,
    despues: await getViaje(client, tenantId, id),
    repetido: false,
    orden: pos.en,
    cierra: false,
  };
}

// ── Descansos ──────────────────────────────────────────────────────────────

export interface MarcaDescanso {
  motivo?: string | null;
  /** Hora a mano (la oficina marca por quien se olvidó; con motivo). */
  hora?: string;
  marcado_en?: string;
  cliente_uuid?: string;
}

export interface ResultadoDescanso {
  antes: Record<string, unknown>;
  despues: Record<string, unknown> | null;
  repetido: boolean;
}

/** Un viaje con un descanso abierto no avanza: primero se termina el descanso. */
async function exigirSinDescansoAbierto(client: PoolClient, tenantId: string, viajeId: number) {
  const r = await client.query(
    `SELECT 1 FROM combustible_viaje_descansos
      WHERE tenant_id = $1 AND viaje_id = $2 AND fin_en IS NULL AND detiene LIMIT 1`,
    [tenantId, viajeId]
  );
  if (r.rows[0]) throw new AppError(409, "Termina el descanso para continuar el viaje");
}

/** Dónde está el viaje, para anotarlo en el descanso: "En ruta hacia B" o "En B". */
function dondeEstaElViaje(paradas: { lugar: string }[] | null): string {
  const filas = (paradas ?? []) as unknown as (FilaParada & { lugar: string })[];
  const pos = posicion(filas);
  if (pos.tipo === "en_marcha") return `En ruta hacia ${filas[pos.hacia].lugar}`;
  if (pos.tipo === "en_parada") return `En ${filas[pos.en].lugar}`;
  return "En el viaje";
}

/** Empieza un descanso del conductor del viaje: el propio (`dniConductor`, desde su celular) o el
 *  de la oficina por él (con motivo). Una persona descansa una vez a la vez; el reintento de la cola
 *  devuelve el viaje como quedó. */
export async function iniciarDescanso(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  data: MarcaDescanso,
  dniConductor?: string
): Promise<ResultadoDescanso> {
  const v = await viajeParaCambiar(client, tenantId, id);
  exigirDelViaje(v, dniConductor);
  const uuid = data.cliente_uuid ?? null;
  if (uuid) {
    const rep = await client.query(
      `SELECT 1 FROM combustible_viaje_descansos
        WHERE tenant_id = $1 AND viaje_id = $2 AND inicio_cliente_uuid = $3`,
      [tenantId, id, uuid]
    );
    if (rep.rows[0]) {
      return { antes: v, despues: await getViaje(client, tenantId, id), repetido: true };
    }
  }
  if (v.estado === "programado") throw new AppError(409, "El viaje todavía no salió");
  if (v.estado !== "en_curso") throw new AppError(409, "El viaje ya está cerrado");
  const { hora, origen } = await horaDeLaMarca(client, data.hora, data.marcado_en);
  await validarMarcaDeParada(
    client,
    hora,
    v.inicio_en as Date,
    "El descanso tiene que ser posterior a la salida del viaje"
  );
  // Descansa quien lo marca (o, si la oficina lo marca, quien va al volante); solo frena la
  // unidad si es quien maneja.
  const alVolante = await dniAlVolante(client, tenantId, id, v);
  const persona = dniConductor === undefined ? alVolante : normalizarDni(dniConductor);
  const previo = await client.query(
    `SELECT max(fin_en) AS fin FROM combustible_viaje_descansos
      WHERE tenant_id = $1 AND viaje_id = $2 AND conductor_dni = $3`,
    [tenantId, id, persona]
  );
  if (previo.rows[0].fin && Date.parse(hora) < new Date(previo.rows[0].fin).getTime()) {
    throw new AppError(400, "El descanso empieza antes de que terminara el anterior");
  }
  const viaje = await getViaje(client, tenantId, id);
  try {
    await client.query(
      `INSERT INTO combustible_viaje_descansos (
         tenant_id, viaje_id, conductor_dni, conductor_nombre, inicio_en, motivo, donde,
         inicio_por, inicio_origen_hora, inicio_cliente_uuid, creado_por, detiene)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        tenantId,
        id,
        persona,
        persona === normalizarDni(v.relevo_dni) ? v.relevo_nombre : v.conductor_nombre,
        hora,
        data.motivo?.trim() || null,
        dondeEstaElViaje(viaje?.paradas),
        dniConductor === undefined ? "oficina" : "conductor",
        origen,
        uuid,
        usuarioId,
        persona === alVolante,
      ]
    );
  } catch (err) {
    if (!esViolacionUnicidad(err)) throw err;
    const abierto = (err as { constraint?: string }).constraint === "uq_viaje_descanso_abierto";
    throw new AppError(409, abierto ? "Ya hay un descanso abierto" : "Esa marca ya se usó");
  }
  return { antes: v, despues: await getViaje(client, tenantId, id), repetido: false };
}

/** Termina el descanso abierto del viaje. */
export async function terminarDescanso(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  data: MarcaDescanso,
  dniConductor?: string
): Promise<ResultadoDescanso> {
  const v = await viajeParaCambiar(client, tenantId, id);
  exigirDelViaje(v, dniConductor);
  const uuid = data.cliente_uuid ?? null;
  if (uuid) {
    const rep = await client.query(
      `SELECT 1 FROM combustible_viaje_descansos
        WHERE tenant_id = $1 AND viaje_id = $2 AND fin_cliente_uuid = $3`,
      [tenantId, id, uuid]
    );
    if (rep.rows[0]) {
      return { antes: v, despues: await getViaje(client, tenantId, id), repetido: true };
    }
  }
  const abierto = await client.query(
    `SELECT id, inicio_en FROM combustible_viaje_descansos
      WHERE tenant_id = $1 AND viaje_id = $2 AND fin_en IS NULL
        AND ($3::text IS NULL OR conductor_dni = $3) AND ($3::text IS NOT NULL OR detiene)`,
    [tenantId, id, dniConductor === undefined ? null : normalizarDni(dniConductor)]
  );
  if (!abierto.rows[0]) throw new AppError(409, "No hay un descanso abierto");
  const { hora, origen } = await horaDeLaMarca(client, data.hora, data.marcado_en);
  await validarMarcaDeParada(
    client,
    hora,
    abierto.rows[0].inicio_en as Date,
    "El descanso tiene que terminar después de empezar"
  );
  try {
    await client.query(
      `UPDATE combustible_viaje_descansos
          SET fin_en = $2, fin_por = $3, fin_origen_hora = $4, fin_cliente_uuid = $5,
              cerrado_por = $6
        WHERE id = $1`,
      [
        abierto.rows[0].id,
        hora,
        dniConductor === undefined ? "oficina" : "conductor",
        origen,
        uuid,
        usuarioId,
      ]
    );
  } catch (err) {
    if (esViolacionUnicidad(err)) throw new AppError(409, "Esa marca ya se usó");
    throw err;
  }
  return { antes: v, despues: await getViaje(client, tenantId, id), repetido: false };
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
  if (origen !== Number(v.origen_id) || destino !== Number(v.destino_id)) {
    const n = await client.query(
      `SELECT count(*)::int AS n FROM combustible_viaje_paradas WHERE tenant_id = $1 AND viaje_id = $2`,
      [tenantId, id]
    );
    if (n.rows[0].n > 2) {
      throw new AppError(409, "Este viaje tiene varias paradas: su recorrido no se edita");
    }
  }
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
  // Si cambia el titular, sus turnos pasan a él; y no puede ser a la vez el relevo.
  const titularAntes = normalizarDni(v.conductor_dni);
  const titularNuevo = normalizarDni(def(data.conductor_dni, v.conductor_dni));
  if (titularNuevo && titularNuevo === normalizarDni(v.relevo_dni)) {
    throw new AppError(400, "El titular no puede ser también el relevo");
  }

  await client.query(
    `UPDATE combustible_viajes
        SET equipo_id = $11, conductor_nombre = $2, conductor_dni = $3, origen_id = $4,
            destino_id = $5, inicio_en = $6, fin_en = $7, medidor_inicio = $8, medidor_fin = $9,
            observaciones = $10, ruta_por_confirmar = $12,
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
      def(data.observaciones, v.observaciones) || null,
      equipo,
      rutaPorConfirmar,
    ]
  );
  if (titularNuevo !== titularAntes) {
    await client.query(
      `UPDATE combustible_viaje_turnos SET conductor_dni = $3, conductor_nombre = $4
        WHERE tenant_id = $1 AND viaje_id = $2 AND conductor_dni = $5`,
      [
        tenantId,
        id,
        titularNuevo,
        def(data.conductor_nombre, v.conductor_nombre) || null,
        titularAntes,
      ]
    );
  }
  await sincronizarExtremos(client, tenantId, id);
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

/** El recorrido como clave (los ids de lugar en orden, "7-9-7"): dos viajes se comparan entre
 *  sí solo si hacen el mismo recorrido. `v` es el alias de la fila del viaje. */
const recorridoClave = (v: string) =>
  `(SELECT string_agg(rp.lugar_id::text, '-' ORDER BY rp.orden)
      FROM combustible_viaje_paradas rp
     WHERE rp.tenant_id = ${v}.tenant_id AND rp.viaje_id = ${v}.id)`;

/** El DNI de quien va al volante (a nivel SQL; `v` es la fila del viaje): antes de salir, quien sale
 *  manejando; después, el último turno (o el titular si no tiene). */
const volanteDni = (v: string) =>
  `CASE WHEN ${v}.estado = 'programado'
        THEN btrim(CASE WHEN ${v}.sale_primero = 'relevo' THEN ${v}.relevo_dni ELSE ${v}.conductor_dni END)
        ELSE COALESCE((SELECT t.conductor_dni FROM combustible_viaje_turnos t
                        WHERE t.tenant_id = ${v}.tenant_id AND t.viaje_id = ${v}.id
                        ORDER BY t.inicio_en DESC LIMIT 1), btrim(${v}.conductor_dni)) END`;

const COLUMNAS_VIAJE = `
  v.id, v.numero, v.equipo_id, e.placa_codigo, e.codigo_interno, e.tipo AS equipo_tipo,
  e.tipo_medidor, v.conductor_nombre, v.conductor_dni,
  v.origen_id, lo.nombre AS origen, v.destino_id, ld.nombre AS destino,
  v.inicio_en, v.fin_en, v.medidor_previo, v.medidor_inicio, v.medidor_fin,
  v.medidor_fin - v.medidor_inicio AS recorrido,
  v.medidor_inicio - v.medidor_previo AS recorrido_sin_viaje,
  v.ruta_por_confirmar, v.nota_ruta, v.inicio_origen_hora, v.fin_origen_hora,
  v.estado, v.observaciones, v.motivo_anulacion,
  v.relevo_dni, v.relevo_nombre, v.sale_primero, ${volanteDni("v")} AS volante_dni,
  v.ventana_desde, v.ventana_hasta,
  (SELECT json_agg(json_build_object(
            'conductor_dni', t.conductor_dni, 'conductor_nombre', t.conductor_nombre,
            'inicio_en', t.inicio_en, 'fin_en', t.fin_en, 'medidor_inicio', t.medidor_inicio,
            'medidor_fin', t.medidor_fin, 'lugar', t.lugar) ORDER BY t.inicio_en)
     FROM combustible_viaje_turnos t
    WHERE t.tenant_id = v.tenant_id AND t.viaje_id = v.id) AS turnos,
  (SELECT json_agg(json_build_object(
            'orden', p.orden, 'lugar_id', p.lugar_id, 'lugar', pl.nombre,
            'llegada_en', p.llegada_en, 'llegada_medidor', p.llegada_medidor,
            'salida_en', p.salida_en, 'salida_medidor', p.salida_medidor) ORDER BY p.orden)
     FROM combustible_viaje_paradas p
     JOIN combustible_lugares pl ON pl.id = p.lugar_id AND pl.tenant_id = p.tenant_id
    WHERE p.tenant_id = v.tenant_id AND p.viaje_id = v.id) AS paradas,
  (SELECT json_agg(json_build_object(
            'id', d.id, 'conductor_nombre', d.conductor_nombre, 'inicio_en', d.inicio_en,
            'fin_en', d.fin_en, 'motivo', d.motivo, 'donde', d.donde, 'detiene', d.detiene,
            'inicio_por', d.inicio_por, 'fin_por', d.fin_por) ORDER BY d.inicio_en)
     FROM combustible_viaje_descansos d
    WHERE d.tenant_id = v.tenant_id AND d.viaje_id = v.id) AS descansos,
  ${recorridoClave("v")} AS recorrido_clave`;

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
           -- Promedio de la MISMA unidad en el MISMO recorrido (solo viajes
           -- cerrados: uno en curso todavía no terminó de cargar).
           AVG(b.cantidad) FILTER (WHERE b.estado = 'cerrado' AND NOT b.ruta_por_confirmar)
             OVER (PARTITION BY b.recorrido_clave, b.equipo_id) AS promedio_ruta_unidad,
           COUNT(*) FILTER (WHERE b.estado = 'cerrado' AND NOT b.ruta_por_confirmar)
             OVER (PARTITION BY b.recorrido_clave, b.equipo_id) AS viajes_ruta_unidad,
           AVG(b.cantidad) FILTER (WHERE b.estado = 'cerrado' AND NOT b.ruta_por_confirmar)
             OVER (PARTITION BY b.recorrido_clave) AS promedio_ruta,
           COUNT(*) FILTER (WHERE b.estado = 'cerrado' AND NOT b.ruta_por_confirmar)
             OVER (PARTITION BY b.recorrido_clave) AS viajes_ruta
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
  const ruta = await estadisticasRuta(client, tenantId, viaje.recorrido_clave, Number(viaje.id));
  if (!viaje.inicio_en) return { viaje, cargas: [], ruta, tramos: [] };
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
  return { viaje, cargas: r.rows, ruta, tramos: repartirPorTramo(viaje.paradas ?? [], r.rows) };
}

/** Cuánto suele durar y consumir esta ruta: los últimos 20 viajes cerrados y
 *  confirmados (sin el propio). Da la llegada estimada de un viaje en curso y
 *  la comparación de uno cerrado. */
export async function estadisticasRuta(
  client: PoolClient,
  tenantId: string,
  recorrido: string,
  excluirId: number
) {
  const margen = await margenPrevioHoras(client, tenantId);
  const r = await client.query(
    `WITH v AS (${VENTANAS_SQL}
       WHERE v.tenant_id = $1 AND ${recorridoClave("v")} = $3 AND v.id <> $4
         AND v.estado = 'cerrado' AND NOT v.ruta_por_confirmar
       ORDER BY v.fin_en DESC LIMIT 20)
     SELECT count(*)::int AS viajes,
            avg(extract(epoch FROM v.fin_en - v.inicio_en) / 60) AS duracion_min,
            avg(COALESCE(cg.combustible_l, 0) / ${LITROS_POR_GALON}) AS combustible_gal,
            avg(COALESCE(cg.urea_l, 0)) AS urea_l
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
    [tenantId, margen, recorrido, excluirId]
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
       WHERE v.tenant_id = $1 AND $3 IN (btrim(v.conductor_dni), btrim(v.relevo_dni))
         AND (v.estado IN ('programado', 'en_curso') OR v.id = (
           SELECT u.id FROM combustible_viajes u
            WHERE u.tenant_id = $1 AND $3 IN (btrim(u.conductor_dni), btrim(u.relevo_dni))
              AND u.estado = 'cerrado'
            ORDER BY u.fin_en DESC LIMIT 1)))
     SELECT ${COLUMNAS_VIAJE},
            CASE WHEN btrim(v.conductor_dni) = $3 THEN 'titular' ELSE 'relevo' END AS mi_rol,
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
      ORDER BY CASE WHEN v.estado = 'en_curso' AND ${volanteDni("v")} = $3 THEN 0
                    WHEN v.estado = 'en_curso' THEN 1
                    WHEN v.estado = 'programado' AND ${volanteDni("v")} = $3 THEN 2
                    WHEN v.estado = 'programado' THEN 3 ELSE 4 END,
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
        ? await estadisticasRuta(client, tenantId, fila.recorrido_clave, Number(fila.id))
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

/** La unidad del viaje que el conductor ve en "Mi viaje" (el que está en curso
 *  y, si no hay, el programado), o null. Sirve para precargar la compra en ruta:
 *  solo expone la unidad, nada de la ruta ni del resto del viaje. */
export async function unidadDelViajeActivo(
  client: PoolClient,
  tenantId: string,
  dni: string
): Promise<{
  viaje_id: number;
  estado: string;
  equipo_id: number;
  placa_codigo: string;
} | null> {
  const d = normalizarDni(dni);
  if (!d) return null;
  const r = await client.query(
    `SELECT v.id::int AS viaje_id, v.estado, v.equipo_id, e.placa_codigo
       FROM combustible_viajes v
       JOIN equipos e ON e.id = v.equipo_id AND e.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND ${volanteDni("v")} = $2
        AND v.estado IN ('programado', 'en_curso')
      ORDER BY CASE v.estado WHEN 'en_curso' THEN 0 ELSE 1 END, v.creado_en
      LIMIT 1`,
    [tenantId, d]
  );
  return r.rows[0] ?? null;
}

/** Los viajes cerrados del conductor, del más reciente al más viejo, con lo suyo: el recorrido, las
 *  horas, lo descansado y lo que recorrió. Solo por su DNI: ve los suyos y nada de otros
 *  conductores ni promedios. Se pide por páginas: `antes` es la llegada del último que ya tiene. */
export async function historialDelConductor(
  client: PoolClient,
  tenantId: string,
  dni: string,
  limite: number,
  antes?: string
) {
  const d = normalizarDni(dni);
  if (!d) return { data: [], siguiente: null };
  const r = await client.query(
    `SELECT v.id, v.numero, v.inicio_en, v.fin_en, e.placa_codigo, e.tipo_medidor,
            (SELECT sum(t.medidor_fin - t.medidor_inicio) FROM combustible_viaje_turnos t
              WHERE t.tenant_id = v.tenant_id AND t.viaje_id = v.id AND t.conductor_dni = $2
                AND t.medidor_inicio IS NOT NULL AND t.medidor_fin IS NOT NULL) AS recorrido,
            (SELECT sum(extract(epoch FROM t.fin_en - t.inicio_en) / 60)
               FROM combustible_viaje_turnos t
              WHERE t.tenant_id = v.tenant_id AND t.viaje_id = v.id AND t.conductor_dni = $2
                AND t.fin_en IS NOT NULL) AS parte_min,
            (SELECT json_agg(pl.nombre ORDER BY p.orden)
               FROM combustible_viaje_paradas p
               JOIN combustible_lugares pl ON pl.id = p.lugar_id AND pl.tenant_id = p.tenant_id
              WHERE p.tenant_id = v.tenant_id AND p.viaje_id = v.id) AS paradas,
            COALESCE((SELECT sum(extract(epoch FROM d.fin_en - d.inicio_en) / 60)
                        FROM combustible_viaje_descansos d
                       WHERE d.tenant_id = v.tenant_id AND d.viaje_id = v.id
                         AND d.conductor_dni = $2 AND d.fin_en IS NOT NULL AND d.detiene), 0) AS descanso_min
       FROM combustible_viajes v
       JOIN equipos e ON e.id = v.equipo_id AND e.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND v.estado = 'cerrado'
        AND EXISTS (SELECT 1 FROM combustible_viaje_turnos t
                     WHERE t.tenant_id = v.tenant_id AND t.viaje_id = v.id AND t.conductor_dni = $2)
        AND ($3::timestamptz IS NULL OR v.fin_en < $3::timestamptz)
      ORDER BY v.fin_en DESC
      LIMIT $4`,
    [tenantId, d, antes ?? null, limite]
  );
  const ultimo = r.rows[r.rows.length - 1];
  return { data: r.rows, siguiente: r.rows.length === limite ? ultimo.fin_en : null };
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
