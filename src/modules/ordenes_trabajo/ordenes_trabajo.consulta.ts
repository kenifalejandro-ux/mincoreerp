/** src/modules/ordenes_trabajo/ordenes_trabajo.consulta.ts
 *
 * Lo que la oficina consulta de las órdenes (M8): los filtros y columnas de la lista, las cifras de arriba y
 * los mecánicos con las órdenes que ya tienen. Lo de otros módulos (unidad, área, IPERC) es opcional: sin el
 * módulo la tabla ajena no se lee (ver `opcionales` en registry.ts). Todo corre dentro de `withTenant`. */
import type { PoolClient } from "pg";

import type { FiltrosDeOrdenesInput } from "../../server/schemas/ordenes_trabajo.schema";

/** Qué módulos vecinos tiene quien consulta. */
export interface Vecinos {
  conUnidades: boolean;
  /** El área de cada unidad es de Mantenimiento. */
  conAreas: boolean;
  conIperc: boolean;
}

export type FiltrosDeOrdenes = FiltrosDeOrdenesInput & { equipoId?: number };

/** Lo escrito se busca tal cual: «%» y «_» no son comodines. */
const contiene = (texto: string) => `%${texto.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;

/** Las columnas y uniones que dependen de otros módulos. Sin el módulo la columna va vacía. */
export function columnasVecinas({ conUnidades, conAreas, conIperc }: Vecinos) {
  const areas = conUnidades && conAreas;
  return {
    columnas: [
      conUnidades
        ? "e.placa_codigo, e.tipo AS equipo_tipo"
        : "NULL::text AS placa_codigo, NULL::text AS equipo_tipo",
      areas ? "ar.nombre AS area" : "NULL::text AS area",
      conIperc ? "ip.estado AS iperc_estado" : "NULL::text AS iperc_estado",
    ].join(", "),
    joins: [
      // LEFT JOIN siempre: la orden puede no tener unidad (0190), área ni IPERC.
      conUnidades ? "LEFT JOIN equipos e ON e.id = ot.equipo_id" : "",
      areas
        ? `LEFT JOIN mantenimiento_equipo_datos md
             ON md.tenant_id = ot.tenant_id AND md.equipo_id = ot.equipo_id
           LEFT JOIN mantenimiento_areas ar ON ar.tenant_id = md.tenant_id AND ar.id = md.area_id`
        : "",
      conIperc ? "LEFT JOIN ipercs ip ON ip.tenant_id = ot.tenant_id AND ip.id = ot.iperc_id" : "",
    ].join("\n"),
  };
}

/** El WHERE de la lista. `$1` es la empresa. Un filtro de un módulo que falta se ignora, no es un error. */
export function condicionDeLista(tenantId: string, f: FiltrosDeOrdenes, vecinos: Vecinos) {
  const params: (string | number)[] = [tenantId];
  const condiciones = ["ot.tenant_id = $1"];
  const agregar = (valor: string | number, condicion: (p: string) => string) => {
    params.push(valor);
    condiciones.push(condicion(`$${params.length}`));
  };

  if (f.estado) agregar(f.estado, (p) => `ot.estado = ${p}`);
  if (f.tipo) agregar(f.tipo, (p) => `ot.tipo = ${p}`);
  if (f.prioridad) agregar(f.prioridad, (p) => `ot.prioridad = ${p}`);
  if (f.asignado_a) agregar(f.asignado_a, (p) => `ot.asignado_a = ${p}`);
  if (f.sin_asignar === "true") condiciones.push("ot.asignado_a IS NULL");
  if (f.equipoId && vecinos.conUnidades) agregar(f.equipoId, (p) => `ot.equipo_id = ${p}`);
  if (f.area_id && vecinos.conUnidades && vecinos.conAreas) {
    agregar(f.area_id, (p) => `md.area_id = ${p}`);
  }
  if (f.q) {
    // Por número («12» o «#12»), trabajo, activo, unidad o mecánico.
    const placa = vecinos.conUnidades ? ", e.placa_codigo" : "";
    agregar(
      contiene(f.q),
      (p) =>
        `lower(concat_ws(' ', '#' || ot.id, ot.titulo, ot.activo_texto, asig.nombre${placa})) LIKE ${p}`
    );
  }
  return { where: condiciones.join(" AND "), params };
}

/** Las cifras de arriba de la lista. «Urgentes» son las que siguen sin cerrar; el mes es el de Lima. */
export async function resumenDeOrdenes(client: PoolClient, tenantId: string) {
  const r = await client.query<{
    abiertas: number;
    en_progreso: number;
    urgentes: number;
    sin_asignar: number;
    completadas_del_mes: number;
  }>(
    `SELECT count(*) FILTER (WHERE estado = 'abierta')::int AS abiertas,
            count(*) FILTER (WHERE estado = 'en_progreso')::int AS en_progreso,
            count(*) FILTER (WHERE estado IN ('abierta', 'en_progreso')
                               AND prioridad = 'urgente')::int AS urgentes,
            count(*) FILTER (WHERE estado IN ('abierta', 'en_progreso')
                               AND asignado_a IS NULL)::int AS sin_asignar,
            count(*) FILTER (WHERE estado = 'completada'
                               AND fecha_cierre >= date_trunc('month', now(), 'America/Lima')
                            )::int AS completadas_del_mes
       FROM ordenes_trabajo
      WHERE tenant_id = $1`,
    [tenantId]
  );
  return r.rows[0];
}

/** Las personas con perfil «Mecánico», cada una con las órdenes sin cerrar que ya tiene: primero las de
 *  menos carga. */
export async function mecanicosConCarga(client: PoolClient, tenantId: string) {
  const r = await client.query<{
    id: string;
    nombre: string;
    ordenes: { id: number; titulo: string }[];
  }>(
    `SELECT u.id, u.nombre,
            COALESCE(json_agg(json_build_object('id', o.id, 'titulo', o.titulo) ORDER BY o.id)
                       FILTER (WHERE o.id IS NOT NULL), '[]') AS ordenes
       FROM usuarios u
       LEFT JOIN ordenes_trabajo o
         ON o.tenant_id = u.tenant_id AND o.asignado_a = u.id
        AND o.estado IN ('abierta', 'en_progreso')
      WHERE u.tenant_id = $1 AND u.activo AND u.rol = 'mecanico'
      GROUP BY u.id, u.nombre
      ORDER BY count(o.id), u.nombre, u.id`,
    [tenantId]
  );
  return r.rows;
}
