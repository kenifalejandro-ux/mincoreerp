/** src/modules/ordenes_trabajo/ordenes_trabajo.tareas.ts
 *
 * Las tareas de una orden de trabajo (E5-5): una lista, cada una hecha o pendiente. Se pueden cargar al
 * crear la orden (también sin señal) y cambiar después solo con señal. Todo corre dentro de `withTenant`. */
import type { PoolClient } from "pg";

import type { CambiarTareasInput } from "../../server/schemas/ordenes_trabajo.schema";
import { AppError } from "../../server/shared/middlewares/error.middleware";

export const TOPE_DE_TAREAS = 50;

export async function listarTareas(client: PoolClient, tenantId: string, ordenId: number) {
  const r = await client.query<{ id: number; descripcion: string; hecha: boolean }>(
    `SELECT id, descripcion, hecha FROM orden_trabajo_tareas
      WHERE tenant_id = $1 AND orden_trabajo_id = $2
      ORDER BY orden, id`,
    [tenantId, ordenId]
  );
  return r.rows;
}

export async function agregarTareas(
  client: PoolClient,
  tenantId: string,
  ordenId: number,
  tareas: { descripcion: string; hecha?: boolean }[]
) {
  if (tareas.length === 0) return;
  await client.query(
    `INSERT INTO orden_trabajo_tareas (tenant_id, orden_trabajo_id, descripcion, hecha, orden)
     SELECT $1::uuid, $2::int, t.descripcion, t.hecha,
            COALESCE((SELECT max(orden) FROM orden_trabajo_tareas
                       WHERE tenant_id = $1 AND orden_trabajo_id = $2), -1) + t.n::int
       FROM unnest($3::text[], $4::boolean[]) WITH ORDINALITY AS t(descripcion, hecha, n)`,
    [tenantId, ordenId, tareas.map((t) => t.descripcion), tareas.map((t) => t.hecha ?? false)]
  );
}

/** Agrega, marca y quita en una sola vez. Cada cambio toca solo su tarea: dos personas marcando tareas
 *  distintas no se pisan. Devuelve la lista como quedó, o null si la orden no existe. */
export async function cambiarTareas(
  client: PoolClient,
  tenantId: string,
  ordenId: number,
  cambios: CambiarTareasInput
) {
  // La orden bloqueada: dos altas a la vez no pasan juntas el tope.
  const orden = await client.query(
    `SELECT 1 FROM ordenes_trabajo WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [tenantId, ordenId]
  );
  if (orden.rows.length === 0) return null;

  for (const m of cambios.marcar) {
    const r = await client.query(
      `UPDATE orden_trabajo_tareas SET hecha = $4
        WHERE tenant_id = $1 AND orden_trabajo_id = $2 AND id = $3`,
      [tenantId, ordenId, m.id, m.hecha]
    );
    if (r.rowCount === 0) throw new AppError(404, "Esa tarea no es de esta orden");
  }
  if (cambios.quitar.length > 0) {
    await client.query(
      `DELETE FROM orden_trabajo_tareas
        WHERE tenant_id = $1 AND orden_trabajo_id = $2 AND id = ANY($3::int[])`,
      [tenantId, ordenId, cambios.quitar]
    );
  }
  await agregarTareas(client, tenantId, ordenId, cambios.agregar);
  const tareas = await listarTareas(client, tenantId, ordenId);
  if (tareas.length > TOPE_DE_TAREAS) {
    throw new AppError(400, `Una orden admite hasta ${TOPE_DE_TAREAS} tareas`);
  }
  return tareas;
}
