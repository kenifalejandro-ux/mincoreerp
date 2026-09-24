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
import { EquiposRepository, type EquipoPayload } from "./equipos.repository";

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
  create(client: PoolClient, tenantId: string, data: CrearEquipoInput) {
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
