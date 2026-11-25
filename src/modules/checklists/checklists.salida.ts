/** src/modules/checklists/checklists.salida.ts
 *
 * La salida de una unidad con fallas menores la decide una persona con el permiso «Autoriza la salida de
 * unidades»: con motivo, una sola vez y nunca sobre su propio checklist. */
import type { PoolClient } from "pg";

import type { DecidirSalidaInput } from "../../server/schemas/checklists.schema";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { empresaTieneModulo } from "../../server/shared/utils/modulosEmpresa";
import { ordenarFallas } from "../ordenes_trabajo/ordenDeHallazgo";
import { ChecklistsRepository } from "./checklists.repository";

export async function decidirSalida(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  checklistId: number,
  data: DecidirSalidaInput
) {
  // La fila bloqueada: de dos decisiones a la vez, la segunda ve la primera y recibe su 409.
  const actual = await client.query<{
    salida: string | null;
    usuario_id: string;
    equipo_id: number | null;
    activo_texto: string | null;
  }>(
    `SELECT salida, usuario_id, equipo_id, activo_texto FROM checklists
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, checklistId]
  );
  const checklist = actual.rows[0];
  if (!checklist) return null;
  if (checklist.salida !== "por_autorizar") {
    throw new AppError(409, "Este checklist no está esperando autorización");
  }
  if (checklist.usuario_id === usuarioId) {
    throw new AppError(403, "No puedes decidir la salida de un checklist que llenaste tú");
  }

  await client.query(
    `UPDATE checklists SET salida = $3, salida_por = $4, salida_en = now(), salida_motivo = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, checklistId, data.autoriza ? "autorizada" : "rechazada", usuarioId, data.motivo]
  );

  // Si no sale, la orden es obligada; si sale, solo si quien autoriza la pide para después.
  let ordenNueva: number | null = null;
  const quiereOrden = !data.autoriza || data.crear_orden;
  if (quiereOrden && (await empresaTieneModulo(client, tenantId, "ordenes_trabajo"))) {
    const fallas = await client.query<{ descripcion: string; observacion: string | null }>(
      `SELECT descripcion, observacion FROM checklist_items
        WHERE tenant_id = $1 AND checklist_id = $2 AND estado = 'malo' ORDER BY id`,
      [tenantId, checklistId]
    );
    ordenNueva = await ordenarFallas(
      client,
      tenantId,
      usuarioId,
      {
        checklistId,
        equipoId: checklist.equipo_id,
        activoTexto: checklist.activo_texto,
        nombreActivo: await ChecklistsRepository.nombreDelActivo(client, tenantId, {
          equipo_id: checklist.equipo_id ?? undefined,
          activo_texto: checklist.activo_texto ?? undefined,
        }),
        fallas: fallas.rows,
      },
      data.autoriza
        ? { titulo: "Falla por atender", prioridad: "media", noOpera: false }
        : { titulo: "Salida no autorizada", prioridad: "alta", noOpera: true }
    );
  }
  return { ordenNueva, equipoId: checklist.equipo_id };
}
