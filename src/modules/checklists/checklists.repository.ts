/** src/modules/checklists/checklists.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion, CursorPaginacion } from "../../server/shared/utils/pagination";

/** De dónde sale la placa/código de la unidad. Sin un módulo de unidades (`conUnidades` falso) no se toca la tabla
 *  `equipos`: la columna va vacía y el checklist se identifica por `activo_texto` (ver
 *  `opcionales` del módulo en registry.ts). Con Flota es LEFT JOIN: el checklist puede no tener
 *  unidad (migración 0189). */
function unidadDelChecklist(conUnidades: boolean) {
  return conUnidades
    ? { columna: "e.placa_codigo", join: "LEFT JOIN equipos e ON e.id = c.equipo_id" }
    : { columna: "NULL::text AS placa_codigo", join: "" };
}

export const ChecklistsRepository = {
  // ── Plantillas ───────────────────────────────────────────────────────
  async findPlantillas(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT id, nombre, tipo_equipo, creado_en, COUNT(*) OVER() AS total_count
      FROM checklist_plantillas
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `,
      [tenantId, pageSize, offset]
    );
    return result.rows;
  },

  async findPlantillaConItems(client: PoolClient, tenantId: string, plantillaId: number) {
    const plantilla = await client.query(
      `SELECT id, nombre, tipo_equipo, creado_en FROM checklist_plantillas WHERE id = $1 AND tenant_id = $2`,
      [plantillaId, tenantId]
    );
    if (plantilla.rows.length === 0) return null;

    const items = await client.query(
      `SELECT id, descripcion, orden FROM checklist_plantilla_items
       WHERE plantilla_id = $1 AND tenant_id = $2
       ORDER BY orden ASC, id ASC`,
      [plantillaId, tenantId]
    );

    return { ...plantilla.rows[0], items: items.rows };
  },

  async crearPlantilla(
    client: PoolClient,
    tenantId: string,
    data: { nombre: string; tipo_equipo?: string; items: { descripcion: string; orden?: number }[] }
  ) {
    const plantilla = await client.query(
      `INSERT INTO checklist_plantillas (tenant_id, nombre, tipo_equipo)
       VALUES ($1, $2, $3)
       RETURNING id, nombre, tipo_equipo, creado_en`,
      [tenantId, data.nombre, data.tipo_equipo ?? null]
    );
    const plantillaId = plantilla.rows[0].id;

    const items = [];
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const result = await client.query(
        `INSERT INTO checklist_plantilla_items (tenant_id, plantilla_id, descripcion, orden)
         VALUES ($1, $2, $3, $4)
         RETURNING id, descripcion, orden`,
        [tenantId, plantillaId, item.descripcion, item.orden ?? i]
      );
      items.push(result.rows[0]);
    }

    return { ...plantilla.rows[0], items };
  },

  async eliminarPlantilla(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `DELETE FROM checklist_plantillas WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  },

  // ── Checklists llenados ──────────────────────────────────────────────
  // Paginación por cursor (ver src/server/shared/utils/pagination.ts): esta
  // es una de las dos tablas particionadas (migrations/0037), la única con
  // volumen que puede crecer sin techo natural por tenant.
  async findAll(
    client: PoolClient,
    tenantId: string,
    { pageSize, cursor }: CursorPaginacion,
    conUnidades = true
  ) {
    const unidad = unidadDelChecklist(conUnidades);
    const result = await client.query(
      `
      SELECT c.id, c.equipo_id, ${unidad.columna}, c.activo_texto, c.plantilla_id, c.usuario_id,
        u.nombre AS usuario_nombre, c.fecha, c.turno, c.resultado,
        c.observaciones_generales, c.creado_en
      FROM checklists c
      ${unidad.join}
      JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.tenant_id = $1 AND ($2::int IS NULL OR c.id < $2)
      ORDER BY c.id DESC
      LIMIT $3
    `,
      [tenantId, cursor, pageSize + 1]
    );
    return result.rows;
  },

  async findById(client: PoolClient, tenantId: string, id: number, conUnidades = true) {
    const unidad = unidadDelChecklist(conUnidades);
    const checklist = await client.query(
      `SELECT c.id, c.equipo_id, ${unidad.columna}, c.activo_texto, c.plantilla_id, c.usuario_id,
         u.nombre AS usuario_nombre, c.fecha, c.turno, c.resultado,
         c.observaciones_generales, c.creado_en
       FROM checklists c
       ${unidad.join}
       JOIN usuarios u ON u.id = c.usuario_id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [id, tenantId]
    );
    if (checklist.rows.length === 0) return null;

    const items = await client.query(
      `SELECT id, descripcion, estado, observacion FROM checklist_items
       WHERE checklist_id = $1 AND tenant_id = $2
       ORDER BY id ASC`,
      [id, tenantId]
    );

    return { ...checklist.rows[0], items: items.rows };
  },

  async crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: {
      equipo_id?: number;
      activo_texto?: string;
      plantilla_id: number;
      turno?: string;
      observaciones_generales?: string;
      items: { descripcion: string; estado: "bien" | "malo" | "na"; observacion?: string }[];
    }
  ) {
    // Calculado por la app antes de insertar, no declarado por el usuario:
    // si algún ítem quedó "malo", el checklist entero queda "observado".
    const resultado = data.items.some((i) => i.estado === "malo") ? "observado" : "bien";

    const checklist = await client.query(
      `INSERT INTO checklists (tenant_id, equipo_id, activo_texto, plantilla_id, usuario_id, turno, resultado, observaciones_generales)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, equipo_id, activo_texto, plantilla_id, usuario_id, fecha, turno, resultado, observaciones_generales, creado_en`,
      [
        tenantId,
        data.equipo_id ?? null,
        data.activo_texto || null,
        data.plantilla_id,
        usuarioId,
        data.turno ?? null,
        resultado,
        data.observaciones_generales ?? null,
      ]
    );
    const checklistId = checklist.rows[0].id;
    // checklists está particionada por RANGE(creado_en) (migración 0037):
    // la FK de checklist_items es compuesta (checklist_id, checklist_creado_en)
    // → checklists(id, creado_en), así que hace falta este valor acá. Ya
    // vino gratis en el RETURNING del INSERT de arriba, sin query extra.
    const checklistCreadoEn = checklist.rows[0].creado_en;

    const items = [];
    for (const item of data.items) {
      const result = await client.query(
        `INSERT INTO checklist_items (tenant_id, checklist_id, checklist_creado_en, descripcion, estado, observacion)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, descripcion, estado, observacion`,
        [
          tenantId,
          checklistId,
          checklistCreadoEn,
          item.descripcion,
          item.estado,
          item.observacion ?? null,
        ]
      );
      items.push(result.rows[0]);
    }

    return { ...checklist.rows[0], items };
  },

  async eliminar(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(`DELETE FROM checklists WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },
};
