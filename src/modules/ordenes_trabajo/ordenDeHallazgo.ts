/** src/modules/ordenes_trabajo/ordenDeHallazgo.ts
 *
 * La orden de trabajo que nace sola de un checklist con una falla en un punto crítico (E5-2). Corre en la
 * MISMA transacción que guarda el checklist: o quedan los dos o ninguno, y el reintento de un envío (que
 * idempotentInsert corta antes de llegar aquí) no crea otra.
 *
 * NO respeta la cuota de órdenes, a propósito: es una falla crítica (seguridad) y se crea aunque la empresa
 * esté en su límite. Sí cuenta para el límite: las órdenes manuales siguen bloqueadas. */
import type { PoolClient } from "pg";

import { empresaTieneModulo } from "../../server/shared/utils/modulosEmpresa";

export interface Hallazgo {
  checklistId: number;
  equipoId: number | null;
  activoTexto: string | null;
  /** Cómo se nombra la unidad en el título: su placa/código, o el texto del activo. */
  nombreActivo: string;
  fallas: { descripcion: string; observacion?: string }[];
}

/** ¿La empresa quiere la orden automática? Hace falta Órdenes de trabajo. La regla «OT desde hallazgo
 *  crítico» es de Mantenimiento: sin ese módulo (o sin haberla tocado) queda encendida. */
async function pideOrdenAutomatica(client: PoolClient, tenantId: string) {
  if (!(await empresaTieneModulo(client, tenantId, "ordenes_trabajo"))) return false;
  if (!(await empresaTieneModulo(client, tenantId, "mantenimiento"))) return true;
  const regla = await client.query<{ ot_de_hallazgo: boolean }>(
    `SELECT ot_de_hallazgo FROM mantenimiento_config WHERE tenant_id = $1`,
    [tenantId]
  );
  return regla.rows[0]?.ot_de_hallazgo ?? true;
}

export async function crearOrdenDeHallazgo(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  hallazgo: Hallazgo
): Promise<number | null> {
  if (!(await pideOrdenAutomatica(client, tenantId))) return null;

  const detalle = hallazgo.fallas
    .map((f) => `- ${f.descripcion}${f.observacion ? `: ${f.observacion}` : ""}`)
    .join("\n");
  const r = await client.query<{ id: number }>(
    `INSERT INTO ordenes_trabajo
       (tenant_id, equipo_id, activo_texto, titulo, descripcion, tipo, prioridad, creado_por, origen, checklist_id)
     VALUES ($1, $2, $3, $4, $5, 'correctivo', 'urgente', $6, 'checklist', $7)
     RETURNING id`,
    [
      tenantId,
      hallazgo.equipoId,
      hallazgo.activoTexto,
      `Falla crítica en checklist: ${hallazgo.nombreActivo}`.slice(0, 150),
      `Puntos críticos que fallaron:\n${detalle}`.slice(0, 2000),
      usuarioId,
      hallazgo.checklistId,
    ]
  );
  return r.rows[0].id;
}
