/** src/modules/checklists/checklists.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion, CursorPaginacion } from "../../server/shared/utils/pagination";
import { AppError } from "../../server/shared/middlewares/error.middleware";
import { empresaTieneModulo } from "../../server/shared/utils/modulosEmpresa";

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
      SELECT id, nombre, tipo_equipo, creado_en, version, activa, COUNT(*) OVER() AS total_count
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
      `SELECT id, nombre, tipo_equipo, creado_en, version, activa FROM checklist_plantillas
       WHERE id = $1 AND tenant_id = $2`,
      [plantillaId, tenantId]
    );
    if (plantilla.rows.length === 0) return null;

    const items = await client.query(
      `SELECT id, descripcion, orden, critica FROM checklist_plantilla_items
       WHERE plantilla_id = $1 AND tenant_id = $2
       ORDER BY orden ASC, id ASC`,
      [plantillaId, tenantId]
    );

    return { ...plantilla.rows[0], items: items.rows };
  },

  async crearPlantilla(
    client: PoolClient,
    tenantId: string,
    data: {
      nombre: string;
      tipo_equipo?: string;
      items: { descripcion: string; orden?: number; critica?: boolean }[];
    }
  ) {
    const plantilla = await client.query(
      `INSERT INTO checklist_plantillas (tenant_id, nombre, tipo_equipo)
       VALUES ($1, $2, $3)
       RETURNING id, nombre, tipo_equipo, creado_en, version, activa`,
      [tenantId, data.nombre, data.tipo_equipo ?? null]
    );
    const plantillaId = plantilla.rows[0].id;

    const items = [];
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const result = await client.query(
        `INSERT INTO checklist_plantilla_items (tenant_id, plantilla_id, descripcion, orden, critica)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, descripcion, orden, critica`,
        [tenantId, plantillaId, item.descripcion, item.orden ?? i, item.critica ?? false]
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
      SELECT c.id, c.equipo_id, ${unidad.columna}, c.activo_texto, c.plantilla_id, c.plantilla_version, c.usuario_id,
        u.nombre AS usuario_nombre, c.fecha, c.turno, c.resultado,
        c.observaciones_generales, c.lectura_valor::float8 AS lectura_valor, c.aviso_registro,
        c.creado_en,
        -- La orden que generó (también la de uno enviado desde la cola sin señal), solo si la
        -- empresa tiene Órdenes de trabajo.
        (SELECT ot.id FROM ordenes_trabajo ot
          WHERE ot.tenant_id = c.tenant_id AND ot.checklist_id = c.id
            AND EXISTS (SELECT 1 FROM tenant_modulos tm
                         WHERE tm.tenant_id = c.tenant_id AND tm.modulo = 'ordenes_trabajo'
                           AND tm.estado <> 'deshabilitado')) AS orden_trabajo_id
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
      `SELECT c.id, c.equipo_id, ${unidad.columna}, c.activo_texto, c.plantilla_id, c.plantilla_version, c.usuario_id,
         u.nombre AS usuario_nombre, c.fecha, c.turno, c.resultado,
         c.observaciones_generales, c.lectura_valor::float8 AS lectura_valor, c.aviso_registro,
         c.creado_en
       FROM checklists c
       ${unidad.join}
       JOIN usuarios u ON u.id = c.usuario_id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [id, tenantId]
    );
    if (checklist.rows.length === 0) return null;

    const items = await client.query(
      `SELECT id, descripcion, estado, observacion, critica FROM checklist_items
       WHERE checklist_id = $1 AND tenant_id = $2
       ORDER BY id ASC`,
      [id, tenantId]
    );

    return {
      ...checklist.rows[0],
      orden_trabajo_id: await this.ordenGenerada(client, tenantId, id),
      items: items.rows,
    };
  },

  async crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: {
      equipo_id?: number;
      activo_texto?: string;
      plantilla_id: number;
      plantilla_version?: number;
      turno?: string;
      observaciones_generales?: string;
      lectura?: { valor: number };
      items: {
        descripcion: string;
        estado: "bien" | "malo" | "na";
        observacion?: string;
        critica: boolean;
      }[];
    }
  ) {
    // Calculado por la app antes de insertar, no declarado por el usuario: si falló un punto
    // crítico la unidad es "no_apta"; si falló otro, "observado".
    const fallas = data.items.filter((i) => i.estado === "malo");
    const resultado = fallas.some((i) => i.critica)
      ? "no_apta"
      : fallas.length > 0
        ? "observado"
        : "bien";

    const checklist = await client.query(
      `INSERT INTO checklists (tenant_id, equipo_id, activo_texto, plantilla_id, usuario_id, turno, resultado,
         observaciones_generales, plantilla_version, lectura_valor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
         -- Nunca una versión que el formato todavía no tiene.
         (SELECT LEAST(COALESCE($9::int, version), version) FROM checklist_plantillas
           WHERE tenant_id = $1 AND id = $4), $10)
       RETURNING id, equipo_id, activo_texto, plantilla_id, plantilla_version, usuario_id, fecha, turno, resultado,
         observaciones_generales, lectura_valor::float8 AS lectura_valor, creado_en`,
      [
        tenantId,
        data.equipo_id ?? null,
        data.activo_texto || null,
        data.plantilla_id,
        usuarioId,
        data.turno ?? null,
        resultado,
        data.observaciones_generales ?? null,
        data.plantilla_version ?? null,
        data.lectura?.valor ?? null,
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
        `INSERT INTO checklist_items
           (tenant_id, checklist_id, checklist_creado_en, descripcion, estado, observacion, critica)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, descripcion, estado, observacion, critica`,
        [
          tenantId,
          checklistId,
          checklistCreadoEn,
          item.descripcion,
          item.estado,
          item.observacion ?? null,
          item.critica,
        ]
      );
      items.push(result.rows[0]);
    }

    return { ...checklist.rows[0], items };
  },

  /** Cómo nombrar la unidad de un checklist: su placa/código, o el texto del activo. Solo se llama con
   *  `equipo_id` cuando la empresa mantiene unidades (el controller rechaza lo contrario). */
  async nombreDelActivo(
    client: PoolClient,
    tenantId: string,
    data: { equipo_id?: number; activo_texto?: string }
  ): Promise<string> {
    if (data.equipo_id !== undefined) {
      const r = await client.query<{ placa_codigo: string }>(
        `SELECT placa_codigo FROM equipos WHERE tenant_id = $1 AND id = $2`,
        [tenantId, data.equipo_id]
      );
      if (!r.rows[0]) throw new AppError(400, "La unidad no existe");
      return r.rows[0].placa_codigo;
    }
    return data.activo_texto ?? "";
  },

  async guardarAviso(client: PoolClient, tenantId: string, id: number, aviso: string) {
    await client.query(
      `UPDATE checklists SET aviso_registro = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, aviso]
    );
  },

  /** La orden que generó este checklist, si la empresa tiene Órdenes de trabajo. */
  async ordenGenerada(client: PoolClient, tenantId: string, id: number): Promise<number | null> {
    if (!(await empresaTieneModulo(client, tenantId, "ordenes_trabajo"))) return null;
    const r = await client.query<{ id: number }>(
      `SELECT id FROM ordenes_trabajo WHERE tenant_id = $1 AND checklist_id = $2`,
      [tenantId, id]
    );
    return r.rows[0]?.id ?? null;
  },

  async eliminar(client: PoolClient, tenantId: string, id: number) {
    // La orden que generó sigue existiendo; solo pierde el enlace (no hay FK que lo haga).
    await client.query(
      `UPDATE ordenes_trabajo SET checklist_id = NULL WHERE tenant_id = $1 AND checklist_id = $2`,
      [tenantId, id]
    );
    const result = await client.query(`DELETE FROM checklists WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },
};
