/** src/modules/mantenimiento/mantenimiento.planes.ts
 *
 * Planes de mantenimiento preventivo (M9): uno por tipo de equipo del maestro (`equipos`, tabla base). Son de
 * este módulo y no leen ningún otro: con solo Mantenimiento se crean, se editan y se quitan. Todo corre dentro
 * de `withTenant`. */
import type { PoolClient } from "pg";

import type {
  ActualizarPlanInput,
  CrearPlanInput,
} from "../../server/schemas/mantenimientoPlanes.schema";
import { AppError } from "../../server/shared/middlewares/error.middleware";

/** Tope por empresa: hay un plan por tipo de equipo; muchos más que esto no son tipos reales. */
export const MAX_PLANES_POR_EMPRESA = 200;

export interface NivelDelPlan {
  tareas: string[];
  repuestos: string[];
}

export interface Plan {
  id: number;
  tipo_equipo: string;
  medida: "horometro" | "odometro";
  intervalo: number;
  aviso_antes: number;
  ciclo: number[];
  niveles: Partial<Record<"1" | "2" | "3", NivelDelPlan>>;
  version: number;
  /** Equipos activos de ese tipo (los que usan el plan). */
  equipos: number;
}

/** Todo lo que se toma como espacio. Es la lista de `\s` de JavaScript (la que limpia el tipo del plan): el `\s`
 *  de Postgres no incluye los espacios «duros» que traen Excel o la web. */
const ESPACIOS = "[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+";

/** El tipo escrito en un equipo, con la misma limpieza que el de un plan. `columna` es un nombre fijo del
 *  código, nunca un dato. */
const tipoLimpio = (columna: string) =>
  `btrim(regexp_replace(${columna}, '${ESPACIOS}', ' ', 'g'))`;

const COLUMNAS = `p.id::int AS id, p.tipo_equipo, p.medida, p.intervalo, p.aviso_antes,
  p.ciclo::int[] AS ciclo, p.niveles, p.version,
  (SELECT count(*)::int FROM equipos e
    WHERE e.tenant_id = p.tenant_id AND e.activo
      AND lower(${tipoLimpio("e.tipo")}) = lower(p.tipo_equipo)) AS equipos`;

/** El 10 % del intervalo, siempre menor que él. */
export const avisoPorDefecto = (intervalo: number) =>
  Math.min(Math.round(intervalo / 10), intervalo - 1);

export async function obtenerPlan(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query<Plan>(
    `SELECT ${COLUMNAS} FROM mantenimiento_planes p WHERE p.tenant_id = $1 AND p.id = $2`,
    [tenantId, id]
  );
  return r.rows[0] ?? null;
}

/** Los planes y los tipos de equipo que todavía no tienen ninguno. */
export async function listarPlanes(client: PoolClient, tenantId: string) {
  const planes = await client.query<Plan>(
    `SELECT ${COLUMNAS} FROM mantenimiento_planes p
      WHERE p.tenant_id = $1 ORDER BY lower(p.tipo_equipo)`,
    [tenantId]
  );
  const sinPlan = await client.query<{ tipo: string; equipos: number }>(
    `SELECT min(t.tipo) AS tipo, count(*)::int AS equipos
       FROM (SELECT ${tipoLimpio("tipo")} AS tipo FROM equipos
              WHERE tenant_id = $1 AND activo) t
      WHERE t.tipo <> ''
        AND NOT EXISTS (SELECT 1 FROM mantenimiento_planes p
                         WHERE p.tenant_id = $1 AND lower(p.tipo_equipo) = lower(t.tipo))
      GROUP BY lower(t.tipo) ORDER BY lower(t.tipo)`,
    [tenantId]
  );
  return { planes: planes.rows, tiposSinPlan: sinPlan.rows };
}

export async function crearPlan(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  plan: CrearPlanInput
) {
  // Las altas de una empresa esperan turno: contar y luego insertar, a la vez, se pasaría del tope.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `mantenimiento_planes:${tenantId}`,
  ]);
  const total = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM mantenimiento_planes WHERE tenant_id = $1",
    [tenantId]
  );
  if (total.rows[0].n >= MAX_PLANES_POR_EMPRESA) {
    throw new AppError(409, `Se llegó al máximo de ${MAX_PLANES_POR_EMPRESA} planes`);
  }
  const r = await client.query<{ id: number }>(
    `INSERT INTO mantenimiento_planes
       (tenant_id, tipo_equipo, medida, intervalo, aviso_antes, ciclo, niveles, creado_por, actualizado_por)
     VALUES ($1, $2, $3, $4, $5, $6::smallint[], $7::jsonb, $8, $8)
     RETURNING id::int AS id`,
    [
      tenantId,
      plan.tipo_equipo,
      plan.medida,
      plan.intervalo,
      plan.aviso_antes ?? avisoPorDefecto(plan.intervalo),
      plan.ciclo,
      JSON.stringify(plan.niveles),
      usuarioId,
    ]
  );
  return (await obtenerPlan(client, tenantId, r.rows[0].id))!;
}

/** Guarda el plan entero, solo si nadie lo cambió desde la versión que se editó. */
export async function actualizarPlan(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  plan: ActualizarPlanInput
) {
  // La condición sobre `version` va en el mismo UPDATE: dos guardados a la vez no se pisan.
  const r = await client.query(
    `UPDATE mantenimiento_planes
        SET tipo_equipo = $4, medida = $5, intervalo = $6, aviso_antes = $7, ciclo = $8::smallint[],
            niveles = $9::jsonb, version = version + 1, actualizado_en = now(), actualizado_por = $10
      WHERE tenant_id = $1 AND id = $2 AND version = $3`,
    [
      tenantId,
      id,
      plan.version,
      plan.tipo_equipo,
      plan.medida,
      plan.intervalo,
      plan.aviso_antes,
      plan.ciclo,
      JSON.stringify(plan.niveles),
      usuarioId,
    ]
  );
  if (r.rowCount === 0) {
    if (!(await obtenerPlan(client, tenantId, id))) throw new AppError(404, "El plan no existe");
    throw new AppError(409, "Alguien cambió este plan: ábrelo de nuevo antes de guardar");
  }
  return (await obtenerPlan(client, tenantId, id))!;
}

export async function quitarPlan(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    "DELETE FROM mantenimiento_planes WHERE tenant_id = $1 AND id = $2",
    [tenantId, id]
  );
  if (r.rowCount === 0) throw new AppError(404, "El plan no existe");
}
