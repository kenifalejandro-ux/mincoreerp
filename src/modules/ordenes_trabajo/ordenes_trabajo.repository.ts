/** src/modules/ordenes_trabajo/ordenes_trabajo.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  CrearOrdenTrabajoInput,
  ActualizarOrdenTrabajoInput,
  CambiarEstadoOrdenTrabajoInput,
} from "../../server/schemas/ordenes_trabajo.schema";
import { exigeConformidad } from "./ordenes_trabajo.conformidad";
import {
  columnasVecinas,
  condicionDeLista,
  type FiltrosDeOrdenes,
  type Vecinos,
} from "./ordenes_trabajo.consulta";
import { agregarTareas, listarTareas } from "./ordenes_trabajo.tareas";

interface FilaEstadoCambiado {
  id: number;
  estado: string;
  inicio_en: string | null;
  fecha_cierre: string | null;
  observaciones_cierre: string | null;
  duracion_minutos: number | null;
  requiere_conformidad: boolean;
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

/** Las horas no cuadran, o se quiso poner cierre a una orden que sigue abierta. El controller la responde
 *  con 400. */
export class HorasInvalidasError extends Error {}

const CONFORMIDAD = `ot.requiere_conformidad, ot.conformidad_en,
  (SELECT c.nombre FROM usuarios c WHERE c.id = ot.conformidad_por AND c.tenant_id = ot.tenant_id)
    AS conformidad_por_nombre`;

/** La duración en minutos: se calcula, no se guarda. */
const DURACION = (t: string) =>
  `floor(extract(epoch FROM (${t}.fecha_cierre - ${t}.inicio_en)) / 60)::int AS duracion_minutos`;

function exigirInicioAntesDelCierre(inicio: Date | null, cierre: Date | null) {
  if (inicio && cierre && inicio > cierre) {
    throw new HorasInvalidasError("La hora de inicio no puede ser posterior a la de cierre");
  }
}

/** De dónde sale la placa/código de la unidad. Sin un módulo de unidades (`conUnidades` falso) no se toca la tabla
 *  `equipos`: la columna va vacía y la orden se identifica por `activo_texto` (ver `opcionales` del
 *  módulo en registry.ts). Con Flota es LEFT JOIN: la orden puede no tener unidad (migración 0190). */
function unidadDeLaOrden(conUnidades: boolean) {
  return conUnidades
    ? { columna: "e.placa_codigo", join: "LEFT JOIN equipos e ON e.id = ot.equipo_id" }
    : { columna: "NULL::text AS placa_codigo", join: "" };
}

interface HorasDeLaOrden {
  estado: string;
  inicio_en: Date | null;
  fecha_cierre: Date | null;
  unidad_no_opera: boolean;
}

