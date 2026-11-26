/** src/modules/checklists/checklists.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion, CursorPaginacion } from "../../server/shared/utils/pagination";
import { AppError } from "../../server/shared/middlewares/error.middleware";

/** De dónde sale la placa/código de la unidad. Sin un módulo de unidades (`conUnidades` falso) no se toca la tabla
 *  `equipos`: la columna va vacía y el checklist se identifica por `activo_texto` (ver
 *  `opcionales` del módulo en registry.ts). Con Flota es LEFT JOIN: el checklist puede no tener
 *  unidad (migración 0189). */
/** Las órdenes que nacieron de un checklist o que ya cubrían alguna de sus fallas. Solo si la empresa tiene
 *  Órdenes de trabajo. `c` es la tabla `checklists` de la consulta. */
const ORDENES_DEL_CHECKLIST = `ARRAY(
  SELECT x.id FROM (
    SELECT ot.id FROM ordenes_trabajo ot WHERE ot.tenant_id = c.tenant_id AND ot.checklist_id = c.id
    UNION
    SELECT h.orden_trabajo_id FROM orden_trabajo_hallazgos h
     WHERE h.tenant_id = c.tenant_id AND h.checklist_id = c.id
  ) x
  WHERE EXISTS (SELECT 1 FROM tenant_modulos tm
                 WHERE tm.tenant_id = c.tenant_id AND tm.modulo = 'ordenes_trabajo'
                   AND tm.estado <> 'deshabilitado')
  ORDER BY x.id) AS ordenes_trabajo`;

const SALIDA = `c.salida, c.salida_en, c.salida_motivo,
  (SELECT d.nombre FROM usuarios d WHERE d.id = c.salida_por AND d.tenant_id = c.tenant_id) AS salida_por_nombre`;

/** Los puntos que fallaron, en el orden en que se preguntaron; null si ninguno. */
const FALLAS = `(SELECT string_agg(i.descripcion, ', ' ORDER BY i.id) FROM checklist_items i
  WHERE i.tenant_id = c.tenant_id AND i.checklist_id = c.id AND i.estado = 'malo') AS fallas`;

export interface FiltrosDeChecklists {
  soloPorAutorizar?: boolean;
  /** Busca en el número, la unidad o activo, quién lo llenó y los puntos que fallaron. */
  q?: string;
  resultado?: "bien" | "observado" | "no_apta";
}

