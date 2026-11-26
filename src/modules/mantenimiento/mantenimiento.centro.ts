/** src/modules/mantenimiento/mantenimiento.centro.ts
 *
 * Lo que el Centro de control (M6) calcula al abrirse: el estado de las unidades (en total y por área), las
 * órdenes de trabajo y los checklists. No guarda nada.
 *
 * Cada bloque de otro módulo se lee solo si la persona lo tiene (`Fuentes`); sin él la consulta no se ejecuta
 * y el bloque va en `null`, que no es lo mismo que cero.
 *
 * «Hoy» y «este mes» son los de Perú, y cuentan desde que el registro llegó al servidor: un checklist llenado
 * sin señal cuenta el día en que se envió. */
import type { PoolClient } from "pg";

import { estadosDeUnidades, type EstadoDeUnidad, type Fuentes } from "./mantenimiento.estado";

/** Cuántos casos se nombran en cada aviso; el total va aparte y cuenta todos. */
export const CASOS_POR_AVISO = 5;

const HOY_DESDE = `date_trunc('day', now(), 'America/Lima')`;
const MES_DESDE = `date_trunc('month', now(), 'America/Lima')`;
const ORDEN_ABIERTA = `estado IN ('abierta', 'en_progreso')`;

export interface UnidadDelCentro {
  id: number;
  placa: string;
  estado: EstadoDeUnidad;
  alquilada: boolean;
}

export interface AreaDelCentro {
  /** null junta a las unidades sin área. */
  area_id: number | null;
  nombre: string | null;
  unidades: UnidadDelCentro[];
}

export interface Aviso<T> {
  total: number;
  casos: T[];
}

export interface OrdenSinMecanico {
  id: number;
  unidad: string | null;
  titulo: string;
  urgente: boolean;
}

export interface OrdenesDelCentro {
  abiertas: number;
  urgentes: number;
  sin_mecanico: Aviso<OrdenSinMecanico> & { urgentes: number };
  /** Creadas este mes, sin contar las canceladas. */
  del_mes: { correctivo: number; preventivo: number };
}

export interface ChecklistDelCentro {
  id: number;
  unidad: string | null;
  fallas: string | null;
}

export interface ChecklistsDelCentro {
  /** Equipos con al menos un checklist hoy. */
  hechos_hoy: number;
  /** Equipos con un formato activo que les aplica (general o de su tipo) y sin checklist hoy. */
  sin_checklist_hoy: Aviso<string>;
  no_aptos_hoy: Aviso<ChecklistDelCentro>;
  /** Esperan que alguien decida la salida, sean de hoy o de antes. */
  por_autorizar: Aviso<ChecklistDelCentro>;
}

/** Las unidades activas con su estado, repartidas por área: las áreas por nombre y «sin área» al final. */
async function unidadesPorArea(
  client: PoolClient,
  tenantId: string,
  fuentes: Fuentes
): Promise<AreaDelCentro[]> {
  const r = await client.query<{
    id: number;
    placa: string;
    alquilada: boolean;
    area_id: number | null;
    nombre: string | null;
  }>(
    `SELECT e.id::int AS id, e.placa_codigo AS placa,
            COALESCE(d.propiedad = 'alquilada', false) AS alquilada,
            a.id::int AS area_id, a.nombre
       FROM equipos e
       LEFT JOIN mantenimiento_equipo_datos d ON d.tenant_id = e.tenant_id AND d.equipo_id = e.id
       LEFT JOIN mantenimiento_areas a ON a.tenant_id = d.tenant_id AND a.id = d.area_id
      WHERE e.tenant_id = $1 AND e.activo
      ORDER BY lower(a.nombre) NULLS LAST, a.id, lower(e.placa_codigo), e.id`,
    [tenantId]
  );
  const estadoDe = await estadosDeUnidades(client, tenantId, fuentes);
  const areas = new Map<number | null, AreaDelCentro>();
  for (const { id, placa, alquilada, area_id, nombre } of r.rows) {
    let area = areas.get(area_id);
    if (!area) areas.set(area_id, (area = { area_id, nombre, unidades: [] }));
    area.unidades.push({ id, placa, alquilada, estado: estadoDe(id).estado });
  }
  return [...areas.values()];
}

