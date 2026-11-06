/** src/modules/combustible/viajesCreadosPorConductor.ts
 *
 * El conductor crea e inicia su propio viaje desde el celular (migración 0179).
 *
 * No reescribe nada de Viajes: arma el viaje con `crearViaje` (programado) y lo inicia con
 * `iniciarViaje`, los mismos que usan la oficina y "Mi viaje", dentro de UNA transacción. Así
 * valen todos sus chequeos (medidor previo, traslape, conductor libre, relevo) y, si cualquiera
 * falla, no queda nada a medias: ni el viaje ni la unidad nueva.
 */
import type { PoolClient } from "pg";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { normalizarPlaca, type CrearMiViajeInput } from "../../server/schemas/combustible.schema";
import { aplicarConductor, aplicarRutas } from "../equipos/equipos.historial";
import { crearViaje, getViaje, iniciarViaje } from "./viajes.service";

/** El tipo con que nace una unidad que registra el conductor: la oficina lo cambia al completarla. */
export const TIPO_UNIDAD_POR_COMPLETAR = "Por completar";

export interface ConductorQueCrea {
  usuarioId: string;
  dni: string;
  nombre: string;
}

export type ResultadoCrearMiViaje = {
  viaje: Awaited<ReturnType<typeof getViaje>>;
  /** El mismo identificador ya había creado este viaje: se devuelve como quedó. */
  repetido: boolean;
  /** La unidad se registró en este mismo envío. */
  unidadNueva: boolean;
};

/** La empresa tiene encendido el interruptor de plataforma (apagado por defecto). */
export async function conductorPuedeCrearViaje(client: PoolClient, tenantId: string) {
  const r = await client.query(`SELECT conductor_crea_viaje FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  return r.rows[0]?.conductor_crea_viaje === true;
}

/** La unidad de esa placa (sin importar guiones ni mayúsculas) o la registra "por completar" con
 *  solo la placa, el nombre del conductor y la ruta que ingresó. Si la placa ya existe se usa esa:
 *  nunca se crea una segunda. */
async function unidadDeLaPlaca(
  client: PoolClient,
  tenantId: string,
  c: ConductorQueCrea,
  nueva: NonNullable<CrearMiViajeInput["unidad_nueva"]>,
  ruta: { origen_id: number; destino_id: number }
): Promise<{ equipoId: number; creada: boolean }> {
  const placa = normalizarPlaca(nueva.placa);
  // Dos conductores con la misma placa a la vez no crean dos unidades.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `equipo-placa:${tenantId}:${placa}`,
  ]);
  const existente = await client.query(
    `SELECT id FROM equipos
      WHERE tenant_id = $1 AND upper(regexp_replace(placa_codigo, '[^A-Za-z0-9]', '', 'g')) = $2
      ORDER BY activo DESC, id LIMIT 1`,
    [tenantId, placa]
  );
  if (existente.rows[0]) return { equipoId: Number(existente.rows[0].id), creada: false };

  const nombre = nueva.nombre.trim();
  const r = await client.query(
    `INSERT INTO equipos (tenant_id, placa_codigo, tipo, conductor_nombre, conductor_dni,
                          por_completar)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [tenantId, nueva.placa.trim().toUpperCase(), TIPO_UNIDAD_POR_COMPLETAR, nombre, c.dni]
  );
  const equipoId = Number(r.rows[0].id);
  // El historial de Equipos arranca como en cualquier alta: con el conductor y la ruta.
  await aplicarConductor(
    client,
    tenantId,
    equipoId,
    c.usuarioId,
    {},
    { nombre, dni: c.dni },
    undefined,
    true
  );
  await aplicarRutas(client, tenantId, equipoId, c.usuarioId, [ruta], undefined, true);
  return { equipoId, creada: true };
}

export interface CatalogoParaCrear {
  puede_crear_viaje: boolean;
  lugares: { id: number; nombre: string }[];
  unidades: {
    id: number;
    placa: string;
    tipo: string;
    por_completar: boolean;
    /** La unidad que Equipos le tiene asignada a este conductor. */
    asignada_a_mi: boolean;
    /** Su ruta habitual en Equipos (la primera vigente), o null si no tiene. */
    ruta: { origen_id: number; destino_id: number; origen: string; destino: string } | null;
  }[];
  /** Otros conductores activos que pueden ir de relevo. Sin DNI: se elige por su id de usuario. */
  relevos: { id: string; nombre: string }[];
}

/** Lo que el celular necesita para armar el viaje: lugares, unidades con su ruta y posibles
 *  relevos. Con el interruptor de la empresa apagado no se entrega nada. */
