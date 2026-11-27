/** src/modules/ordenes_trabajo/ordenes_trabajo.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  CrearOrdenTrabajoInput,
  ActualizarOrdenTrabajoInput,
  CambiarEstadoOrdenTrabajoInput,
  CambiarTareasInput,
} from "../../server/schemas/ordenes_trabajo.schema";
import { cuantosOperanConCasilla } from "../../server/services/permisosPestanas.service";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { asignarOrden } from "./ordenes_trabajo.asignacion";
import { darConformidad } from "./ordenes_trabajo.conformidad";
import {
  mecanicosConCarga,
  resumenDeOrdenes,
  type FiltrosDeOrdenes,
  type Vecinos,
} from "./ordenes_trabajo.consulta";
import { OrdenesTrabajoRepository } from "./ordenes_trabajo.repository";
import { cambiarTareas } from "./ordenes_trabajo.tareas";

export const OrdenesTrabajoService = {
  getAll(
    client: PoolClient,
    tenantId: string,
    paginacion: Paginacion,
    filtros: FiltrosDeOrdenes,
    vecinos: Vecinos
  ) {
    return OrdenesTrabajoRepository.findAll(client, tenantId, paginacion, filtros, vecinos);
  },

  resumen(client: PoolClient, tenantId: string) {
    return resumenDeOrdenes(client, tenantId);
  },

  mecanicos(client: PoolClient, tenantId: string) {
    return mecanicosConCarga(client, tenantId);
  },

  asignar(client: PoolClient, tenantId: string, id: number, asignadoA: string | null) {
    return asignarOrden(client, tenantId, id, asignadoA);
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

  darConformidad(client: PoolClient, tenantId: string, id: number, usuarioId: string) {
    return darConformidad(client, tenantId, id, usuarioId);
  },

  cuantosDanConformidad(client: PoolClient, tenantId: string) {
    // Con ninguna, las unidades no se liberan.
    return cuantosOperanConCasilla(client, tenantId, "ordenes_trabajo", "conformidad:dar");
  },

  eliminar(client: PoolClient, tenantId: string, id: number) {
    return OrdenesTrabajoRepository.eliminar(client, tenantId, id);
  },

  getUsuariosAsignables(client: PoolClient, tenantId: string) {
    return OrdenesTrabajoRepository.findUsuariosAsignables(client, tenantId);
  },
};
