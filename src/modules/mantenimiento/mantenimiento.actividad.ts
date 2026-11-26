/** src/modules/mantenimiento/mantenimiento.actividad.ts
 *
 * «Actividad del turno» del Centro (M6): los últimos movimientos de checklists y órdenes de trabajo, con el
 * efecto de cada uno. No hay tabla propia: se arma al consultar, desde las fechas que ya guardan esos módulos.
 * El servidor manda datos; los textos los arma la pantalla.
 *
 * El efecto cuenta lo que PASÓ (qué orden quedó ligada a la falla) o cómo está HOY (si la orden sigue abierta,
 * si la unidad volvió a operar). Por eso no se lee la regla «OT desde hallazgo»: puede haber cambiado después.
 *
 * Cada fuente se lee solo si la persona tiene su módulo (`Fuentes`). */
import type { PoolClient } from "pg";

import { estadosDeUnidades, type EstadoDeUnidad, type Fuentes } from "./mantenimiento.estado";

export const MOVIMIENTOS = 8;
export const DIAS_DE_ACTIVIDAD = 7;

/** Entre las dos puntas: una hora escrita a mano en el futuro todavía no pasó. */
const reciente = (columna: string) =>
  `${columna} >= now() - interval '${DIAS_DE_ACTIVIDAD} days' AND ${columna} <= now()`;

export type Movimiento = { en: Date; unidad: string | null } & (
  | {
      tipo: "checklist";
      checklist_id: number;
      resultado: "bien" | "observado" | "no_apta";
      fallas: string | null;
      /** Sigue esperando que alguien decida la salida. */
      por_autorizar: boolean;
      /** La orden que generó, o la que ya estaba abierta y recibió la falla. null sin orden o sin el módulo. */
      orden: { id: number; nueva: boolean } | null;
    }
  | {
      tipo: "salida";
      checklist_id: number;
      autorizada: boolean;
      fallas: string | null;
    }
  | {
      tipo: "orden_creada" | "orden_iniciada" | "orden_cerrada";
      orden_id: number;
      titulo: string;
      /** El estado de la orden hoy. */
      estado: "abierta" | "en_progreso" | "completada" | "cancelada";
      /** Urgente o «no puede operar». */
      detiene: boolean;
      sin_mecanico: boolean;
      desde_checklist: boolean;
      /** Cómo está hoy la unidad; null si la orden es de un activo escrito a mano o de un equipo quitado. */
      unidad_hoy: EstadoDeUnidad | null;
    }
);

const FALLAS = `(SELECT string_agg(i.descripcion, ', ' ORDER BY i.id) FROM checklist_items i
   WHERE i.tenant_id = c.tenant_id AND i.checklist_id = c.id AND i.estado = 'malo')`;

async function deChecklists(
  client: PoolClient,
  tenantId: string,
  conOrdenes: boolean
): Promise<Movimiento[]> {
  // Sin Órdenes de trabajo no se consulta ninguna de sus tablas.
  const orden = conOrdenes
    ? `(SELECT json_build_object('id', x.id, 'nueva', x.nueva) FROM (
          SELECT o.id, true AS nueva FROM ordenes_trabajo o
           WHERE o.tenant_id = c.tenant_id AND o.checklist_id = c.id
          UNION ALL
          SELECT h.orden_trabajo_id, false FROM orden_trabajo_hallazgos h
           WHERE h.tenant_id = c.tenant_id AND h.checklist_id = c.id) x
        ORDER BY x.nueva DESC, x.id DESC LIMIT 1)`
    : "NULL::json";
  const enviados = await client.query(
    `SELECT c.creado_en AS en, c.id::int AS checklist_id, c.resultado,
            COALESCE(c.salida = 'por_autorizar', false) AS por_autorizar,
            COALESCE(e.placa_codigo, c.activo_texto) AS unidad, ${FALLAS} AS fallas, ${orden} AS orden
       FROM (SELECT * FROM checklists
              WHERE tenant_id = $1 AND ${reciente("creado_en")}
              ORDER BY creado_en DESC, id DESC LIMIT ${MOVIMIENTOS}) c
       LEFT JOIN equipos e ON e.tenant_id = c.tenant_id AND e.id = c.equipo_id`,
    [tenantId]
  );
  const decididos = await client.query(
    `SELECT c.salida_en AS en, c.id::int AS checklist_id, (c.salida = 'autorizada') AS autorizada,
            COALESCE(e.placa_codigo, c.activo_texto) AS unidad, ${FALLAS} AS fallas
       FROM (SELECT * FROM checklists
              WHERE tenant_id = $1 AND salida IN ('autorizada', 'rechazada') AND ${reciente("salida_en")}
              ORDER BY salida_en DESC, id DESC LIMIT ${MOVIMIENTOS}) c
       LEFT JOIN equipos e ON e.tenant_id = c.tenant_id AND e.id = c.equipo_id`,
    [tenantId]
  );
  return [
    ...enviados.rows.map((r) => ({ tipo: "checklist" as const, ...r })),
    ...decididos.rows.map((r) => ({ tipo: "salida" as const, ...r })),
  ];
}

