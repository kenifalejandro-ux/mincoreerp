/** src/modules/checklists/checklists.criticas.ts
 *
 * Qué preguntas son críticas en la versión del formato con que se llenó un checklist. Lo decide el servidor:
 * el dispositivo solo manda las respuestas. La versión con que se llenó puede ser anterior a la vigente (se
 * llenó sin señal), así que se lee su foto; un formato nunca editado no tiene fotos y se leen sus preguntas. */
import type { PoolClient } from "pg";

export async function preguntasCriticas(
  client: PoolClient,
  tenantId: string,
  plantillaId: number,
  version?: number
): Promise<Set<string>> {
  const foto = await client.query<{ items: { descripcion: string; critica?: boolean }[] }>(
    `SELECT v.items
       FROM checklist_plantillas p
       JOIN checklist_plantilla_versiones v
         ON v.plantilla_id = p.id AND v.tenant_id = p.tenant_id
        AND v.version = LEAST(COALESCE($3::int, p.version), p.version)
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [tenantId, plantillaId, version ?? null]
  );
  const items = foto.rows[0]
    ? foto.rows[0].items
    : (
        await client.query<{ descripcion: string; critica: boolean }>(
          `SELECT descripcion, critica FROM checklist_plantilla_items
            WHERE tenant_id = $1 AND plantilla_id = $2`,
          [tenantId, plantillaId]
        )
      ).rows;
  return new Set(items.filter((i) => i.critica).map((i) => i.descripcion.trim()));
}