/** Cuenta todas las órdenes de la empresa, también las de un activo escrito a mano (sin equipo). */
async function ordenesDelCentro(client: PoolClient, tenantId: string): Promise<OrdenesDelCentro> {
  const cifras = await client.query<{
    abiertas: number;
    urgentes: number;
    sin_mecanico: number;
    sin_mecanico_urgentes: number;
    correctivo: number;
    preventivo: number;
  }>(
    `SELECT count(*) FILTER (WHERE ${ORDEN_ABIERTA})::int AS abiertas,
            count(*) FILTER (WHERE ${ORDEN_ABIERTA} AND prioridad = 'urgente')::int AS urgentes,
            count(*) FILTER (WHERE ${ORDEN_ABIERTA} AND asignado_a IS NULL)::int AS sin_mecanico,
            count(*) FILTER (WHERE ${ORDEN_ABIERTA} AND asignado_a IS NULL
                               AND prioridad = 'urgente')::int AS sin_mecanico_urgentes,
            count(*) FILTER (WHERE tipo = 'correctivo' AND estado <> 'cancelada'
                               AND creado_en >= ${MES_DESDE})::int AS correctivo,
            count(*) FILTER (WHERE tipo = 'preventivo' AND estado <> 'cancelada'
                               AND creado_en >= ${MES_DESDE})::int AS preventivo
       FROM ordenes_trabajo
      WHERE tenant_id = $1`,
    [tenantId]
  );
  const casos = await client.query<OrdenSinMecanico>(
    `SELECT o.id::int AS id, COALESCE(e.placa_codigo, o.activo_texto) AS unidad, o.titulo,
            (o.prioridad = 'urgente') AS urgente
       FROM ordenes_trabajo o
       LEFT JOIN equipos e ON e.tenant_id = o.tenant_id AND e.id = o.equipo_id
      WHERE o.tenant_id = $1 AND o.${ORDEN_ABIERTA} AND o.asignado_a IS NULL
      ORDER BY urgente DESC, o.id DESC
      LIMIT ${CASOS_POR_AVISO}`,
    [tenantId]
  );
  const c = cifras.rows[0];
  return {
    abiertas: c.abiertas,
    urgentes: c.urgentes,
    sin_mecanico: { total: c.sin_mecanico, urgentes: c.sin_mecanico_urgentes, casos: casos.rows },
    del_mes: { correctivo: c.correctivo, preventivo: c.preventivo },
  };
}

/** Los checklists que cumplen `condicion` (texto fijo de este archivo, nunca de fuera), los últimos primero.
 *  `soloCriticas` nombra solo las fallas críticas. */
async function checklistsQue(
  client: PoolClient,
  tenantId: string,
  condicion: string,
  soloCriticas: boolean
): Promise<Aviso<ChecklistDelCentro>> {
  const r = await client.query<ChecklistDelCentro & { total: number }>(
    `SELECT c.id::int AS id, COALESCE(e.placa_codigo, c.activo_texto) AS unidad, c.total,
            (SELECT string_agg(i.descripcion, ', ' ORDER BY i.id) FROM checklist_items i
              WHERE i.tenant_id = c.tenant_id AND i.checklist_id = c.id AND i.estado = 'malo'
                ${soloCriticas ? "AND i.critica" : ""}) AS fallas
       FROM (SELECT tenant_id, id, equipo_id, activo_texto, count(*) OVER ()::int AS total
               FROM checklists
              WHERE tenant_id = $1 AND ${condicion}
              ORDER BY id DESC
              LIMIT ${CASOS_POR_AVISO}) c
       LEFT JOIN equipos e ON e.tenant_id = c.tenant_id AND e.id = c.equipo_id
      ORDER BY c.id DESC`,
    [tenantId]
  );
  return {
    total: r.rows[0]?.total ?? 0,
    casos: r.rows.map(({ id, unidad, fallas }) => ({ id, unidad, fallas })),
  };
}

async function checklistsDelCentro(
  client: PoolClient,
  tenantId: string
): Promise<ChecklistsDelCentro> {
  const equipos = await client.query<{ placa: string; hecho: boolean; le_toca: boolean }>(
    `WITH hoy AS (
       SELECT DISTINCT equipo_id FROM checklists
        WHERE tenant_id = $1 AND equipo_id IS NOT NULL AND creado_en >= ${HOY_DESDE})
     SELECT e.placa_codigo AS placa, (h.equipo_id IS NOT NULL) AS hecho,
            EXISTS (SELECT 1 FROM checklist_plantillas p
                     WHERE p.tenant_id = e.tenant_id AND p.activa
                       AND (NULLIF(trim(p.tipo_equipo), '') IS NULL
                            OR lower(trim(p.tipo_equipo)) = lower(trim(e.tipo)))) AS le_toca
       FROM equipos e
       LEFT JOIN hoy h ON h.equipo_id = e.id
      WHERE e.tenant_id = $1 AND e.activo
      ORDER BY lower(e.placa_codigo), e.id`,
    [tenantId]
  );
  const faltan = equipos.rows.filter((e) => e.le_toca && !e.hecho).map((e) => e.placa);
  return {
    hechos_hoy: equipos.rows.filter((e) => e.hecho).length,
    sin_checklist_hoy: { total: faltan.length, casos: faltan.slice(0, CASOS_POR_AVISO) },
    no_aptos_hoy: await checklistsQue(
      client,
      tenantId,
      `resultado = 'no_apta' AND creado_en >= ${HOY_DESDE}`,
      true
    ),
    por_autorizar: await checklistsQue(client, tenantId, `salida = 'por_autorizar'`, false),
  };
}

export async function centroDeControl(client: PoolClient, tenantId: string, fuentes: Fuentes) {
  const estado_por_area = await unidadesPorArea(client, tenantId, fuentes);
  const unidades = estado_por_area.flatMap((a) => a.unidades);
  const cuantas = (estado: EstadoDeUnidad) => unidades.filter((u) => u.estado === estado).length;
  return {
    estados: {
      operativas: cuantas("operativa"),
      en_mantenimiento: cuantas("en_mantenimiento"),
      detenidas: cuantas("detenida"),
    },
    estado_por_area,
    ordenes: fuentes.conOrdenes ? await ordenesDelCentro(client, tenantId) : null,
    checklists: fuentes.conChecklists ? await checklistsDelCentro(client, tenantId) : null,
  };
}
