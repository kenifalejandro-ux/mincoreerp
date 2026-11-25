/** src/modules/ordenes_trabajo/ordenes_trabajo.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  CrearOrdenTrabajoInput,
  ActualizarOrdenTrabajoInput,
  CambiarEstadoOrdenTrabajoInput,
  CambiarTareasInput,
} from "../../server/schemas/ordenes_trabajo.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { OrdenesTrabajoRepository } from "./ordenes_trabajo.repository";
import { cambiarTareas } from "./ordenes_trabajo.tareas";

export const OrdenesTrabajoService = {
  getAll(
    client: PoolClient,
    tenantId: string,
    paginacion: Paginacion,
    filtros: { estado?: string; equipoId?: number; asignadoA?: string },
    conUnidades = true
  ) {
    return OrdenesTrabajoRepository.findAll(client, tenantId, paginacion, filtros, conUnidades);
  },

  /** `conUnidades`: el usuario tiene un módulo que mantiene unidades (Flota o Mantenimiento). Sin él no se lee `equipos` (ver `opcionales`). */
  getById(client: PoolClient, tenantId: string, id: number, conUnidades = true) {
    return OrdenesTrabajoRepository.findById(client, tenantId, id, conUnidades);
  },

  /** Devuelve `creado: false` cuando esta OT ya se había creado con el
   *  mismo `cliente_uuid` -- el reintento de un envío cuya respuesta se
   *  perdió (online u offline: la creación de OT participa de la cola
   *  offline, ver src/modules/registry.ts). El controller usa ese flag
   *  para no auditar ni publicar el evento dos veces. */
  crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearOrdenTrabajoInput,
    conUnidades = true
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "ordenes_trabajo",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await OrdenesTrabajoRepository.crear(client, tenantId, usuarioId, data);
        return { id: fila.id as number, fila };
      },
      recuperar: (filaId) =>
        OrdenesTrabajoRepository.findById(client, tenantId, filaId, conUnidades),
    });
  },

  actualizar(client: PoolClient, tenantId: string, id: number, data: ActualizarOrdenTrabajoInput) {
    return OrdenesTrabajoRepository.actualizar(client, tenantId, id, data);
  },

  cambiarEstado(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: CambiarEstadoOrdenTrabajoInput
  ) {
    return OrdenesTrabajoRepository.cambiarEstado(client, tenantId, id, data);
  },

  cambiarTareas(client: PoolClient, tenantId: string, id: number, data: CambiarTareasInput) {
    return cambiarTareas(client, tenantId, id, data);
  },

  eliminar(client: PoolClient, tenantId: string, id: number) {
    return OrdenesTrabajoRepository.eliminar(client, tenantId, id);
  },

  getUsuariosAsignables(client: PoolClient, tenantId: string) {
    return OrdenesTrabajoRepository.findUsuariosAsignables(client, tenantId);
  },
};
