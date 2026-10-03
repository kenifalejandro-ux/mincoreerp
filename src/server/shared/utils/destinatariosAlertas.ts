// src/server/shared/utils/destinatariosAlertas.ts
//
// A quién se le avisa por correo de algo que pasó en un módulo.
//
// Reemplaza a `findAdminsConModulo` (adminsDeModulo.ts), que deducía el
// destinatario de ser administrador. Ser admin y querer los avisos son dos
// cosas distintas, y confundirlas falla en las dos direcciones: el jefe de
// planta que mira los tanques todo el día no recibía nada, y el admin de
// sistemas recibía todo hasta que se armaba un filtro en el correo -- la
// forma más silenciosa de que una alerta deje de existir.
//
// Desde la migración 0107 el destinatario es un dato explícito por persona y
// por módulo (`usuario_alertas_correo.recibe_alertas`), que se edita en
// Administración → Configuración.

import type { PoolClient } from "pg";

export interface DestinatarioDeAlerta {
  id: string;
  email: string;
  nombre: string;
}

/** Los módulos que HOY mandan correos de alerta. La tabla y la consulta son
 *  genéricas, pero la pantalla y el aviso de "nadie lo recibe" solo tienen
 *  sentido para módulos que de verdad envían algo: ofrecer una casilla para
 *  Checklists, que no manda nada, es una promesa falsa. Un módulo nuevo que
 *  empiece a avisar por correo se suma acá, y nada más cambia. */
export const MODULOS_CON_ALERTAS_POR_CORREO: readonly string[] = ["combustible"];

/** Los cuatro filtros son independientes y los cuatro hacen falta:
 *
 *  1. `recibe_alertas` -- lo pidió explícitamente. Sin fila no se avisa: no
 *     hay default por rol (ver el encabezado de 0107).
 *  2. `usuario_modulos` -- sigue teniendo el módulo. A quien se le quitó el
 *     acceso no se le siguen mandando los movimientos del módulo, aunque la
 *     marca haya quedado.
 *  3. `tenant_modulos.estado = 'habilitado'` -- la empresa lo tiene activo.
 *  4. `email IS NOT NULL` -- desde 0084 el personal de cancha entra con DNI y
 *     no tiene correo. Un destinatario sin correo haría que nodemailer reciba
 *     un `to` nulo y se caiga el envío ENTERO, o sea que una sola persona mal
 *     configurada dejaría sin aviso a todos los demás de la lista.
 */
export async function findDestinatariosAlertas(
  client: PoolClient,
  tenantId: string,
  modulo: string
): Promise<DestinatarioDeAlerta[]> {
  const result = await client.query<DestinatarioDeAlerta>(
    `
    SELECT u.id, u.email, u.nombre
    FROM usuarios u
    JOIN usuario_alertas_correo a
      ON a.usuario_id = u.id AND a.tenant_id = u.tenant_id
     AND a.modulo = $2::modulo_erp AND a.recibe_alertas
    JOIN usuario_modulos um ON um.usuario_id = u.id AND um.modulo = $2::modulo_erp
    JOIN tenant_modulos tm ON tm.tenant_id = u.tenant_id AND tm.modulo = $2::modulo_erp
    WHERE u.tenant_id = $1 AND u.activo = true
      AND tm.estado = 'habilitado'
      AND u.email IS NOT NULL
    ORDER BY u.nombre
    `,
    [tenantId, modulo]
  );
  return result.rows;
}

/** Los módulos habilitados QUE ENVÍAN ALERTAS y a los que no les quedó ningún
 *  destinatario: nadie se va a enterar de sus alertas por correo. Lo usa la
 *  pantalla para avisarlo mientras el admin configura. */
export async function modulosSinDestinatarios(
  client: PoolClient,
  tenantId: string
): Promise<string[]> {
  const result = await client.query<{ modulo: string }>(
    `
    SELECT tm.modulo
      FROM tenant_modulos tm
     WHERE tm.tenant_id = $1 AND tm.estado = 'habilitado'
       AND tm.modulo::text = ANY($2::text[])
       AND NOT EXISTS (
         SELECT 1
           FROM usuario_alertas_correo a
           JOIN usuarios u ON u.id = a.usuario_id AND u.tenant_id = a.tenant_id
           JOIN usuario_modulos um ON um.usuario_id = u.id AND um.modulo = tm.modulo
          WHERE a.tenant_id = $1 AND a.modulo = tm.modulo AND a.recibe_alertas
            AND u.activo = true AND u.email IS NOT NULL
       )
     ORDER BY tm.modulo
    `,
    [tenantId, MODULOS_CON_ALERTAS_POR_CORREO]
  );
  return result.rows.map((fila) => fila.modulo);
}
