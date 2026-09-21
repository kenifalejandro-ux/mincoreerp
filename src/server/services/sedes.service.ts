/** src/server/services/sedes.service.ts
 *
 * Sedes y grifos internos (migración 0097, entrega 1 de
 * docs/architecture/combustible-sedes-grifos-surtidores.md).
 *
 * La sede es de la EMPRESA, no de un módulo: por eso esto vive acá y no en
 * src/modules/combustible, igual que la gente de la empresa (usuariosTenant).
 * Combustible y Equipos la consumen con `motivoFaltaGrifo`, `moverDeGrifo` y
 * `listarMovimientosDeGrifo`.
 *
 * Nada se borra: la baja es lógica y con motivo, porque tanques, equipos y
 * cada vale, varilla o alerta guardan el grifo donde ocurrieron.
 */
import type { PoolClient } from "pg";

import { withTenant } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";
import { esViolacionUnicidad } from "../shared/utils/pgError";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";

export interface GrifoInterno {
  id: number;
  sede_id: number;
  nombre: string;
  activo: boolean;
  motivo_baja: string | null;
  tanques_activos: number;
  equipos_activos: number;
}

export interface Sede {
  id: number;
  nombre: string;
  activo: boolean;
  motivo_baja: string | null;
  grifos: GrifoInterno[];
}

/** Las sedes con sus grifos, y cuánto hay activo en cada grifo (lo que decide
 *  si se puede dar de baja). Lo lee cualquier usuario de la empresa: los
 *  formularios de tanque y de equipo lo necesitan para su selector. */
export async function listarSedesService(tenantId: string): Promise<Sede[]> {
  return withTenant(tenantId, async (client) => {
    const sedes = await client.query<Omit<Sede, "grifos">>(
      `SELECT id, nombre, activo, motivo_baja FROM sedes
        WHERE tenant_id = $1 ORDER BY activo DESC, lower(nombre)`,
      [tenantId]
    );
    const grifos = await client.query<GrifoInterno>(
      `SELECT g.id, g.sede_id, g.nombre, g.activo, g.motivo_baja,
              (SELECT count(*) FROM combustible c
                WHERE c.tenant_id = $1 AND c.grifo_interno_id = g.id AND c.activo)::int
                AS tanques_activos,
              (SELECT count(*) FROM equipos e
                WHERE e.tenant_id = $1 AND e.grifo_interno_id = g.id AND e.activo)::int
                AS equipos_activos
         FROM grifos_internos g
        WHERE g.tenant_id = $1
        ORDER BY g.activo DESC, lower(g.nombre)`,
      [tenantId]
    );
    return sedes.rows.map((s) => ({
      ...s,
      grifos: grifos.rows.filter((g) => g.sede_id === s.id),
    }));
  });
}

// ── Lo que usan Combustible y Equipos ───────────────────────────────────

