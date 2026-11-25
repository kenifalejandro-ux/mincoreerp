/** src/modules/checklists/checklists.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion, CursorPaginacion } from "../../server/shared/utils/pagination";
import type {
  CrearPlantillaInput,
  CrearChecklistInput,
} from "../../server/schemas/checklists.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { ChecklistsRepository } from "./checklists.repository";

export const ChecklistsService = {
  getPlantillas(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return ChecklistsRepository.findPlantillas(client, tenantId, paginacion);
  },

  getPlantilla(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.findPlantillaConItems(client, tenantId, id);
  },

  crearPlantilla(client: PoolClient, tenantId: string, data: CrearPlantillaInput) {
    return ChecklistsRepository.crearPlantilla(client, tenantId, data);
  },

  eliminarPlantilla(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.eliminarPlantilla(client, tenantId, id);
  },

  /** `conUnidades`: el usuario tiene un módulo que mantiene unidades (Flota o Mantenimiento). Sin él no se lee `equipos` (ver `opcionales`). */
  getAll(client: PoolClient, tenantId: string, paginacion: CursorPaginacion, conUnidades = true) {
    return ChecklistsRepository.findAll(client, tenantId, paginacion, conUnidades);
  },

  getById(client: PoolClient, tenantId: string, id: number, conUnidades = true) {
    return ChecklistsRepository.findById(client, tenantId, id, conUnidades);
  },

  /** Devuelve `creado: false` cuando el checklist ya se había creado con
   *  este mismo `cliente_uuid` — o sea, cuando esto es el reintento de un
   *  envío cuya respuesta se perdió. El controller usa ese flag para no
   *  auditar ni publicar el evento dos veces. Sin `cliente_uuid` en el
   *  body, se comporta igual que antes: siempre crea. */
  crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearChecklistInput,
    conUnidades = true
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "checklists",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await ChecklistsRepository.crear(client, tenantId, usuarioId, data);
        return { id: fila.id as number, fila };
      },
      // findById devuelve un superset de lo que devuelve crear() (suma
      // placa_codigo y usuario_nombre por los JOIN) — así el reintento
      // nunca responde con MENOS datos que el intento original.
      recuperar: (filaId) => ChecklistsRepository.findById(client, tenantId, filaId, conUnidades),
    });
  },

  eliminar(client: PoolClient, tenantId: string, id: number) {
    return ChecklistsRepository.eliminar(client, tenantId, id);
  },
};
