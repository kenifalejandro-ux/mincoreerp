/** src/modules/ordenes_trabajo/ordenes_trabajo.asignacion.ts
 *
 * Asignar o quitar el mecánico de una orden (M8) sin tocar nada más. El PUT de la orden reemplaza la fila
 * entera (lo que no viene queda vacío); esto cambia solo `asignado_a`. Corre dentro de `withTenant`. */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";

/** Devuelve quién quedó y quién estaba (`cambio: false` si ya era así: un reenvío no se audita dos veces), o
 *  null si la orden no existe. */
export async function asignarOrden(
  client: PoolClient,
  tenantId: string,
  ordenId: number,
  asignadoA: string | null
) {
  // La orden bloqueada: no se asigna una que otra persona está cerrando en este momento.
  const orden = await client.query<{ estado: string; asignado_a: string | null }>(
    `SELECT estado, asignado_a FROM ordenes_trabajo
      WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [tenantId, ordenId]
  );
  const antes = orden.rows[0];
  if (!antes) return null;
  if (antes.estado !== "abierta" && antes.estado !== "en_progreso") {
    throw new AppError(409, "La orden ya está cerrada: su mecánico no se cambia");
  }

  let nombre: string | null = null;
  if (asignadoA !== null) {
    const mecanico = await client.query<{ nombre: string }>(
      `SELECT nombre FROM usuarios
        WHERE tenant_id = $1 AND id = $2 AND activo AND rol = 'mecanico'`,
      [tenantId, asignadoA]
    );
    if (!mecanico.rows[0]) {
      throw new AppError(400, "Solo se asigna a una persona activa con perfil Mecánico");
    }
    nombre = mecanico.rows[0].nombre;
  }

  const cambio = (antes.asignado_a ?? null) !== (asignadoA?.toLowerCase() ?? null);
  if (cambio) {
    await client.query(
      `UPDATE ordenes_trabajo SET asignado_a = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ordenId, asignadoA]
    );
  }
  return {
    cambio,
    antes: antes.asignado_a,
    orden: { id: ordenId, asignado_a: asignadoA, asignado_a_nombre: nombre },
  };
}
