/** src/server/services/platformAudit.service.ts
 *
 * Escritura y lectura de platform_audit_log. Separado de platform.service.ts
 * porque platformAdmin.middleware.ts también necesita registrar auditoría
 * (token rechazado en cualquier ruta protegida) sin depender del resto de
 * las operaciones de plataforma — evitar que un middleware importe de un
 * service que a su vez podría crecer con lógica de negocio.
 */
import { pool, withTenant } from "../config/database";
import { logger } from "../config/logger";
import { getRedis } from "../config/redis";

/** IP + requestId + userAgent + sessionId + actor de quien hizo la
 *  petición — cada ruta de platform.ts los arma con contextoDe()
 *  (shared/utils/request.ts + platformSession.service.ts) y los pasa acá.
 *  sessionId solo existe para login por cookie (ver
 *  platformAdmin.middleware.ts); el login por header
 *  `Authorization: Bearer` es stateless y no tiene sesión.
 *
 *  actorType/actorLabel son obligatorios a propósito (no opcionales):
 *  desde las cuentas individuales de Platform Admin (migrations/
 *  0016_platform_admins.sql) toda fila de auditoría debe declarar quién
 *  actuó, aunque sea para decir "unauthenticated" en un intento rechazado
 *  — así TypeScript obliga a decidirlo en cada call site en vez de dejarlo
 *  implícito. actorLabel es una foto tomada al momento del evento (el
 *  email del admin, o el literal "secreto-compartido"), no se resuelve
 *  por JOIN como tenantNombre/usuarioEmail: un admin que cambia de nombre
 *  o se desactiva después no debe reescribir el historial.
 *
 *  'scim' (migrations/0029): operaciones que llegan por el router SCIM,
 *  autenticadas con el token de un tenant_scim_config puntual — ninguna
 *  persona humana de por medio, así que ni 'platform_admin' ni
 *  'emergency_shared_secret' describen correctamente el origen. actor_id
 *  queda NULL en estas filas (sigue siendo FK a platform_admins).
 *
 *  'tenant_usuario' (migrations/0030): una acción de negocio dentro de un
 *  módulo del ERP (crear/editar/borrar un equipo, un checklist, un
 *  IPERC), hecha por un usuario normal de un tenant — no alguien operando
 *  el panel de plataforma. Ver contextoAuditoriaModulo() en
 *  shared/utils/moduleAudit.ts, que arma este contexto para cualquier
 *  controller de módulo. actor_id es el id de usuarios (sin FK real,
 *  usuarios tiene RLS — ver la migración). */
export type ActorTypeAuditoria =
  | "platform_admin"
  | "emergency_shared_secret"
  | "unauthenticated"
  | "system"
  | "scim"
  | "tenant_usuario";

export interface ContextoAuditoria {
  ip: string;
  requestId?: string;
  userAgent?: string;
  sessionId?: string;
  actorType: ActorTypeAuditoria;
  actorId?: string;
  actorLabel: string;
}

export type ResultadoAuditoria = "success" | "failure";

/** Nunca lanza: un fallo al auditar no debe bloquear la acción real de
 *  plataforma (mismo criterio que los fallos opcionales de Redis en
 *  auth.service.ts). */
export async function registrarAuditoria(params: {
  accion: string;
  tenantId?: string | null;
  usuarioId?: string | null;
  detalle?: Record<string, unknown>;
  contexto: ContextoAuditoria;
  resultado?: ResultadoAuditoria;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO platform_audit_log
         (accion, tenant_id, usuario_id, detalle, ip, request_id, user_agent, session_id,
          actor_type, actor_id, actor_label, resultado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        params.accion,
        params.tenantId ?? null,
        params.usuarioId ?? null,
        params.detalle ? JSON.stringify(params.detalle) : null,
        params.contexto.ip,
        params.contexto.requestId ?? null,
        params.contexto.userAgent ?? null,
        params.contexto.sessionId ?? null,
        params.contexto.actorType,
        params.contexto.actorId ?? null,
        params.contexto.actorLabel,
        params.resultado ?? "success",
      ]
    );
  } catch (err) {
    logger.warn({ err }, "No se pudo registrar la auditoría de plataforma");
  }
}

// Un script de fuerza bruta contra el secreto compartido puede variar la
// ruta en cada intento (rateLimiter.ts limita por `path`+ip, no alcanza
// para frenar esto) — sin este límite, cada intento rechazado inflaría
// platform_audit_log con una fila casi idéntica. Se audita como máximo un
// rechazo por IP cada VENTANA_RECHAZO_MS.
const VENTANA_RECHAZO_MS = 5 * 60_000;