/** Lo escrito se busca tal cual: «%» y «_» no son comodines. */
const contiene = (texto: string) => `%${texto.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;

/** `orden_trabajo_id` es la primera de la lista (la pantalla la muestra). */
const conOrden = <T extends { ordenes_trabajo: number[] }>(fila: T) => ({
  ...fila,
  orden_trabajo_id: fila.ordenes_trabajo[0] ?? null,
});

function unidadDelChecklist(conUnidades: boolean) {
  return conUnidades
    ? { columna: "e.placa_codigo", join: "LEFT JOIN equipos e ON e.id = c.equipo_id" }
    : { columna: "NULL::text AS placa_codigo", join: "" };
}

export const ChecklistsRepository = {
  // ── Plantillas ───────────────────────────────────────────────────────
  async findPlantillas(
    client: PoolClient,
    tenantId: string,
    { pageSize, offset }: Paginacion,
    conUnidades = true
  ) {
    // Cuántas unidades activas usan cada formato: las de su tipo, o todas si es de uso general. null sin un
    // módulo de unidades (no es lo mismo que cero).
    const unidades = conUnidades
      ? `(SELECT count(*)::int FROM equipos e
           WHERE e.tenant_id = p.tenant_id AND e.activo
             AND (NULLIF(trim(p.tipo_equipo), '') IS NULL
                  OR lower(trim(p.tipo_equipo)) = lower(trim(e.tipo))))`
      : "NULL::int";
    const result = await client.query(
      `
      SELECT p.id, p.nombre, p.tipo_equipo, p.creado_en, p.version, p.activa,
        cuenta.preguntas, cuenta.criticas, ${unidades} AS unidades,
        COALESCE(v.creado_en, p.creado_en) AS editado_en,
        (SELECT d.nombre FROM usuarios d
          WHERE d.id = v.creado_por AND d.tenant_id = p.tenant_id) AS editado_por_nombre,
        COUNT(*) OVER() AS total_count
      FROM checklist_plantillas p
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS preguntas, count(*) FILTER (WHERE i.critica)::int AS criticas
          FROM checklist_plantilla_items i
         WHERE i.tenant_id = p.tenant_id AND i.plantilla_id = p.id) cuenta
      LEFT JOIN checklist_plantilla_versiones v
        ON v.tenant_id = p.tenant_id AND v.plantilla_id = p.id AND v.version = p.version
      WHERE p.tenant_id = $1
      ORDER BY p.id DESC
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
    conUnidades = true,
    { soloPorAutorizar = false, q, resultado }: FiltrosDeChecklists = {}
  ) {
    const unidad = unidadDelChecklist(conUnidades);
    // «#12» y «12» encuentran el checklist 12.
    const numero = q && /^#?\d{1,9}$/.test(q) ? Number(q.replace("#", "")) : null;
    // Sin un módulo de unidades no se busca por placa: esa tabla no se toca.
    const porPlaca = conUnidades ? "OR lower(e.placa_codigo) LIKE $5" : "";
    const result = await client.query(
      `
      SELECT c.id, c.equipo_id, ${unidad.columna}, c.activo_texto, c.plantilla_id, c.plantilla_version, c.usuario_id,
        u.nombre AS usuario_nombre, c.fecha, c.turno, c.resultado,
        c.observaciones_generales, c.lectura_valor::float8 AS lectura_valor, c.aviso_registro,
        c.creado_en, ${SALIDA}, ${ORDENES_DEL_CHECKLIST}, ${FALLAS}
      FROM checklists c
      ${unidad.join}
      JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.tenant_id = $1 AND ($2::int IS NULL OR c.id < $2)
        AND ($4::boolean IS FALSE OR c.salida = 'por_autorizar')
        AND ($5::text IS NULL OR c.id = $6::int
             OR lower(c.activo_texto) LIKE $5 OR lower(u.nombre) LIKE $5 ${porPlaca}
             OR EXISTS (SELECT 1 FROM checklist_items i
                         WHERE i.tenant_id = c.tenant_id AND i.checklist_id = c.id
                           AND i.estado = 'malo' AND lower(i.descripcion) LIKE $5))
        AND ($7::text IS NULL OR c.resultado = $7)
      ORDER BY c.id DESC
      LIMIT $3
    `,
      [
        tenantId,
        cursor,
        pageSize + 1,
        soloPorAutorizar,
        q ? contiene(q) : null,
        numero,
        resultado ?? null,
      ]
    );
    return result.rows.map(conOrden);
  },

  /** Cuántos checklists llegaron hoy (hora de Perú), en total y por resultado. */
  async deHoy(client: PoolClient, tenantId: string) {
    const r = await client.query<{
      total: number;
      bien: number;
      observado: number;
      no_apta: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE resultado = 'bien')::int AS bien,
              count(*) FILTER (WHERE resultado = 'observado')::int AS observado,
              count(*) FILTER (WHERE resultado = 'no_apta')::int AS no_apta
         FROM checklists
        WHERE tenant_id = $1 AND creado_en >= date_trunc('day', now(), 'America/Lima')`,
      [tenantId]
    );
    return r.rows[0];
  },

  async findById(client: PoolClient, tenantId: string, id: number, conUnidades = true) {
    const unidad = unidadDelChecklist(conUnidades);
    const checklist = await client.query(
      `SELECT c.id, c.equipo_id, ${unidad.columna}, c.activo_texto, c.plantilla_id, c.plantilla_version, c.usuario_id,
         u.nombre AS usuario_nombre, c.fecha, c.turno, c.resultado,
         c.observaciones_generales, c.lectura_valor::float8 AS lectura_valor, c.aviso_registro,
         c.creado_en, ${SALIDA}, ${ORDENES_DEL_CHECKLIST}
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

    return { ...conOrden(checklist.rows[0]), items: items.rows };
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
         observaciones_generales, plantilla_version, lectura_valor, salida)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
         -- Nunca una versión que el formato todavía no tiene.
         (SELECT LEAST(COALESCE($9::int, version), version) FROM checklist_plantillas
           WHERE tenant_id = $1 AND id = $4), $10, $11)
       RETURNING id, equipo_id, activo_texto, plantilla_id, plantilla_version, usuario_id, fecha, turno, resultado,
         observaciones_generales, lectura_valor::float8 AS lectura_valor, salida, creado_en`,
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
        // Falla crítica: no sale. Falla menor: alguien tiene que decidirlo.
        resultado === "no_apta" ? "no_sale" : resultado === "observado" ? "por_autorizar" : "libre",
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

  async eliminar(client: PoolClient, tenantId: string, id: number) {
    // La orden que generó sigue existiendo; solo pierde el enlace (no hay FK que lo haga).
    await client.query(
      `UPDATE ordenes_trabajo SET checklist_id = NULL WHERE tenant_id = $1 AND checklist_id = $2`,
      [tenantId, id]
    );
    await client.query(
      `UPDATE orden_trabajo_hallazgos SET checklist_id = NULL
        WHERE tenant_id = $1 AND checklist_id = $2`,
      [tenantId, id]
    );
    const result = await client.query(`DELETE FROM checklists WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },
};
