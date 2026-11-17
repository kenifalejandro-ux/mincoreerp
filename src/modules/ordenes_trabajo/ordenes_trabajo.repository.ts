/** src/modules/ordenes_trabajo/ordenes_trabajo.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  CrearOrdenTrabajoInput,
  ActualizarOrdenTrabajoInput,
} from "../../server/schemas/ordenes_trabajo.schema";

interface FilaEstadoCambiado {
  id: number;
  estado: string;
  fecha_cierre: string | null;
  observaciones_cierre: string | null;
}

/** Transiciones válidas: destino -> orígenes permitidos. 'abierta' no
 *  aparece como destino -- es solo el default de creación, nunca algo a lo
 *  que se "cambie estado". El UPDATE de cambiarEstado() filtra por
 *  `estado = ANY(orígenes)`, así que un salto no listado acá (ej.
 *  abierta -> completada) queda cubierto por el mismo WHERE que la guarda
 *  de carrera -- no hace falta una validación aparte. */
const ORIGENES_PERMITIDOS: Record<string, string[]> = {
  en_progreso: ["abierta"],
  completada: ["en_progreso"],
  cancelada: ["abierta", "en_progreso"],
};

/** Distingue "no existe" de "la transición no es válida desde el estado
 *  actual" (que incluye tanto un salto inválido como una carrera: dos
 *  personas cambiando estado casi al mismo tiempo) -- mismo criterio que
 *  ResultadoCambiarEstado de IPERC (fix_race_condition_iperc_estado). */
export type ResultadoCambiarEstado =
  | { ok: true; fila: FilaEstadoCambiado }
  | { ok: false; motivo: "no_encontrado" }
  | { ok: false; motivo: "transicion_invalida"; estadoActual: string };

/** Una orden SIN unidad que se quedaría sin texto de activo: no se puede identificar. El controller
 *  la responde con 400 (el CHECK de la migración 0190 sería un 500 de Postgres). */
export class OrdenSinActivoError extends Error {
  constructor() {
    super("Una orden sin unidad necesita el activo o lugar en texto");
  }
}

/** De dónde sale la placa/código de la unidad. Sin Flota (`conUnidades` falso) no se toca la tabla
 *  `equipos`: la columna va vacía y la orden se identifica por `activo_texto` (ver `opcionales` del
 *  módulo en registry.ts). Con Flota es LEFT JOIN: la orden puede no tener unidad (migración 0190). */
function unidadDeLaOrden(conUnidades: boolean) {
  return conUnidades
    ? { columna: "e.placa_codigo", join: "LEFT JOIN equipos e ON e.id = ot.equipo_id" }
    : { columna: "NULL::text AS placa_codigo", join: "" };
}

