// src/server/shared/utils/adminsDeModulo.ts
//
// A quién avisarle de algo que pasó en un módulo: los admins del tenant que
// TIENEN ese módulo habilitado, tanto a nivel de tenant como de usuario (los
// dos pasos de habilitación, ver platform_module_control).
//
// Estaba en combustible.repository.ts con el módulo escrito a mano en el SQL.
// Se generalizó cuando Equipos necesitó avisarle a la gente de combustible
// que se le amplió el techo a un equipo -- ver alertaMailer.ts.

import type { PoolClient } from "pg";

export async function findAdminsConModulo(
  client: PoolClient,
  tenantId: string,
  modulo: string
): Promise<Array<{ id: string; email: string; nombre: string }>> {
  const result = await client.query<{ id: string; email: string; nombre: string }>(
    `
    SELECT u.id, u.email, u.nombre
    FROM usuarios u
    JOIN usuario_modulos um ON um.usuario_id = u.id AND um.modulo = $2
    JOIN tenant_modulos tm ON tm.tenant_id = u.tenant_id AND tm.modulo = $2
    WHERE u.tenant_id = $1 AND u.rol = 'admin' AND u.activo = true
      AND tm.estado = 'habilitado'
    `,
    [tenantId, modulo]
  );
  return result.rows;
}