const ultimoRechazoPorIp = new Map<string, number>();

// Mismo criterio de barrido que memoryStore en middleware/rateLimiter.ts:
// sin esto, el Map (fallback sin Redis) crecería sin límite.
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, expiraEn] of ultimoRechazoPorIp) {
    if (ahora >= expiraEn) ultimoRechazoPorIp.delete(ip);
  }
}, 5 * 60_000).unref();

function primerRechazoEnVentanaMemoria(ip: string): boolean {
  const ahora = Date.now();
  const expiraEn = ultimoRechazoPorIp.get(ip);
  if (expiraEn && ahora < expiraEn) return false;
  ultimoRechazoPorIp.set(ip, ahora + VENTANA_RECHAZO_MS);
  return true;
}

/** Audita un token de plataforma rechazado, pero como máximo una vez por IP
 *  cada VENTANA_RECHAZO_MS. Usa Redis si está disponible (dedupe correcto
 *  entre instancias, vía SET NX); si no, cae a un Map en memoria — peor con
 *  múltiples instancias (cada una audita su propio "primero"), pero sigue
 *  siendo un límite real donde antes no había ninguno. El chequeo en
 *  memoria es una función sync sin ningún `await` en el medio, así que no
 *  hay ventana para que dos llamadas concurrentes de la misma IP se
 *  intercalen (Node ejecuta esa sección de un tirón). Un fallo al aplicar
 *  el límite no debe impedir auditar: se registra igual. */
export async function registrarSesionRechazada(
  contexto: ContextoAuditoria,
  detalle: Record<string, unknown>
): Promise<void> {
  const redis = getRedis();

  try {
    if (redis) {
      const escrito = await redis.set(
        `platform-audit-dedupe:session-rechazada:${contexto.ip}`,
        "1",
        "PX",
        VENTANA_RECHAZO_MS,
        "NX"
      );
      if (escrito !== "OK") return;
    } else if (!primerRechazoEnVentanaMemoria(contexto.ip)) {
      return;
    }
  } catch (err) {
    logger.warn(
      { err },
      "No se pudo aplicar el dedupe de auditoría de plataforma, se registra igual"
    );
  }

  await registrarAuditoria({
    accion: "platform.session.rechazada",
    detalle,
    contexto,
    resultado: "failure",
  });
}

export interface EntradaAuditoria {
  id: string;
  accion: string;
  tenantId: string | null;
  tenantNombre: string | null;
  usuarioId: string | null;
  usuarioEmail: string | null;
  detalle: unknown;
  ip: string | null;
  requestId: string | null;
  userAgent: string | null;
  sessionId: string | null;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  resultado: string;
  creadoEn: string;
}

export interface CursorAuditoria {
  creadoEn: string;
  id: string;
}

export interface FiltrosAuditoria {
  tenantId?: string;
  accion?: string;
  /** Prefijo de acción, para pedir "todo lo de un módulo" sin enumerar cada
   *  acción. Lo usa la bitácora que ve el propio tenant en Combustible. */
  accionPrefijo?: string;
  /** Acciones sueltas que se suman al prefijo, en OR. Nació porque la
   *  bitácora de combustible tiene que mostrar `equipos.capacidad_tanque_
   *  ampliada`: un control de combustible que se afloja desde OTRO módulo, y
   *  que con el prefijo solo quedaba invisible justo para quien tiene que
   *  verlo. */
  accionesExtra?: string[];
  resultado?: ResultadoAuditoria;
  sessionId?: string;
  actorId?: string;
  desde?: string;
  hasta?: string;
  cursor?: CursorAuditoria;
  limit?: number;
}

export interface PaginaAuditoria {
  entradas: EntradaAuditoria[];
  siguienteCursor: CursorAuditoria | null;
}

