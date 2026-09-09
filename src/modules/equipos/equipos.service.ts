/** src/modules/equipos/equipos.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type { CrearEquipoInput } from "../../server/schemas/equipos.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { EquiposRepository, type EquipoPayload } from "./equipos.repository";

export const EquiposService = {
  getAll(client: PoolClient, tenantId: string, paginacion: Paginacion) {
    return EquiposRepository.findAll(client, tenantId, paginacion);
  },

  /** Devuelve `creado: false` cuando el equipo ya se había creado con este
   *  mismo `cliente_uuid` — o sea, cuando esto es el reintento de un envío
   *  cuya respuesta se perdió. El controller usa ese flag para no auditar
   *  ni publicar el evento dos veces. Sin `cliente_uuid` en el body, se
   *  comporta igual que antes: siempre crea. */
  create(client: PoolClient, tenantId: string, data: CrearEquipoInput) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "equipos",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await EquiposRepository.create(client, tenantId, data);
        return { id: fila.id as number, fila };
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

  update(client: PoolClient, tenantId: string, id: number, data: EquipoPayload) {
    return EquiposRepository.update(client, tenantId, id, data);
  },

  delete(client: PoolClient, tenantId: string, id: number) {
    return EquiposRepository.delete(client, tenantId, id);
  },
};