export const OrdenesTrabajoRepository = {
  async findAll(
    client: PoolClient,
    tenantId: string,
    { pageSize, offset }: Paginacion,
    filtros: { estado?: string; equipoId?: number; asignadoA?: string },
    conUnidades = true
  ) {
    const unidad = unidadDeLaOrden(conUnidades);
    const params: (string | number)[] = [tenantId];
    let filtro = "";
    if (filtros.estado) {
      params.push(filtros.estado);
      filtro += ` AND ot.estado = $${params.length}`;
    }
    // Sin Flota el filtro por unidad no existe: se ignora, no es un error.
    if (filtros.equipoId && conUnidades) {
      params.push(filtros.equipoId);
      filtro += ` AND ot.equipo_id = $${params.length}`;
    }
    if (filtros.asignadoA) {
      params.push(filtros.asignadoA);
      filtro += ` AND ot.asignado_a = $${params.length}`;
    }
    params.push(pageSize, offset);

    const result = await client.query(
      `
      SELECT ot.id, ot.equipo_id, ${unidad.columna}, ot.activo_texto, ot.titulo, ot.descripcion,
        ot.tipo, ot.prioridad, ot.estado, ot.iperc_id, ot.creado_por,
        u.nombre AS creado_por_nombre, ot.asignado_a, asig.nombre AS asignado_a_nombre,
        ot.fecha_programada, ot.fecha_cierre, ot.observaciones_cierre, ot.creado_en,
        COUNT(*) OVER() AS total_count
      FROM ordenes_trabajo ot
      ${unidad.join}
      JOIN usuarios u ON u.id = ot.creado_por
      LEFT JOIN usuarios asig ON asig.id = ot.asignado_a
      WHERE ot.tenant_id = $1${filtro}
      ORDER BY ot.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
      params
    );
    return result.rows;
  },

  async findById(client: PoolClient, tenantId: string, id: number, conUnidades = true) {
    const unidad = unidadDeLaOrden(conUnidades);
    const result = await client.query(
      `SELECT ot.id, ot.equipo_id, ${unidad.columna}, ot.activo_texto, ot.titulo, ot.descripcion,
         ot.tipo, ot.prioridad, ot.estado, ot.iperc_id, ot.creado_por,
         u.nombre AS creado_por_nombre, ot.asignado_a, asig.nombre AS asignado_a_nombre,
         ot.fecha_programada, ot.fecha_cierre, ot.observaciones_cierre, ot.creado_en
       FROM ordenes_trabajo ot
       ${unidad.join}
       JOIN usuarios u ON u.id = ot.creado_por
       LEFT JOIN usuarios asig ON asig.id = ot.asignado_a
       WHERE ot.id = $1 AND ot.tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  },

  /** Usuarios a los que se puede asignar una OT: activos del tenant, sin
   *  rol de solo-lectura (no tiene sentido operativo asignarle un ticket a
   *  alguien que no puede actuar sobre él). Query propia, no
   *  `listarUsuariosTenantService` de platform.service.ts -- esa devuelve
   *  TODOS los usuarios del tenant (activos e inactivos, cualquier rol),
   *  pensada para el panel de plataforma, no para un selector operativo. */
  async findUsuariosAsignables(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `SELECT id, nombre, email
       FROM usuarios
       WHERE tenant_id = $1 AND activo = true AND rol != 'lectura'
       ORDER BY nombre`,
      [tenantId]
    );
    return result.rows;
  },

  async crear(
    client: PoolClient,
    tenantId: string,
    creadoPor: string,
    data: CrearOrdenTrabajoInput
  ) {
    // Se valida ANTES del INSERT, con un mensaje distinguible, en vez de
    // dejar que la FK de Postgres tire un error genérico que el controller
    // no puede diferenciar de cualquier otra falla -- mismo criterio que
    // IpercRepository.crear con linea_base_item_id.
    // La unidad es opcional (0190): solo se valida si viene. El controller ya rechazó
    // `equipo_id` en una empresa sin Flota, así que acá nunca se lee `equipos` sin ese módulo.
    if (data.equipo_id !== undefined) {
      const equipo = await client.query(`SELECT 1 FROM equipos WHERE id = $1 AND tenant_id = $2`, [
        data.equipo_id,
        tenantId,
      ]);
      if (equipo.rows.length === 0) {
        throw new Error(`equipo_id ${data.equipo_id} no existe en este tenant`);
      }
    }
    if (data.iperc_id !== undefined) {
      const iperc = await client.query(`SELECT 1 FROM ipercs WHERE id = $1 AND tenant_id = $2`, [
        data.iperc_id,
        tenantId,
      ]);
      if (iperc.rows.length === 0) {
        throw new Error(`iperc_id ${data.iperc_id} no existe en este tenant`);
      }
    }
    if (data.asignado_a !== undefined) {
      const asignado = await client.query(
        `SELECT 1 FROM usuarios WHERE id = $1 AND tenant_id = $2 AND activo = true`,
        [data.asignado_a, tenantId]
      );
      if (asignado.rows.length === 0) {
        throw new Error(`asignado_a ${data.asignado_a} no existe en este tenant`);
      }
    }

    const result = await client.query(
      `INSERT INTO ordenes_trabajo
         (tenant_id, equipo_id, activo_texto, titulo, descripcion, tipo, prioridad, iperc_id, creado_por, fecha_programada, asignado_a)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, equipo_id, activo_texto, titulo, descripcion, tipo, prioridad, estado, iperc_id,
         creado_por, fecha_programada, fecha_cierre, observaciones_cierre, creado_en, asignado_a`,
      [
        tenantId,
        data.equipo_id ?? null,
        data.activo_texto || null,
        data.titulo,
        data.descripcion ?? null,
        data.tipo,
        data.prioridad,
        data.iperc_id ?? null,
        creadoPor,
        data.fecha_programada ?? null,
        data.asignado_a ?? null,
      ]
    );
    return result.rows[0];
  },

  async actualizar(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarOrdenTrabajoInput
  ) {
    // Una orden sin unidad no puede quedarse sin texto de activo (el CHECK de 0190 daría un 500).
    const activoTexto = data.activo_texto || null;
    if (!activoTexto) {
      const actual = await client.query<{ equipo_id: number | null }>(
        `SELECT equipo_id FROM ordenes_trabajo WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (actual.rows[0] && actual.rows[0].equipo_id === null) throw new OrdenSinActivoError();
    }
    if (data.iperc_id !== undefined) {
      const iperc = await client.query(`SELECT 1 FROM ipercs WHERE id = $1 AND tenant_id = $2`, [
        data.iperc_id,
        tenantId,
      ]);
      if (iperc.rows.length === 0) {
        throw new Error(`iperc_id ${data.iperc_id} no existe en este tenant`);
      }
    }
    if (data.asignado_a !== undefined) {
      const asignado = await client.query(
        `SELECT 1 FROM usuarios WHERE id = $1 AND tenant_id = $2 AND activo = true`,
        [data.asignado_a, tenantId]
      );
      if (asignado.rows.length === 0) {
        throw new Error(`asignado_a ${data.asignado_a} no existe en este tenant`);
      }
    }

    const result = await client.query(
      `UPDATE ordenes_trabajo
       SET titulo = $1, descripcion = $2, tipo = $3, prioridad = $4, iperc_id = $5, fecha_programada = $6, asignado_a = $7,
         activo_texto = $10
       WHERE id = $8 AND tenant_id = $9
       RETURNING id, equipo_id, activo_texto, titulo, descripcion, tipo, prioridad, estado, iperc_id,
         creado_por, fecha_programada, fecha_cierre, observaciones_cierre, creado_en, asignado_a`,
      [
        data.titulo,
        data.descripcion ?? null,
        data.tipo,
        data.prioridad,
        data.iperc_id ?? null,
        data.fecha_programada ?? null,
        data.asignado_a ?? null,
        id,
        tenantId,
        activoTexto,
      ]
    );
    return result.rows[0] ?? null;
  },

  // WHERE ... AND estado = ANY(orígenes permitidos) a propósito: cubre a la
  // vez una transición estructuralmente inválida (saltar de 'abierta' a
  // 'completada') y la carrera real (dos personas cambiando estado casi al
  // mismo tiempo) -- mismo problema que resolvió fix_race_condition_iperc_estado,
  // acá con más de un origen posible por destino.
  async cambiarEstado(
    client: PoolClient,
    tenantId: string,
    id: number,
    estado: "en_progreso" | "completada" | "cancelada",
    observacionesCierre?: string
  ): Promise<ResultadoCambiarEstado> {
    const origenes = ORIGENES_PERMITIDOS[estado];
    const esCierre = estado === "completada" || estado === "cancelada";

    const result = await client.query<FilaEstadoCambiado>(
      `UPDATE ordenes_trabajo
       SET estado = $1,
         fecha_cierre = CASE WHEN $2 THEN now() ELSE fecha_cierre END,
         observaciones_cierre = CASE WHEN $2 THEN $3 ELSE observaciones_cierre END
       WHERE id = $4 AND tenant_id = $5 AND estado = ANY($6::varchar[])
       RETURNING id, estado, fecha_cierre, observaciones_cierre`,
      [estado, esCierre, observacionesCierre ?? null, id, tenantId, origenes]
    );
    if (result.rows[0]) return { ok: true, fila: result.rows[0] };

    const actual = await client.query<{ estado: string }>(
      `SELECT estado FROM ordenes_trabajo WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    if (actual.rows.length === 0) return { ok: false, motivo: "no_encontrado" };
    return { ok: false, motivo: "transicion_invalida", estadoActual: actual.rows[0].estado };
  },

  async eliminar(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `DELETE FROM ordenes_trabajo WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  },
};