/** Cada orden deja hasta tres movimientos: se creó, se inició y se cerró. */
const MOMENTOS = [
  { tipo: "orden_creada", columna: "creado_en" },
  { tipo: "orden_iniciada", columna: "inicio_en" },
  { tipo: "orden_cerrada", columna: "fecha_cierre" },
] as const;

async function deOrdenes(
  client: PoolClient,
  tenantId: string,
  fuentes: Fuentes
): Promise<Movimiento[]> {
  const filas = [];
  for (const { tipo, columna } of MOMENTOS) {
    const r = await client.query(
      // A milisegundos como `checklists.creado_en` (que redondea): sin esto, la orden que nace con un
      // checklist queda a veces un milisegundo «antes» que él.
      `SELECT o.${columna}::timestamptz(3) AS en, o.id::int AS orden_id, o.titulo, o.estado,
              (o.prioridad = 'urgente' OR o.unidad_no_opera) AS detiene,
              (o.asignado_a IS NULL) AS sin_mecanico, (o.origen = 'checklist') AS desde_checklist,
              COALESCE(e.placa_codigo, o.activo_texto) AS unidad,
              CASE WHEN e.activo THEN e.id::int END AS equipo_id
         FROM ordenes_trabajo o
         LEFT JOIN equipos e ON e.tenant_id = o.tenant_id AND e.id = o.equipo_id
        WHERE o.tenant_id = $1 AND ${reciente(`o.${columna}`)}
        ORDER BY o.${columna} DESC, o.id DESC LIMIT ${MOVIMIENTOS}`,
      [tenantId]
    );
    filas.push(...r.rows.map((o) => ({ tipo, ...o })));
  }
  if (filas.length === 0) return [];
  const estadoDe = await estadosDeUnidades(client, tenantId, fuentes);
  return filas.map(({ equipo_id, ...o }) => ({
    ...o,
    unidad_hoy: equipo_id === null ? null : estadoDe(equipo_id).estado,
  }));
}

/** A la misma hora (un checklist y la orden que genera nacen juntos), la consecuencia va arriba. */
const PASO: Record<Movimiento["tipo"], number> = {
  checklist: 0,
  salida: 1,
  orden_creada: 2,
  orden_iniciada: 3,
  orden_cerrada: 4,
};
const idDe = (m: Movimiento) => ("orden_id" in m ? m.orden_id : m.checklist_id);

export async function actividadReciente(client: PoolClient, tenantId: string, fuentes: Fuentes) {
  const movimientos = [
    ...(fuentes.conChecklists ? await deChecklists(client, tenantId, fuentes.conOrdenes) : []),
    ...(fuentes.conOrdenes ? await deOrdenes(client, tenantId, fuentes) : []),
  ];
  movimientos.sort(
    (a, b) => b.en.getTime() - a.en.getTime() || PASO[b.tipo] - PASO[a.tipo] || idDe(b) - idDe(a)
  );
  return { movimientos: movimientos.slice(0, MOVIMIENTOS) };
}
