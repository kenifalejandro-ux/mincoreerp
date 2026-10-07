/** src/modules/equipos/equipos.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  CargaMasivaEquiposInput,
  CrearEquipoInput,
} from "../../server/schemas/equipos.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import type { MoverDeGrifoInput } from "../../server/schemas/sedes.schema";
import {
  listarMovimientosDeGrifo,
  motivoFaltaGrifo,
  moverDeGrifo,
} from "../../server/services/sedes.service";
import {
  aplicarConductor,
  aplicarRutas,
  listarHistorial,
  listarLugaresActivos,
  type RutaAsignada,
} from "./equipos.historial";
import { EquiposRepository, type EquipoPayload } from "./equipos.repository";

/** Lo que cambió en conductor y rutas con un PUT: el controller lo audita. */
export interface CambiosHistorial {
  conductor: { de: string; a: string } | null;
  rutas: { cerradas: string[]; abiertas: string[] } | null;
  motivo: string | undefined;
}

export const EquiposService = {
  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return EquiposRepository.findAll(client, tenantId, paginacion);
  },

  getAllParaExportar(client: PoolClient, tenantId: string) {
    return EquiposRepository.findAllParaExportar(client, tenantId);
  },

  /** Devuelve `creado: false` cuando el equipo ya se había creado con este
   *  mismo `cliente_uuid` — o sea, cuando esto es el reintento de un envío
   *  cuya respuesta se perdió. El controller usa ese flag para no auditar
   *  ni publicar el evento dos veces. Sin `cliente_uuid` en el body, se
   *  comporta igual que antes: siempre crea. */
  create(client: PoolClient, tenantId: string, usuarioId: string, data: CrearEquipoInput) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "equipos",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        // Con más de un grifo interno, el equipo tiene que decir a cuál
        // pertenece (0097). Acá adentro y no antes: el reintento de un envío
        // que ya se había guardado no tiene que volver a validarse.
        const falta = await motivoFaltaGrifo(client, tenantId, data.grifo_interno_id, "equipo");
        if (falta) throw new Error(falta);
        const creada = await EquiposRepository.create(client, tenantId, data);
        // Nace con conductor/rutas: el historial arranca con "Alta del equipo".
        await aplicarConductor(
          client,
          tenantId,
          creada.id,
          usuarioId,
          { nombre: null, dni: null },
          { nombre: data.conductor_nombre, dni: data.conductor_dni },
          undefined,
          true
        );
        await aplicarRutas(client, tenantId, creada.id, usuarioId, data.rutas, undefined, true);
        const fila = await EquiposRepository.findById(client, tenantId, creada.id);
        return { id: creada.id as number, fila };
      },
      recuperar: (filaId) => EquiposRepository.findById(client, tenantId, filaId),
    });
  },

  /** Lo usa el controlador para saber cómo estaba el equipo ANTES del PUT:
   *  sin eso no se puede distinguir si el cambio amplió o estrechó el techo
   *  diario de combustible (ver detectarAmpliacionDeTecho). */
  getById(client: PoolClient, tenantId: string, id: number) {
    return EquiposRepository.findById(client, tenantId, id);
  },

  /** Actualiza el equipo y deja el rastro de conductor y rutas EN LA MISMA
   *  transacción. Sin motivo, un cambio de conductor o de rutas lanza 400 y se
   *  revierte todo. Devuelve null si el equipo no existe.
   *
   *  La fila del equipo se bloquea ANTES de leer el conductor de "antes": dos
   *  PUT a la vez se serializan, y el segundo compara contra lo que dejó el
   *  primero, no contra una foto vieja. */
  async update(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: EquipoPayload & { rutas?: RutaAsignada[]; motivo_cambio?: string }
  ): Promise<{ fila: Record<string, unknown>; cambios: CambiosHistorial } | null> {
    const previo = await client.query<{
      conductor_nombre: string | null;
      conductor_dni: string | null;
    }>(
      `SELECT conductor_nombre, conductor_dni FROM equipos
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (previo.rows.length === 0) return null;

    const actualizada = await EquiposRepository.update(client, tenantId, id, data);
    if (!actualizada) return null;
    const conductor = await aplicarConductor(
      client,
      tenantId,
      id,
      usuarioId,
      { nombre: previo.rows[0].conductor_nombre, dni: previo.rows[0].conductor_dni },
      { nombre: data.conductor_nombre, dni: data.conductor_dni },
      data.motivo_cambio,
      false
    );
    const rutas = await aplicarRutas(
      client,
      tenantId,
      id,
      usuarioId,
      data.rutas,
      data.motivo_cambio,
      false
    );
    const fila = await EquiposRepository.findById(client, tenantId, id);
    return { fila, cambios: { conductor, rutas, motivo: data.motivo_cambio } };
  },

  historial(client: PoolClient, tenantId: string, id: number) {
    return listarHistorial(client, tenantId, id);
  },

  lugares(client: PoolClient, tenantId: string) {
    return listarLugaresActivos(client, tenantId);
  },

  delete(client: PoolClient, tenantId: string, id: number) {
    return EquiposRepository.delete(client, tenantId, id);
  },

  createBulk(client: PoolClient, tenantId: string, rows: CargaMasivaEquiposInput) {
    return EquiposRepository.createBulk(client, tenantId, rows);
  },

  deleteMany(client: PoolClient, tenantId: string, ids: number[]) {
    return EquiposRepository.deleteMany(client, tenantId, ids);
  },

  /** Mover el equipo a otro grifo interno (0097). Null si no existe en esta
   *  empresa. */
  moverDeGrifo(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    data: MoverDeGrifoInput
  ) {
    return moverDeGrifo(client, tenantId, {
      tabla: "equipos",
      id,
      grifoDestinoId: data.grifo_interno_id,
      motivo: data.motivo,
      usuarioId,
    });
  },

  listarMovimientosDeGrifo(client: PoolClient, tenantId: string, id: number) {
    return listarMovimientosDeGrifo(client, tenantId, "equipo_id", id);
  },
};