export async function contarGrifosActivos(client: PoolClient, tenantId: string) {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM grifos_internos WHERE tenant_id = $1 AND activo`,
    [tenantId]
  );
  return r.rows[0].n;
}

/** El grifo existe EN ESTA EMPRESA y está activo. Devuelve el motivo del
 *  rechazo o null. La clave foránea compuesta también lo impediría, pero con
 *  un error de constraint; esto responde un 400 que se entiende. */
export async function motivoGrifoNoAsignable(
  client: PoolClient,
  tenantId: string,
  grifoId: number
): Promise<string | null> {
  const r = await client.query<{ activo: boolean }>(
    `SELECT activo FROM grifos_internos WHERE id = $1 AND tenant_id = $2`,
    [grifoId, tenantId]
  );
  if (r.rows.length === 0) return "el grifo interno indicado no existe";
  if (!r.rows[0].activo) return "el grifo interno indicado está dado de baja";
  return null;
}

/** La regla de alta de un tanque o un equipo: con más de un grifo activo, el
 *  grifo es obligatorio; con uno solo, lo asigna el trigger de la base. */
export async function motivoFaltaGrifo(
  client: PoolClient,
  tenantId: string,
  grifoId: number | undefined,
  que: "tanque" | "equipo"
): Promise<string | null> {
  if (grifoId !== undefined) return motivoGrifoNoAsignable(client, tenantId, grifoId);
  if ((await contarGrifosActivos(client, tenantId)) > 1) {
    return `el ${que} necesita un grifo interno: la empresa tiene más de uno`;
  }
  return null;
}

/** Mover un tanque o un equipo de grifo. El trigger de la base escribe el
 *  movimiento con el motivo y el usuario de la sesión, y rechaza el cambio si
 *  falta el motivo: por eso los dos se ponen ACÁ, en la misma transacción, y
 *  este es el único camino de la aplicación que mueve algo. */
export async function moverDeGrifo(
  client: PoolClient,
  tenantId: string,
  datos: {
    tabla: "combustible" | "equipos";
    id: number;
    grifoDestinoId: number;
    motivo: string;
    usuarioId: string;
  }
): Promise<{ grifoOrigenId: number | null } | null> {
  const actual = await client.query<{ grifo_interno_id: number | null }>(
    `SELECT grifo_interno_id FROM ${datos.tabla} WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [datos.id, tenantId]
  );
  if (actual.rows.length === 0) return null;
  const origen = actual.rows[0].grifo_interno_id;
  if (origen === datos.grifoDestinoId) {
    throw new AppError(400, "Ya está en ese grifo interno");
  }
  const noAsignable = await motivoGrifoNoAsignable(client, tenantId, datos.grifoDestinoId);
  if (noAsignable) throw new AppError(400, noAsignable);

  await client.query(`SELECT set_config('app.motivo_movimiento_grifo', $1, true)`, [datos.motivo]);
  await client.query(`SELECT set_config('app.usuario_id', $1, true)`, [datos.usuarioId]);
  await client.query(
    `UPDATE ${datos.tabla} SET grifo_interno_id = $1 WHERE id = $2 AND tenant_id = $3`,
    [datos.grifoDestinoId, datos.id, tenantId]
  );
  return { grifoOrigenId: origen };
}

/** El historial de ubicación de un tanque o un equipo, del más nuevo al más
 *  viejo, con los nombres ya resueltos. */
export async function listarMovimientosDeGrifo(
  client: PoolClient,
  tenantId: string,
  columna: "combustible_id" | "equipo_id",
  id: number
) {
  const r = await client.query(
    `SELECT m.id, m.movido_en, m.motivo,
            m.grifo_origen_id, go.nombre AS grifo_origen, so.nombre AS sede_origen,
            m.grifo_destino_id, gd.nombre AS grifo_destino, sd.nombre AS sede_destino,
            u.nombre AS usuario
       FROM movimientos_grifo m
       LEFT JOIN grifos_internos go ON go.id = m.grifo_origen_id AND go.tenant_id = $1
       LEFT JOIN sedes so ON so.id = go.sede_id AND so.tenant_id = $1
       JOIN grifos_internos gd ON gd.id = m.grifo_destino_id AND gd.tenant_id = $1
       JOIN sedes sd ON sd.id = gd.sede_id AND sd.tenant_id = $1
       LEFT JOIN usuarios u ON u.id = m.usuario_id AND u.tenant_id = $1
      WHERE m.tenant_id = $1 AND m.${columna} = $2
      ORDER BY m.movido_en DESC, m.id DESC`,
    [tenantId, id]
  );
  return r.rows;
}

// ── Administración (solo admin) ─────────────────────────────────────────

interface Actor {
  id: string;
}

function nombreDuplicado(err: unknown, que: string): never {
  if (esViolacionUnicidad(err)) {
    throw new AppError(409, `Ya existe ${que} con ese nombre`);
  }
  throw err;
}