export async function listarAuditoriaService(filtros: FiltrosAuditoria): Promise<PaginaAuditoria> {
  const limit = Math.min(Math.max(filtros.limit ?? 50, 1), 200);
  const condiciones: string[] = [];
  const params: unknown[] = [];

  if (filtros.tenantId) {
    params.push(filtros.tenantId);
    condiciones.push(`a.tenant_id = $${params.length}`);
  }
  if (filtros.accion) {
    params.push(filtros.accion);
    condiciones.push(`a.accion = $${params.length}`);
  }
  if (filtros.accionPrefijo) {
    params.push(filtros.accionPrefijo);
    const porPrefijo = `a.accion LIKE $${params.length} || '%'`;
    if (filtros.accionesExtra?.length) {
      params.push(filtros.accionesExtra);
      condiciones.push(`(${porPrefijo} OR a.accion = ANY($${params.length}::text[]))`);
    } else {
      condiciones.push(porPrefijo);
    }
  }
  if (filtros.resultado) {
    params.push(filtros.resultado);
    condiciones.push(`a.resultado = $${params.length}`);
  }
  if (filtros.sessionId) {
    params.push(filtros.sessionId);
    condiciones.push(`a.session_id = $${params.length}`);
  }
  if (filtros.actorId) {
    params.push(filtros.actorId);
    condiciones.push(`a.actor_id = $${params.length}`);
  }
  if (filtros.desde) {
    params.push(filtros.desde);
    condiciones.push(`a.creado_en >= $${params.length}`);
  }
  if (filtros.hasta) {
    params.push(filtros.hasta);
    condiciones.push(`a.creado_en <= $${params.length}`);
  }
  if (filtros.cursor) {
    params.push(filtros.cursor.creadoEn, filtros.cursor.id);
    const iCreado = params.length - 1;
    const iId = params.length;
    // La página está ordenada creado_en DESC, id ASC (mismo orden que el
    // índice idx_platform_audit_log_creado_id de 0014) — "lo que sigue"
    // son filas más viejas, o filas con el mismo creado_en pero id mayor
    // (mismo desempate que el ORDER BY de abajo).
    condiciones.push(
      `(a.creado_en < $${iCreado} OR (a.creado_en = $${iCreado} AND a.id > $${iId}))`
    );
  }

  params.push(limit);
  const where = condiciones.length > 0 ? `WHERE ${condiciones.join(" AND ")}` : "";

  // tenants no tiene RLS (ver migrations/0001) — el JOIN de acá es directo.
  const result = await pool.query(
    `SELECT a.id, a.accion, a.tenant_id AS "tenantId", t.nombre AS "tenantNombre",
            a.usuario_id AS "usuarioId", a.detalle, a.ip, a.request_id AS "requestId",
            a.user_agent AS "userAgent", a.session_id AS "sessionId",
            a.actor_type AS "actorType", a.actor_id AS "actorId", a.actor_label AS "actorLabel",
            a.resultado, a.creado_en AS "creadoEn"
     FROM platform_audit_log a
     LEFT JOIN tenants t ON t.id = a.tenant_id
     ${where}
     ORDER BY a.creado_en DESC, a.id ASC
     LIMIT $${params.length}`,
    params
  );
  const filas: Omit<EntradaAuditoria, "usuarioEmail">[] = result.rows;

  // usuarios SÍ tiene RLS (migrations/0010_usuarios_rls.sql) — un JOIN
  // directo contra ella en un pool.query() sin app.tenant_id seteado
  // fallaría (o, peor, dependería de qué haya quedado seteado en la
  // conexión que el pool reuse). Se resuelve el email agrupando los ids
  // por tenant y consultando cada grupo dentro de withTenant(), igual que
  // hace el resto del código con esta tabla.
  const idsPorTenant = new Map<string, Set<string>>();
  for (const fila of filas) {
    if (!fila.tenantId || !fila.usuarioId) continue;
    if (!idsPorTenant.has(fila.tenantId)) idsPorTenant.set(fila.tenantId, new Set());
    idsPorTenant.get(fila.tenantId)!.add(fila.usuarioId);
  }

  const emailPorUsuarioId = new Map<string, string>();
  for (const [tenantId, usuarioIds] of idsPorTenant) {
    const usuarios = await withTenant(tenantId, (client) =>
      client.query(`SELECT id, email FROM usuarios WHERE id = ANY($1)`, [[...usuarioIds]])
    );
    for (const u of usuarios.rows) emailPorUsuarioId.set(u.id, u.email);
  }

  const entradas = filas.map((fila) => ({
    ...fila,
    usuarioEmail: fila.usuarioId ? (emailPorUsuarioId.get(fila.usuarioId) ?? null) : null,
  }));

  const ultima = filas[filas.length - 1];
  const siguienteCursor =
    filas.length === limit && ultima ? { creadoEn: ultima.creadoEn, id: ultima.id } : null;

  return { entradas, siguienteCursor };
}
