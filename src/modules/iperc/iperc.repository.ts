/** src/modules/iperc/iperc.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion, CursorPaginacion } from "../../server/shared/utils/pagination";
import type { CrearIpercInput, CrearLineaBaseInput } from "../../server/schemas/iperc.schema";

interface FilaEstadoCambiado {
  id: number;
  estado: string;
  aprobado_por: string;
  aprobado_en: string;
  /** Quién lo redactó. Solo lo devuelve el IPERC (no la línea base): sirve
   *  para marcar la autoaprobación. */
  usuario_id?: string | null;
}

/** Resultado de cambiarEstado()/cambiarEstadoLineaBase(): distingue "no
 *  existe" de "existe pero ya no está en borrador" -- antes el UPDATE no
 *  filtraba por estado actual, así que dos aprobaciones/rechazos
 *  simultáneos (ej. dos supervisores en el mismo IPERC) se pisaban en
 *  silencio: los dos requests devolvían 200, y ganaba el que commiteó
 *  último sin que nadie se enterara del conflicto. */
export type ResultadoCambiarEstado =
  | { ok: true; fila: FilaEstadoCambiado }
  | { ok: false; motivo: "no_encontrado" }
  | { ok: false; motivo: "ya_procesado"; estadoActual: string };

export const IpercRepository = {
  // Paginación por cursor (ver src/server/shared/utils/pagination.ts): la
  // otra tabla particionada además de checklists (migrations/0037).
  async findAll(
    client: PoolClient,
    tenantId: string,
    { pageSize, cursor }: CursorPaginacion,
    tipo?: string
  ) {
    const params: (string | number | null)[] = [tenantId, cursor];
    let filtroTipo = "";
    if (tipo) {
      params.push(tipo);
      filtroTipo = ` AND i.tipo = $${params.length}`;
    }
    params.push(pageSize + 1);

    const result = await client.query(
      `
      SELECT i.id, i.tipo, i.fecha, i.turno, i.area_frente, i.equipo_id, e.placa_codigo,
        i.linea_base_id, i.tarea_especifica,
        i.usuario_id, u.nombre AS usuario_nombre, i.estado,
        i.aprobado_por, ap.nombre AS aprobado_por_nombre, i.aprobado_en, i.creado_en
      FROM ipercs i
      JOIN usuarios u ON u.id = i.usuario_id
      LEFT JOIN equipos e ON e.id = i.equipo_id
      LEFT JOIN usuarios ap ON ap.id = i.aprobado_por
      WHERE i.tenant_id = $1 AND ($2::int IS NULL OR i.id < $2)${filtroTipo}
      ORDER BY i.id DESC
      LIMIT $${params.length}
    `,
      params
    );
    return result.rows;
  },

  async findById(client: PoolClient, tenantId: string, id: number) {
    const iperc = await client.query(
      `SELECT i.id, i.tipo, i.fecha, i.turno, i.area_frente, i.equipo_id, e.placa_codigo,
         i.linea_base_id, i.tarea_especifica,
         i.usuario_id, u.nombre AS usuario_nombre, i.estado,
         i.aprobado_por, ap.nombre AS aprobado_por_nombre, i.aprobado_en, i.creado_en
       FROM ipercs i
       JOIN usuarios u ON u.id = i.usuario_id
       LEFT JOIN equipos e ON e.id = i.equipo_id
       LEFT JOIN usuarios ap ON ap.id = i.aprobado_por
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [id, tenantId]
    );
    if (iperc.rows.length === 0) return null;

    const items = await client.query(
      `SELECT id, linea_base_item_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control
       FROM iperc_items
       WHERE iperc_id = $1 AND tenant_id = $2
       ORDER BY id ASC`,
      [id, tenantId]
    );

    return { ...iperc.rows[0], items: items.rows };
  },

  async crear(client: PoolClient, tenantId: string, usuarioId: string, data: CrearIpercInput) {
    const iperc = await client.query(
      `INSERT INTO ipercs (tenant_id, tipo, area_frente, turno, equipo_id, linea_base_id, tarea_especifica, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, tipo, fecha, turno, area_frente, equipo_id, linea_base_id, tarea_especifica, usuario_id, estado, creado_en`,
      [
        tenantId,
        data.tipo,
        data.area_frente,
        data.turno ?? null,
        data.equipo_id ?? null,
        data.linea_base_id ?? null,
        data.tarea_especifica ?? null,
        usuarioId,
      ]
    );
    const ipercId = iperc.rows[0].id;
    // ipercs está particionada por RANGE(creado_en) (migración 0037): la FK
    // de iperc_items es compuesta (iperc_id, iperc_creado_en) →
    // ipercs(id, creado_en). Ya vino gratis en el RETURNING de arriba.
    const ipercCreadoEn = iperc.rows[0].creado_en;

    const items = [];
    for (const item of data.items) {
      let { etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control } = item;

      // Si el ítem referencia un ítem de la línea base, se copian sus
      // campos desde el catálogo (mismo tenant) — nunca se confía en lo
      // que mande el cliente para esos campos, para que el registro
      // quede consistente con lo ya evaluado y aprobado.
      if (item.linea_base_item_id !== undefined) {
        const base = await client.query(
          `SELECT etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control
           FROM iperc_linea_base_items WHERE id = $1 AND tenant_id = $2`,
          [item.linea_base_item_id, tenantId]
        );
        if (base.rows.length === 0) {
          throw new Error(`linea_base_item_id ${item.linea_base_item_id} no existe en este tenant`);
        }
        ({ etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control } =
          base.rows[0]);
      }

      const result = await client.query(
        `INSERT INTO iperc_items (tenant_id, iperc_id, iperc_creado_en, linea_base_item_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, linea_base_item_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control`,
        [
          tenantId,
          ipercId,
          ipercCreadoEn,
          item.linea_base_item_id ?? null,
          etapa_actividad,
          peligro,
          riesgo,
          probabilidad,
          severidad,
          medidas_control,
        ]
      );
      items.push(result.rows[0]);
    }

    return { ...iperc.rows[0], items };
  },

  // WHERE ... AND estado = 'borrador' a propósito: sin ese filtro, dos
  // aprobaciones/rechazos que llegan casi al mismo tiempo se pisan en
  // silencio (el segundo UPDATE gana, sin que nadie se entere). Si el
  // UPDATE no afecta ninguna fila, el segundo SELECT distingue "no
  // existe" de "ya lo procesó otro" -- ver ResultadoCambiarEstado.
  async cambiarEstado(
    client: PoolClient,
    tenantId: string,
    id: number,
    estado: "aprobado" | "rechazado",
    aprobadoPor: string
  ): Promise<ResultadoCambiarEstado> {
    const result = await client.query<FilaEstadoCambiado>(
      `UPDATE ipercs SET estado = $1, aprobado_por = $2, aprobado_en = now()
       WHERE id = $3 AND tenant_id = $4 AND estado = 'borrador'
       -- usuario_id (quién lo redactó) viaja de vuelta para poder marcar la
       -- AUTOAPROBACIÓN: que el mismo que evaluó el riesgo sea el que lo
       -- aprueba no se bloquea --en una operación chica puede no haber otro--
       -- pero tiene que quedar dicho, que es de lo que se trata el control.
       RETURNING id, estado, aprobado_por, aprobado_en, usuario_id`,
      [estado, aprobadoPor, id, tenantId]
    );
    if (result.rows[0]) return { ok: true, fila: result.rows[0] };

    const actual = await client.query<{ estado: string }>(
      `SELECT estado FROM ipercs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (actual.rows.length === 0) return { ok: false, motivo: "no_encontrado" };
    return { ok: false, motivo: "ya_procesado", estadoActual: actual.rows[0].estado };
  },

  /** Borrar un IPERC SOLO si sigue en borrador.
   *
   *  Un IPERC aprobado es el registro de que alguien evaluó el riesgo de una
   *  tarea y lo autorizó: es el documento que se presenta ante una
   *  fiscalización o después de un accidente. Hasta la 5ª auditoría un admin
   *  podía borrarlo con un DELETE real --la fila desaparecía-- y en la
   *  bitácora quedaba "se eliminó el IPERC #12", sin su contenido.
   *
   *  Devuelve la fila borrada (para que la auditoría guarde de QUÉ se trataba)
   *  o el motivo del rechazo. */
  async eliminar(
    client: PoolClient,
    tenantId: string,
    id: number
  ): Promise<
    | { ok: true; fila: Record<string, unknown> }
    | { ok: false; motivo: "no_encontrado" | "aprobado"; estadoActual?: string }
  > {
    const result = await client.query<Record<string, unknown>>(
      `DELETE FROM ipercs WHERE id = $1 AND tenant_id = $2 AND estado = 'borrador'
       RETURNING id, tipo, area_frente, turno, equipo_id, linea_base_id, tarea_especifica,
                 usuario_id, estado, creado_en`,
      [id, tenantId]
    );
    if (result.rows[0]) return { ok: true, fila: result.rows[0] };

    const actual = await client.query<{ estado: string }>(
      `SELECT estado FROM ipercs WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (actual.rows.length === 0) return { ok: false, motivo: "no_encontrado" };
    return { ok: false, motivo: "aprobado", estadoActual: actual.rows[0].estado };
  },

  // ── Línea Base ───────────────────────────────────────────────────────
  async findLineasBase(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT id, proceso_actividad, area_frente, estado, aprobado_por, aprobado_en, creado_por, creado_en,
        COUNT(*) OVER() AS total_count
      FROM iperc_lineas_base
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `,
      [tenantId, pageSize, offset]
    );
    return result.rows;
  },

  async findLineaBaseConItems(client: PoolClient, tenantId: string, id: number) {
    const lineaBase = await client.query(
      `SELECT id, proceso_actividad, area_frente, estado, aprobado_por, aprobado_en, creado_por, creado_en
       FROM iperc_lineas_base WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (lineaBase.rows.length === 0) return null;

    const items = await client.query(
      `SELECT id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control
       FROM iperc_linea_base_items
       WHERE linea_base_id = $1 AND tenant_id = $2
       ORDER BY id ASC`,
      [id, tenantId]
    );

    return { ...lineaBase.rows[0], items: items.rows };
  },

  async crearLineaBase(
    client: PoolClient,
    tenantId: string,
    creadoPor: string,
    data: CrearLineaBaseInput
  ) {
    const lineaBase = await client.query(
      `INSERT INTO iperc_lineas_base (tenant_id, proceso_actividad, area_frente, creado_por)
       VALUES ($1, $2, $3, $4)
       RETURNING id, proceso_actividad, area_frente, estado, creado_por, creado_en`,
      [tenantId, data.proceso_actividad, data.area_frente ?? null, creadoPor]
    );
    const lineaBaseId = lineaBase.rows[0].id;

    const items = [];
    for (const item of data.items) {
      const result = await client.query(
        `INSERT INTO iperc_linea_base_items (tenant_id, linea_base_id, etapa_actividad, peligro, riesgo, probabilidad, severidad, medidas_control)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, etapa_actividad, peligro, riesgo, probabilidad, severidad, nivel_riesgo, medidas_control`,
        [
          tenantId,
          lineaBaseId,
          item.etapa_actividad,
          item.peligro,
          item.riesgo,
          item.probabilidad,
          item.severidad,
          item.medidas_control,
        ]
      );
      items.push(result.rows[0]);
    }

    return { ...lineaBase.rows[0], items };
  },

  // Mismo motivo que cambiarEstado() de arriba -- ver ese comentario.
  async cambiarEstadoLineaBase(
    client: PoolClient,
    tenantId: string,
    id: number,
    estado: "aprobado" | "rechazado",
    aprobadoPor: string
  ): Promise<ResultadoCambiarEstado> {
    const result = await client.query<FilaEstadoCambiado>(
      `UPDATE iperc_lineas_base SET estado = $1, aprobado_por = $2, aprobado_en = now()
       WHERE id = $3 AND tenant_id = $4 AND estado = 'borrador'
       RETURNING id, estado, aprobado_por, aprobado_en`,
      [estado, aprobadoPor, id, tenantId]
    );
    if (result.rows[0]) return { ok: true, fila: result.rows[0] };

    const actual = await client.query<{ estado: string }>(
      `SELECT estado FROM iperc_lineas_base WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (actual.rows.length === 0) return { ok: false, motivo: "no_encontrado" };
    return { ok: false, motivo: "ya_procesado", estadoActual: actual.rows[0].estado };
  },

  /** Mismo criterio que `eliminar` para el IPERC: una línea base APROBADA es
   *  el catálogo de peligros con el que se evalúan las tareas, y los IPERC
   *  ya emitidos la referencian. Borrarla deja esos IPERC hablando de una
   *  línea base que no existe. Solo se borra la que sigue en borrador, y la
   *  fila borrada vuelve para que la auditoría guarde su contenido. */
  async eliminarLineaBase(
    client: PoolClient,
    tenantId: string,
    id: number
  ): Promise<
    | { ok: true; fila: Record<string, unknown> }
    | { ok: false; motivo: "no_encontrado" | "aprobado"; estadoActual?: string }
  > {
    const result = await client.query<Record<string, unknown>>(
      `DELETE FROM iperc_lineas_base
        WHERE id = $1 AND tenant_id = $2 AND estado = 'borrador'
        RETURNING *`,
      [id, tenantId]
    );
    if (result.rows[0]) return { ok: true, fila: result.rows[0] };

    const actual = await client.query<{ estado: string }>(
      `SELECT estado FROM iperc_lineas_base WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (actual.rows.length === 0) return { ok: false, motivo: "no_encontrado" };
    return { ok: false, motivo: "aprobado", estadoActual: actual.rows[0].estado };
  },
};