export const OrdenesTrabajoRepository = {
  async findAll(
    client: PoolClient,
    tenantId: string,
    { pageSize, offset }: Paginacion,
    filtros: FiltrosDeOrdenes,
    vecinos: Vecinos
  ) {
    const extra = columnasVecinas(vecinos);
    const { where, params } = condicionDeLista(tenantId, filtros, vecinos);
    params.push(pageSize, offset);

    const result = await client.query(
      `
      SELECT ot.id, ot.equipo_id, ${extra.columnas}, ot.activo_texto, ot.titulo, ot.descripcion,
        ot.tipo, ot.prioridad, ot.estado, ot.iperc_id, ot.creado_por,
        u.nombre AS creado_por_nombre, ot.asignado_a, asig.nombre AS asignado_a_nombre,
        ot.fecha_programada, ot.fecha_cierre, ot.observaciones_cierre, ot.creado_en, ot.origen,
        ot.checklist_id, ot.inicio_en, ot.unidad_no_opera, ${DURACION("ot")}, ${CONFORMIDAD},
        (SELECT count(*)::int FROM orden_trabajo_tareas t
          WHERE t.tenant_id = ot.tenant_id AND t.orden_trabajo_id = ot.id) AS tareas_total,
        (SELECT count(*)::int FROM orden_trabajo_tareas t
          WHERE t.tenant_id = ot.tenant_id AND t.orden_trabajo_id = ot.id AND t.hecha) AS tareas_hechas,
        COUNT(*) OVER() AS total_count
      FROM ordenes_trabajo ot
      ${extra.joins}
      JOIN usuarios u ON u.id = ot.creado_por
      LEFT JOIN usuarios asig ON asig.id = ot.asignado_a
      WHERE ${where}
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
         ot.fecha_programada, ot.fecha_cierre, ot.observaciones_cierre, ot.creado_en, ot.origen,
        ot.checklist_id, ot.inicio_en, ot.unidad_no_opera, ${DURACION("ot")}, ${CONFORMIDAD}
       FROM ordenes_trabajo ot
       ${unidad.join}
       JOIN usuarios u ON u.id = ot.creado_por
       LEFT JOIN usuarios asig ON asig.id = ot.asignado_a
       WHERE ot.id = $1 AND ot.tenant_id = $2`,
      [id, tenantId]
    );
    const orden = result.rows[0];
    if (!orden) return null;
    return { ...orden, tareas: await listarTareas(client, tenantId, id) };
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
         (tenant_id, equipo_id, activo_texto, titulo, descripcion, tipo, prioridad, iperc_id, creado_por, fecha_programada, asignado_a,
          inicio_en, unidad_no_opera)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, equipo_id, activo_texto, titulo, descripcion, tipo, prioridad, estado, iperc_id,
         creado_por, fecha_programada, fecha_cierre, observaciones_cierre, creado_en, asignado_a, origen,
         checklist_id, inicio_en, unidad_no_opera`,
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
        data.inicio_en ?? null,
        data.unidad_no_opera ?? false,
      ]
    );
    const orden = result.rows[0];
    await agregarTareas(client, tenantId, orden.id, data.tareas ?? []);
    return { ...orden, tareas: await listarTareas(client, tenantId, orden.id) };
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

    // Las horas se resuelven con la fila bloqueada: lo que no viene se queda como está, y dos
    // correcciones a la vez no dejan un inicio posterior al cierre.
    const bloqueada = await client.query<HorasDeLaOrden>(
      `SELECT estado, inicio_en, fecha_cierre, unidad_no_opera FROM ordenes_trabajo
        WHERE id = $1 AND tenant_id = $2 FOR NO KEY UPDATE`,
      [id, tenantId]
    );
    const antes = bloqueada.rows[0];
    if (!antes) return null;
    if (data.fecha_cierre !== undefined && antes.fecha_cierre === null) {
      throw new HorasInvalidasError("Solo se corrige la hora de cierre de una orden ya cerrada");
    }
    const horas = {
      antes,
      inicio:
        data.inicio_en === undefined
          ? antes.inicio_en
          : data.inicio_en === null
            ? null
            : new Date(data.inicio_en),
      cierre: data.fecha_cierre === undefined ? antes.fecha_cierre : new Date(data.fecha_cierre),
    };
    exigirInicioAntesDelCierre(horas.inicio, horas.cierre);

    const result = await client.query(
      `UPDATE ordenes_trabajo
       SET titulo = $1, descripcion = $2, tipo = $3, prioridad = $4, iperc_id = $5, fecha_programada = $6, asignado_a = $7,
         activo_texto = $10, inicio_en = $11, fecha_cierre = $12, unidad_no_opera = $13
       WHERE id = $8 AND tenant_id = $9
       RETURNING id, equipo_id, activo_texto, titulo, descripcion, tipo, prioridad, estado, iperc_id,
         creado_por, fecha_programada, fecha_cierre, observaciones_cierre, creado_en, asignado_a, origen,
         checklist_id, inicio_en, unidad_no_opera`,
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
        horas.inicio,
        horas.cierre,
        data.unidad_no_opera ?? horas.antes.unidad_no_opera,
      ]
    );
    const orden = result.rows[0];
    return orden ? { orden, antes: horas.antes } : null;
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
    { estado, observaciones_cierre, inicio_en, fecha_cierre }: CambiarEstadoOrdenTrabajoInput
  ): Promise<ResultadoCambiarEstado> {
    const origenes = ORIGENES_PERMITIDOS[estado];
    const esCierre = estado === "completada" || estado === "cancelada";

    // La fila bloqueada antes de comparar las horas: la segunda de dos transiciones a la vez ve el
    // estado que dejó la primera y recibe su 409.
    const bloqueada = await client.query<HorasDeLaOrden & { ahora: Date }>(
      `SELECT estado, inicio_en, fecha_cierre, unidad_no_opera, now() AS ahora FROM ordenes_trabajo
        WHERE id = $1 AND tenant_id = $2 FOR NO KEY UPDATE`,
      [id, tenantId]
    );
    const antes = bloqueada.rows[0];
    if (!antes) return { ok: false, motivo: "no_encontrado" };
    if (!origenes.includes(antes.estado)) {
      return { ok: false, motivo: "transicion_invalida", estadoActual: antes.estado };
    }
    // «Iniciar» anota la hora sola si nadie la escribió; después se puede corregir.
    const inicio = inicio_en
      ? new Date(inicio_en)
      : (antes.inicio_en ?? (estado === "en_progreso" ? antes.ahora : null));
    const cierre = esCierre ? (fecha_cierre ? new Date(fecha_cierre) : antes.ahora) : null;
    exigirInicioAntesDelCierre(inicio, cierre);

    // Se fija al completar: encender o apagar la regla después no cambia las órdenes ya cerradas.
    const conConformidad = estado === "completada" && (await exigeConformidad(client, tenantId));

    const result = await client.query<FilaEstadoCambiado>(
      `UPDATE ordenes_trabajo
       SET estado = $1,
         inicio_en = $2,
         fecha_cierre = CASE WHEN $3 THEN $4::timestamptz ELSE fecha_cierre END,
         observaciones_cierre = CASE WHEN $3 THEN $5 ELSE observaciones_cierre END,
         requiere_conformidad = $8
       WHERE id = $6 AND tenant_id = $7
       RETURNING id, estado, inicio_en, fecha_cierre, observaciones_cierre, requiere_conformidad, ${DURACION("ordenes_trabajo")}`,
      [estado, inicio, esCierre, cierre, observaciones_cierre ?? null, id, tenantId, conConformidad]
    );
    return { ok: true, fila: result.rows[0] };
  },

  async eliminar(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `DELETE FROM ordenes_trabajo WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  },
};
