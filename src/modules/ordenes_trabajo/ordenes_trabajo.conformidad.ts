/** src/modules/ordenes_trabajo/ordenes_trabajo.conformidad.ts
 *
 * La conformidad de una orden (M8): después de completarla, alguien prueba el equipo y la da, y recién ahí la
 * unidad queda libre. Quién: la persona que tenga la casilla «ordenes_trabajo:conformidad:dar» (hoy la marca
 * el administrador a la de SSOMA; nadie la trae por defecto) y nunca el mecánico asignado. Todo corre dentro
 * de `withTenant`. */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { empresaTieneModulo } from "../../server/shared/utils/modulosEmpresa";

/** La regla es de Mantenimiento: sin ese módulo (o sin haberla encendido) no se exige. */
export async function exigeConformidad(client: PoolClient, tenantId: string) {
  if (!(await empresaTieneModulo(client, tenantId, "mantenimiento"))) return false;
  const r = await client.query<{ exige_conformidad: boolean }>(
    `SELECT exige_conformidad FROM mantenimiento_config WHERE tenant_id = $1`,
    [tenantId]
  );
  return r.rows[0]?.exige_conformidad ?? false;
}

/** Devuelve cómo quedó (`cambio: false` si esta misma persona ya la había dado: un reenvío no se audita dos
 *  veces), o null si la orden no existe. */
export async function darConformidad(
  client: PoolClient,
  tenantId: string,
  ordenId: number,
  usuarioId: string
) {
  // La orden bloqueada: dos personas a la vez no la firman las dos.
  const r = await client.query<{
    estado: string;
    asignado_a: string | null;
    requiere_conformidad: boolean;
    conformidad_por: string | null;
    conformidad_en: Date | null;
  }>(
    `SELECT estado, asignado_a, requiere_conformidad, conformidad_por, conformidad_en
       FROM ordenes_trabajo WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [tenantId, ordenId]
  );
  const orden = r.rows[0];
  if (!orden) return null;
  if (orden.estado !== "completada" || !orden.requiere_conformidad) {
    throw new AppError(409, "Esta orden no está esperando conformidad");
  }
  if (orden.asignado_a === usuarioId) {
    throw new AppError(403, "La conformidad la da otra persona, no el mecánico de la orden");
  }
  if (orden.conformidad_en && orden.conformidad_por !== usuarioId) {
    throw new AppError(409, "La orden ya tiene conformidad");
  }
  const cambio = !orden.conformidad_en;
  const fila = await client.query<{
    id: number;
    conformidad_en: Date;
    conformidad_por_nombre: string;
  }>(
    `UPDATE ordenes_trabajo o
        SET conformidad_por = $3, conformidad_en = COALESCE(o.conformidad_en, now())
       FROM usuarios u
      WHERE o.tenant_id = $1 AND o.id = $2 AND u.tenant_id = o.tenant_id AND u.id = $3
      RETURNING o.id, o.conformidad_en, u.nombre AS conformidad_por_nombre`,
    [tenantId, ordenId, usuarioId]
  );
  return { cambio, orden: fila.rows[0] };
}

/** Cuántas personas pueden dar la conformidad hoy: activas, admin u operador, con la casilla y con Órdenes de
 *  trabajo en «Operar» (en «Consultas» o sin el módulo la ruta las rechaza). Con ninguna, las unidades no se
 *  liberan. */
export async function cuantosDanConformidad(client: PoolClient, tenantId: string) {
  const r = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM usuario_permisos_pestana p
       JOIN usuarios u ON u.id = p.usuario_id AND u.tenant_id = p.tenant_id
       JOIN usuario_modulos um
         ON um.usuario_id = u.id AND um.modulo = 'ordenes_trabajo' AND um.nivel = 'operar'
      WHERE p.tenant_id = $1 AND p.modulo = 'ordenes_trabajo' AND p.pestana = 'conformidad:dar'
        AND p.permitido AND u.activo AND u.rol IN ('admin', 'operador')`,
    [tenantId]
  );
  return r.rows[0].total;
}