export async function catalogoParaCrear(
  client: PoolClient,
  tenantId: string,
  c: ConductorQueCrea
): Promise<CatalogoParaCrear> {
  if (!(await conductorPuedeCrearViaje(client, tenantId))) {
    return { puede_crear_viaje: false, lugares: [], unidades: [], relevos: [] };
  }
  const lugares = await client.query(
    `SELECT id::int, nombre FROM combustible_lugares
      WHERE tenant_id = $1 AND activo ORDER BY lower(nombre)`,
    [tenantId]
  );
  const unidades = await client.query(
    `SELECT e.id::int, COALESCE(e.placa_codigo, e.codigo_interno) AS placa, e.tipo, e.por_completar,
            (btrim(e.conductor_dni) = $2) AS asignada_a_mi,
            r.origen_id::int, r.destino_id::int, lo.nombre AS origen, ld.nombre AS destino
       FROM equipos e
       LEFT JOIN LATERAL (
         SELECT origen_id, destino_id FROM equipo_rutas
          WHERE tenant_id = e.tenant_id AND equipo_id = e.id AND hasta IS NULL
          ORDER BY id LIMIT 1) r ON true
       LEFT JOIN combustible_lugares lo ON lo.tenant_id = e.tenant_id AND lo.id = r.origen_id
       LEFT JOIN combustible_lugares ld ON ld.tenant_id = e.tenant_id AND ld.id = r.destino_id
      WHERE e.tenant_id = $1 AND e.activo
      ORDER BY (btrim(e.conductor_dni) = $2) DESC, lower(COALESCE(e.placa_codigo, e.codigo_interno))`,
    [tenantId, c.dni.trim()]
  );
  const relevos = await client.query(
    `SELECT id, nombre FROM usuarios
      WHERE tenant_id = $1 AND rol = 'conductor_ruta' AND activo AND id <> $2
        AND COALESCE(btrim(dni), '') <> '' AND btrim(dni) <> $3
      ORDER BY lower(nombre)`,
    [tenantId, c.usuarioId, c.dni.trim()]
  );
  return {
    puede_crear_viaje: true,
    lugares: lugares.rows,
    unidades: unidades.rows.map((u) => ({
      id: u.id,
      placa: u.placa,
      tipo: u.tipo,
      por_completar: u.por_completar,
      asignada_a_mi: u.asignada_a_mi === true,
      ruta:
        u.origen_id && u.destino_id
          ? {
              origen_id: u.origen_id,
              destino_id: u.destino_id,
              origen: u.origen,
              destino: u.destino,
            }
          : null,
    })),
    relevos: relevos.rows,
  };
}

export async function crearMiViaje(
  client: PoolClient,
  tenantId: string,
  c: ConductorQueCrea,
  data: CrearMiViajeInput
): Promise<ResultadoCrearMiViaje> {
  if (!(await conductorPuedeCrearViaje(client, tenantId))) {
    throw new AppError(403, "Tu empresa no tiene activada la creación de viajes por el conductor");
  }
  const dni = c.dni.trim();
  if (!dni) throw new AppError(400, "Tu usuario no tiene DNI: pide a la oficina que lo agregue");

  // Un solo envío a la vez por conductor: el doble clic y el reintento esperan su turno y ven lo
  // que el primero dejó.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `viaje-crea-mio:${tenantId}:${dni}`,
  ]);

  // Reintento (cola sin señal o doble envío): el mismo identificador devuelve el viaje ya creado.
  const previo = await client.query(
    `SELECT id, btrim(conductor_dni) AS dni FROM combustible_viajes
      WHERE tenant_id = $1 AND id_cliente = $2`,
    [tenantId, data.id_cliente]
  );
  if (previo.rows[0]) {
    if (previo.rows[0].dni !== dni) throw new AppError(409, "Ese identificador no es tuyo");
    return {
      viaje: await getViaje(client, tenantId, Number(previo.rows[0].id)),
      repetido: true,
      unidadNueva: false,
    };
  }

  // Con un viaje programado o en curso (titular o relevo) no se crea otro: se devuelve el que tiene.
  const activo = await client.query(
    `SELECT id FROM combustible_viajes
      WHERE tenant_id = $1 AND estado IN ('programado', 'en_curso')
        AND $2 IN (btrim(conductor_dni), btrim(relevo_dni))
      ORDER BY (estado = 'en_curso') DESC, id LIMIT 1`,
    [tenantId, dni]
  );
  if (activo.rows[0]) {
    throw new AppError(409, "Ya tienes un viaje programado o en curso", {
      viaje: await getViaje(client, tenantId, Number(activo.rows[0].id)),
    });
  }

  let equipoId = data.equipo_id;
  let unidadNueva = false;
  if (data.unidad_nueva) {
    const u = await unidadDeLaPlaca(client, tenantId, c, data.unidad_nueva, {
      origen_id: data.paradas[0],
      destino_id: data.paradas[1],
    });
    equipoId = u.equipoId;
    unidadNueva = u.creada;
  }

  // El relevo llega por su id de usuario (el celular no ve DNI ajenos): se resuelve aquí.
  let relevoDni: string | undefined = data.relevo_dni ?? undefined;
  if (data.relevo_usuario_id) {
    const rel = await client.query(
      `SELECT btrim(dni) AS dni FROM usuarios
        WHERE tenant_id = $1 AND id = $2 AND rol = 'conductor_ruta' AND activo`,
      [tenantId, data.relevo_usuario_id]
    );
    if (!rel.rows[0]?.dni) throw new AppError(400, "El relevo tiene que ser un conductor activo");
    relevoDni = rel.rows[0].dni;
  }

  // El viaje lleva SU copia del conductor: es quien lo crea, sin tocar el conductor asignado a la
  // unidad en Equipos. Nace programado y se inicia enseguida en la misma transacción.
  const creado = await crearViaje(client, tenantId, c.usuarioId, {
    equipo_id: equipoId!,
    conductor_nombre: c.nombre,
    conductor_dni: dni,
    paradas: data.paradas,
    relevo_dni: relevoDni,
    sale: "titular",
  } as Parameters<typeof crearViaje>[3]);
  const id = Number(creado.id);
  await iniciarViaje(
    client,
    tenantId,
    c.usuarioId,
    id,
    {
      medidor_inicio: data.medidor_inicio,
      marcado_en: data.marcado_en,
      cliente_uuid: data.id_cliente,
    },
    dni
  );
  await client.query(
    `UPDATE combustible_viajes SET creado_por_conductor = true, id_cliente = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, data.id_cliente]
  );
  return { viaje: await getViaje(client, tenantId, id), repetido: false, unidadNueva };
}