export async function crearSedeService(
  tenantId: string,
  actor: Actor,
  nombre: string,
  contexto: ContextoAuditoria
) {
  const sede = await withTenant(tenantId, async (client) => {
    try {
      const r = await client.query<{ id: number }>(
        `INSERT INTO sedes (tenant_id, nombre, creado_por) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, nombre, actor.id]
      );
      return r.rows[0];
    } catch (err) {
      nombreDuplicado(err, "una sede");
    }
  });
  await registrarAuditoria({
    accion: "empresa.sede_crear",
    tenantId,
    usuarioId: actor.id,
    detalle: { sedeId: sede.id, nombre },
    contexto,
  });
  return sede;
}

export async function renombrarSedeService(
  tenantId: string,
  actor: Actor,
  id: number,
  nombre: string,
  contexto: ContextoAuditoria
) {
  const antes = await withTenant(tenantId, async (client) => {
    const previo = await client.query<{ nombre: string }>(
      `SELECT nombre FROM sedes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (previo.rows.length === 0) throw new AppError(404, "Sede no encontrada");
    try {
      await client.query(`UPDATE sedes SET nombre = $1 WHERE id = $2 AND tenant_id = $3`, [
        nombre,
        id,
        tenantId,
      ]);
    } catch (err) {
      nombreDuplicado(err, "una sede");
    }
    return previo.rows[0].nombre;
  });
  await registrarAuditoria({
    accion: "empresa.sede_renombrar",
    tenantId,
    usuarioId: actor.id,
    detalle: { sedeId: id, de: antes, a: nombre },
    contexto,
  });
}

export async function bajaSedeService(
  tenantId: string,
  actor: Actor,
  id: number,
  motivo: string,
  contexto: ContextoAuditoria
) {
  await withTenant(tenantId, async (client) => {
    const sede = await client.query<{ activo: boolean }>(
      `SELECT activo FROM sedes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (sede.rows.length === 0) throw new AppError(404, "Sede no encontrada");
    if (!sede.rows[0].activo) throw new AppError(409, "La sede ya está dada de baja");
    // Sin huérfanos: primero se dan de baja (o se mueven) sus grifos.
    const grifos = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM grifos_internos
        WHERE tenant_id = $1 AND sede_id = $2 AND activo`,
      [tenantId, id]
    );
    if (grifos.rows[0].n > 0) {
      throw new AppError(
        409,
        `La sede tiene ${grifos.rows[0].n} grifo(s) activo(s): dalos de baja primero`
      );
    }
    await client.query(
      `UPDATE sedes SET activo = false, motivo_baja = $1 WHERE id = $2 AND tenant_id = $3`,
      [motivo, id, tenantId]
    );
  });
  await registrarAuditoria({
    accion: "empresa.sede_baja",
    tenantId,
    usuarioId: actor.id,
    detalle: { sedeId: id, motivo },
    contexto,
  });
}

export async function reactivarSedeService(
  tenantId: string,
  actor: Actor,
  id: number,
  motivo: string,
  contexto: ContextoAuditoria
) {
  await withTenant(tenantId, async (client) => {
    const r = await client.query(
      `UPDATE sedes SET activo = true WHERE id = $1 AND tenant_id = $2 AND NOT activo RETURNING id`,
      [id, tenantId]
    );
    if (r.rowCount === 0) throw new AppError(404, "Sede no encontrada o ya activa");
  });
  await registrarAuditoria({
    accion: "empresa.sede_reactivar",
    tenantId,
    usuarioId: actor.id,
    detalle: { sedeId: id, motivo },
    contexto,
  });
}

export async function crearGrifoService(
  tenantId: string,
  actor: Actor,
  datos: { sedeId: number; nombre: string },
  contexto: ContextoAuditoria
) {
  const grifo = await withTenant(tenantId, async (client) => {
    const sede = await client.query<{ activo: boolean }>(
      `SELECT activo FROM sedes WHERE id = $1 AND tenant_id = $2`,
      [datos.sedeId, tenantId]
    );
    if (sede.rows.length === 0) throw new AppError(400, "La sede indicada no existe");
    if (!sede.rows[0].activo) throw new AppError(400, "La sede indicada está dada de baja");
    try {
      const r = await client.query<{ id: number }>(
        `INSERT INTO grifos_internos (tenant_id, sede_id, nombre, creado_por)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, datos.sedeId, datos.nombre, actor.id]
      );
      return r.rows[0];
    } catch (err) {
      nombreDuplicado(err, "un grifo en esa sede");
    }
  });
  await registrarAuditoria({
    accion: "empresa.grifo_crear",
    tenantId,
    usuarioId: actor.id,
    detalle: { grifoId: grifo.id, sedeId: datos.sedeId, nombre: datos.nombre },
    contexto,
  });
  return grifo;
}

/** Solo el nombre: la sede de un grifo NO se cambia (ver 0097). */
export async function renombrarGrifoService(
  tenantId: string,
  actor: Actor,
  id: number,
  nombre: string,
  contexto: ContextoAuditoria
) {
  const antes = await withTenant(tenantId, async (client) => {
    const previo = await client.query<{ nombre: string }>(
      `SELECT nombre FROM grifos_internos WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (previo.rows.length === 0) throw new AppError(404, "Grifo no encontrado");
    try {
      await client.query(
        `UPDATE grifos_internos SET nombre = $1 WHERE id = $2 AND tenant_id = $3`,
        [nombre, id, tenantId]
      );
    } catch (err) {
      nombreDuplicado(err, "un grifo en esa sede");
    }
    return previo.rows[0].nombre;
  });
  await registrarAuditoria({
    accion: "empresa.grifo_renombrar",
    tenantId,
    usuarioId: actor.id,
    detalle: { grifoId: id, de: antes, a: nombre },
    contexto,
  });
}

export async function bajaGrifoService(
  tenantId: string,
  actor: Actor,
  id: number,
  motivo: string,
  contexto: ContextoAuditoria
) {
  await withTenant(tenantId, async (client) => {
    const grifo = await client.query<{ activo: boolean }>(
      `SELECT activo FROM grifos_internos WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (grifo.rows.length === 0) throw new AppError(404, "Grifo no encontrado");
    if (!grifo.rows[0].activo) throw new AppError(409, "El grifo ya está dado de baja");
    // Sin huérfanos: primero se mueven sus tanques y equipos activos.
    const adentro = await client.query<{ tanques: number; equipos: number }>(
      `SELECT
         (SELECT count(*) FROM combustible
           WHERE tenant_id = $1 AND grifo_interno_id = $2 AND activo)::int AS tanques,
         (SELECT count(*) FROM equipos
           WHERE tenant_id = $1 AND grifo_interno_id = $2 AND activo)::int AS equipos`,
      [tenantId, id]
    );
    const { tanques, equipos } = adentro.rows[0];
    if (tanques > 0 || equipos > 0) {
      throw new AppError(
        409,
        `El grifo tiene ${tanques} tanque(s) y ${equipos} equipo(s) activos: muévelos a otro grifo primero`
      );
    }
    await client.query(
      `UPDATE grifos_internos SET activo = false, motivo_baja = $1
        WHERE id = $2 AND tenant_id = $3`,
      [motivo, id, tenantId]
    );
  });
  await registrarAuditoria({
    accion: "empresa.grifo_baja",
    tenantId,
    usuarioId: actor.id,
    detalle: { grifoId: id, motivo },
    contexto,
  });
}

export async function reactivarGrifoService(
  tenantId: string,
  actor: Actor,
  id: number,
  motivo: string,
  contexto: ContextoAuditoria
) {
  await withTenant(tenantId, async (client) => {
    const grifo = await client.query<{ activo: boolean; sede_activa: boolean }>(
      `SELECT g.activo, s.activo AS sede_activa
         FROM grifos_internos g JOIN sedes s ON s.id = g.sede_id AND s.tenant_id = g.tenant_id
        WHERE g.id = $1 AND g.tenant_id = $2 FOR UPDATE OF g`,
      [id, tenantId]
    );
    if (grifo.rows.length === 0) throw new AppError(404, "Grifo no encontrado");
    if (grifo.rows[0].activo) throw new AppError(409, "El grifo ya está activo");
    if (!grifo.rows[0].sede_activa) {
      throw new AppError(409, "La sede del grifo está dada de baja: reactívala primero");
    }
    await client.query(
      `UPDATE grifos_internos SET activo = true WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
  });
  await registrarAuditoria({
    accion: "empresa.grifo_reactivar",
    tenantId,
    usuarioId: actor.id,
    detalle: { grifoId: id, motivo },
    contexto,
  });
}
