/** src/server/services/auth.service.ts */

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { randomBytes, randomUUID, createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool, withTenant } from "../config/database";
import { env, emailConfigured } from "../config/env";
import { transporter } from "../config/mailer";
import { getRedis } from "../config/redis";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import type {
  LoginInput,
  GoogleLoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from "../schemas/auth.schema";
import { requerirJwtSecret } from "../shared/utils/jwt-secret";
import { esViolacionUnicidad } from "../shared/utils/pgError";
import { escapeHtml } from "../shared/utils/html";
import {
  setCachedTokenVersion,
  invalidateCachedTokenVersion,
} from "../shared/utils/token-version-cache";

const JWT_SECRET = requerirJwtSecret();
// Un solo OAuth2Client reutilizado entre requests (igual que `pool` para
// Postgres) — verifyIdToken no abre conexión persistente, pero instanciarlo
// por request es trabajo de más sin beneficio.
const googleClient = env.googleLoginClientId ? new OAuth2Client(env.googleLoginClientId) : null;

// Hash "señuelo" precalculado (de una contraseña arbitraria) para que, cuando
// el email no exista, igual se ejecute un bcrypt.compare y el tiempo de
// respuesta no delate si el correo está o no registrado.
const HASH_SEÑUELO = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8n3g7dCXi/GjQzEr8h5oT5w9Kj0R3W";

export interface UsuarioPayload {
  id: string;
  tenantId: string;
  nombre: string;
  /** Puede ser null desde 0084: un usuario de cancha entra con DNI y no
   *  tiene correo. Todo lo que le mande un mail tiene que contemplarlo. */
  email: string | null;
  dni?: string | null;
  rol: "admin" | "operador" | "lectura";
  /** Intersección de tenant_modulos (habilitados para la empresa) y
   *  usuario_modulos (asignados a este usuario) al momento del login/
   *  refresh — ver obtenerModulosPermitidos(). Igual que `rol`, un cambio
   *  hecho desde el panel de plataforma tarda hasta el próximo login/
   *  refresh en reflejarse; no se re-consulta en cada request. */
  modulosPermitidos: string[];
  /** Comparado contra usuarios.token_version en cada request (ver
   *  authMiddleware): incrementar esa columna revoca todos los JWT emitidos
   *  antes del incremento, sin depender de que Redis esté disponible. */
  tokenVersion: number;
  /** Identifica esta sesión particular entre las varias que un usuario
   *  puede tener activas a la vez (un login por dispositivo/navegador) --
   *  ver emitirSesionCompleta(). Opcional en el tipo porque los
   *  `UsuarioPayload` que no representan una sesión propia (ej. el que
   *  devuelve crearUsuarioService, que da de alta una cuenta, no loguea a
   *  nadie) nunca lo tienen -- pero SIEMPRE está presente en el payload
   *  real de un JWT ya firmado. */
  sessionId?: string;
  /** true si la cuenta arrancó con una contraseña genérica que un admin
   *  le puso al darla de alta (panel o SCIM) y todavía no la reemplazó
   *  por una propia -- el frontend usa esto para mostrar una pantalla
   *  obligatoria de cambio antes de dejar usar el resto del ERP (ver
   *  App.tsx). Se arma en cada login/refresh desde una lectura fresca de
   *  la base, igual que rol/modulosPermitidos: un cambio tarda hasta el
   *  próximo login/refresh en reflejarse. */
  debeCambiarPassword: boolean;
}

/** Determinístico por (tenant, módulo, usuario): el mismo usuario siempre
 *  cae en el mismo bucket [0,100) mientras no cambien esos tres valores —
 *  sin esto, un módulo en 'rollout' aparecería y desaparecería al azar
 *  entre logins del mismo usuario, que es peor que no tener rollout
 *  gradual. No hace falta que sea criptográficamente fuerte, solo estable
 *  y razonablemente bien distribuido — md5 alcanza. */
export function enBucketDeRollout(
  tenantId: string,
  modulo: string,
  usuarioId: string,
  porcentaje: number
): boolean {
  const hash = createHash("md5").update(`${tenantId}:${modulo}:${usuarioId}`).digest();
  const bucket = hash.readUInt32BE(0) % 100;
  return bucket < porcentaje;
}

/** Módulos que un usuario puede ver: los que su tenant tiene en estado
 *  'habilitado' (o cae del lado correcto del rollout, si está en
 *  'rollout') Y que además tiene asignados a él — nunca se re-consulta
 *  por request (ver UsuarioPayload), solo al construir la sesión en
 *  login/refresh. tenant_modulos/usuario_modulos no tienen RLS (el panel
 *  de plataforma necesita leer/escribir cualquier tenant — ver
 *  migrations/0008), así que aceptar el `client` de una transacción
 *  withTenant() en curso es solo por eficiencia (reusar la misma
 *  conexión), nunca un requisito de RLS. */
export async function obtenerModulosPermitidos(
  usuarioId: string,
  tenantId: string,
  db: Pool | PoolClient = pool
): Promise<string[]> {
  const result = await db.query(
    `SELECT um.modulo, tm.estado, tm.rollout_porcentaje AS "rolloutPorcentaje"
     FROM usuario_modulos um
     JOIN tenant_modulos tm ON tm.tenant_id = $2 AND tm.modulo = um.modulo
     WHERE um.usuario_id = $1`,
    [usuarioId, tenantId]
  );

  return result.rows
    .filter((fila) => {
      if (fila.estado === "habilitado") return true;
      if (fila.estado === "deshabilitado") return false;
      return enBucketDeRollout(tenantId, fila.modulo, usuarioId, fila.rolloutPorcentaje ?? 0);
    })
    .map((fila) => fila.modulo);
}

/** Solo para exponer al cliente: nunca se envía tokenVersion ni sessionId
 *  en las respuestas HTTP (login, /me) — son detalles internos de
 *  revocación/sesión, el cliente no necesita saber su propio sessionId (ya
 *  viaja, invisible, dentro de la cookie httpOnly). */
export function aPublico(usuario: UsuarioPayload) {
  const { tokenVersion: _tokenVersion, sessionId: _sessionId, ...publico } = usuario;
  return publico;
}

function firmarAccessToken(usuario: UsuarioPayload): string {
  return jwt.sign(usuario, JWT_SECRET, {
    expiresIn: env.jwtExpires as jwt.SignOptions["expiresIn"],
  });
}

function hashRefreshToken(tokenPlano: string): string {
  return createHash("sha256").update(tokenPlano).digest("hex");
}

/** Genera un refresh token opaco (no JWT), guarda solo su hash en BD y
 *  devuelve el valor en texto plano para mandarlo como cookie — es la
 *  única vez que existe en texto plano fuera del cliente.
 *
 *  tenantId queda denormalizado en la fila (además de resolverse vía
 *  usuario_id → usuarios.tenant_id) porque refrescarTokenService necesita
 *  saber a qué tenant pertenece ANTES de poder abrir una transacción
 *  withTenant() y leer `usuarios` bajo RLS — sin este dato acá, sería
 *  imposible resolver ese punto de partida. refresh_tokens en sí sigue sin
 *  RLS (no es una tabla que el usuario consulte directamente).
 *
 *  sessionId también queda denormalizado (migrations/0040): es lo que
 *  permite a logoutService() revocar el refresh token de UNA sesión sin
 *  tocar los de las demás. */
async function emitirRefreshToken(
  usuarioId: string,
  tenantId: string,
  sessionId: string
): Promise<string> {
  const tokenPlano = randomBytes(48).toString("hex");
  const expiraEn = new Date(Date.now() + env.sessionTtlSeconds * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (usuario_id, tenant_id, token_hash, expira_en, session_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [usuarioId, tenantId, hashRefreshToken(tokenPlano), expiraEn, sessionId]
  );

  return tokenPlano;
}

/** Firma el JWT, emite el refresh token y deja la sesión cacheada/en Redis —
 *  paso final común a loginService y googleLoginService una vez que cada uno
 *  ya resolvió (por su propio método) cuál es el `usuario` válido. Exportada
 *  para que tenantSso.service.ts la reuse en el callback OIDC: mismo
 *  criterio de "reutilizar la infraestructura de sesión existente" que ya
 *  aplica googleLoginService — SSO solo cambia CÓMO se resuelve el
 *  `usuario`, nunca cómo se emite la sesión una vez resuelto.
 *
 *  Un usuario puede tener varias sesiones activas a la vez (celular + PC,
 *  por ejemplo) — cada una identificada por su propio `sessionId`, una key
 *  de Redis separada (`session:<usuarioId>:<sessionId>`), y su propia fila
 *  en refresh_tokens. `sessionIdExistente` es para refrescarTokenService():
 *  refrescar el access token EXTIENDE la sesión que ya existía, no crea una
 *  nueva — sin esto, cada refresh (automático, cada ~30 min mientras el
 *  usuario sigue activo) generaría una sesión nueva y abandonaría la
 *  anterior. Sin argumento (un login real) se genera una nueva. */
export async function emitirSesionCompleta(
  usuario: UsuarioPayload,
  sessionIdExistente?: string | null
): Promise<{ token: string; usuario: UsuarioPayload; refreshToken: string }> {
  const sessionId = sessionIdExistente ?? randomUUID();
  const usuarioConSesion: UsuarioPayload = { ...usuario, sessionId };

  const token = firmarAccessToken(usuarioConSesion);
  const refreshToken = await emitirRefreshToken(usuario.id, usuario.tenantId, sessionId);

  // Cachea la versión vigente para que el primer request autenticado tras
  // el login no tenga que ir a Postgres a buscarla (ver authMiddleware).
  await setCachedTokenVersion(usuario.id, usuario.tokenVersion);

  // Sesión en Redis: permite invalidar el token activamente en logout (de
  // ESTA sesión puntual, ver logoutService) sin depender solo de que el JWT
  // expire por su cuenta. Una key por sesión, no una sola por usuario —
  // eso es justamente lo que permite tener varias a la vez sin que se
  // pisen entre sí.
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`session:${usuario.id}:${sessionId}`, token, "EX", env.sessionTtlSeconds);
    } catch (err) {
      logger.warn({ err }, "No se pudo guardar la sesión en Redis, continuando solo con JWT");
    }
  }

  return { token, usuario: usuarioConSesion, refreshToken };
}

/** Resuelve el tenant por slug — paso previo obligatorio a cualquier
 *  consulta de `usuarios`, que ahora exige `app.tenant_id` seteado (RLS).
 *  `tenants` no tiene RLS, así que esto es un pool.query() normal. */
async function resolverTenantActivoPorSlug(
  tenantSlug: string
): Promise<{ id: string } | undefined> {
  const result = await pool.query(`SELECT id FROM tenants WHERE slug = $1 AND activo = true`, [
    tenantSlug,
  ]);
  return result.rows[0];
}

export async function loginService(
  input: LoginInput
): Promise<{ token: string; usuario: UsuarioPayload; refreshToken: string }> {
  // Con `usuarios` bajo RLS, resolver el tenant es un paso separado y previo
  // a poder consultar `usuarios` — antes era un solo JOIN, ahora son dos
  // pasos secuenciales (ver explicación completa en la respuesta que
  // acompaña este cambio). Si el tenantSlug no existe (o está inactivo),
  // no hay transacción que abrir: se sigue igual al flujo de "usuario no
  // encontrado" de siempre, comparando contra el hash señuelo más abajo —
  // el mensaje final es idéntico en ambos casos (anti-enumeración de
  // usuarios). El único residuo aceptado es que esta ruta hace una consulta
  // menos que la de un tenantSlug válido; no se considera sensible porque
  // el slug de una empresa no es un dato secreto (es, de hecho, parte de
  // su propio dominio/subdominio público).
  const tenant = await resolverTenantActivoPorSlug(input.tenantSlug);

  let fila:
    | {
        id: string;
        tenant_id: string;
        nombre: string;
        email: string | null;
        dni: string | null;
        password_hash: string;
        rol: UsuarioPayload["rol"];
        token_version: number;
        debe_cambiar_password: boolean;
      }
    | undefined;
  if (tenant) {
    try {
      fila = await withTenant(tenant.id, async (client) => {
        // Correo o DNI, en el mismo campo (migración 0084). Lo que decide es
        // la presencia de "@": un DNI nunca lo tiene y un correo siempre sí,
        // así que no hay ambigüedad posible entre los dos.
        //
        // Se busca por UNA de las dos columnas, no por las dos en OR: buscar
        // por ambas dejaría que alguien entre con un DNI escrito en el campo
        // de correo de otra persona, y encima haría inútil el índice.
        const esCorreo = input.identificador.includes("@");
        const result = await client.query(
          `SELECT id, tenant_id, nombre, email, dni, password_hash, rol, token_version,
                  debe_cambiar_password
           FROM usuarios
            WHERE tenant_id = $1 AND activo = true
              AND ${esCorreo ? "email = $2" : "dni = $2"}`,
          [tenant.id, esCorreo ? input.identificador.toLowerCase() : input.identificador]
        );
        return result.rows[0];
      });
    } catch (err) {
      // Nunca reenviar al cliente el error crudo de la BD (puede filtrar
      // credenciales, nombres de tabla, etc.) — se loguea server-side y se
      // devuelve un mensaje genérico como cualquier otro fallo de login.
      logger.error({ err }, "Error de BD durante login");
      throw new AppError(401, "Credenciales inválidas");
    }
  }

  // Se compara siempre contra un hash (real o señuelo) para que el tiempo de
  // respuesta sea el mismo exista o no el correo — evita enumeración de
  // usuarios por timing.
  const passwordValido = await bcrypt.compare(input.password, fila?.password_hash ?? HASH_SEÑUELO);
  if (!fila || !passwordValido) {
    throw new AppError(401, "Credenciales inválidas");
  }

  const usuario: UsuarioPayload = {
    id: fila.id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    email: fila.email,
    dni: fila.dni,
    rol: fila.rol,
    modulosPermitidos: await obtenerModulosPermitidos(fila.id, fila.tenant_id),
    tokenVersion: fila.token_version,
    debeCambiarPassword: fila.debe_cambiar_password,
  };

  return emitirSesionCompleta(usuario);
}

/** "Continuar con Google": el ID token lo emite Google (GIS en el navegador),
 *  acá solo se verifica su firma/audiencia y se resuelve a un usuario ya
 *  existente en el tenant indicado — no hay auto-registro, alguien con rol
 *  admin tiene que haber dado de alta el usuario primero. */
export async function googleLoginService(
  input: GoogleLoginInput
): Promise<{ token: string; usuario: UsuarioPayload; refreshToken: string }> {
  if (!googleClient) {
    throw new AppError(503, "Login con Google no está configurado");
  }

  let email: string | undefined;
  let emailVerificado: boolean;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: input.credential,
      audience: env.googleLoginClientId,
    });
    const payload = ticket.getPayload();
    email = payload?.email?.toLowerCase();
    emailVerificado = payload?.email_verified === true;
  } catch (err) {
    logger.warn({ err }, "Token de Google inválido");
    throw new AppError(401, "No se pudo verificar tu cuenta de Google");
  }

  if (!email || !emailVerificado) {
    throw new AppError(401, "Tu cuenta de Google no tiene un email verificado");
  }

  // Mismo orden de dos pasos que loginService — ver comentario ahí.
  const tenant = await resolverTenantActivoPorSlug(input.tenantSlug);

  const fila = tenant
    ? await withTenant(tenant.id, async (client) => {
        const result = await client.query(
          `SELECT id, tenant_id, nombre, email, dni, rol, token_version, debe_cambiar_password
           FROM usuarios WHERE tenant_id = $1 AND email = $2 AND activo = true`,
          [tenant.id, email]
        );
        return result.rows[0];
      })
    : undefined;

  if (!fila) {
    // Mismo mensaje genérico sin importar si falló la resolución del
    // tenant o la búsqueda del usuario dentro de él: no confirmar ni negar
    // si el correo existe en otro tenant (evita enumeración).
    throw new AppError(401, "Esta cuenta de Google no tiene acceso a esta empresa");
  }

  const usuario: UsuarioPayload = {
    id: fila.id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    email: fila.email,
    dni: fila.dni,
    rol: fila.rol,
    modulosPermitidos: await obtenerModulosPermitidos(fila.id, fila.tenant_id),
    tokenVersion: fila.token_version,
    debeCambiarPassword: fila.debe_cambiar_password,
  };

  return emitirSesionCompleta(usuario);
}

/** Cambia el access token (30 min) por uno nuevo usando el refresh token de
 *  vida larga (30 días), sin pedir credenciales otra vez. Rota el refresh
 *  token en cada uso: el anterior queda revocado y no puede reutilizarse.
 *
 *  Si el refresh token presentado YA estaba revocado (reuso de un token
 *  que ya se había cambiado por otro), se asume robo/replay y se revocan
 *  TODOS los refresh tokens y sesiones de ese usuario como contención. */
export async function refrescarTokenService(
  refreshTokenPlano: string
): Promise<{ token: string; usuario: UsuarioPayload; refreshToken: string }> {
  const hash = hashRefreshToken(refreshTokenPlano);

  // Paso 1: refresh_tokens no tiene RLS, se consulta directo — y ya trae
  // tenant_id denormalizado (ver emitirRefreshToken), que es justo lo que
  // hace falta para poder abrir después una transacción withTenant() y
  // leer `usuarios` bajo RLS sin depender de un JOIN que ya no es posible
  // en una sola query.
  const tokenResult = await pool.query(
    `SELECT usuario_id, tenant_id, expira_en, revocado_en, session_id
     FROM refresh_tokens WHERE token_hash = $1`,
    [hash]
  );

  const filaToken = tokenResult.rows[0];
  if (!filaToken) {
    throw new AppError(401, "Sesión inválida, inicia sesión nuevamente");
  }

  if (filaToken.revocado_en) {
    logger.warn(
      { usuarioId: filaToken.usuario_id },
      "Reuso de refresh token detectado, revocando todas las sesiones"
    );
    await revocarSesionesService(filaToken.usuario_id, filaToken.tenant_id);
    throw new AppError(401, "Sesión inválida, inicia sesión nuevamente");
  }

  // Revoca el token presentado (se use o no más abajo) antes de seguir,
  // para que dos requests concurrentes con el mismo refresh token no
  // puedan generar dos pares de tokens válidos a la vez.
  await pool.query(`UPDATE refresh_tokens SET revocado_en = now() WHERE token_hash = $1`, [hash]);

  if (new Date(filaToken.expira_en).getTime() < Date.now()) {
    throw new AppError(401, "Sesión expirada, inicia sesión nuevamente");
  }

  // Paso 2: ahora sí, con tenant_id ya conocido, leer el usuario bajo RLS.
  const filaUsuario = await withTenant(filaToken.tenant_id, async (client) => {
    const result = await client.query(
      `SELECT nombre, email, dni, rol, token_version, activo, debe_cambiar_password
       FROM usuarios WHERE id = $1 AND tenant_id = $2`,
      [filaToken.usuario_id, filaToken.tenant_id]
    );
    return result.rows[0];
  });

  if (!filaUsuario || !filaUsuario.activo) {
    throw new AppError(401, "Sesión expirada, inicia sesión nuevamente");
  }

  const usuario: UsuarioPayload = {
    id: filaToken.usuario_id,
    tenantId: filaToken.tenant_id,
    nombre: filaUsuario.nombre,
    email: filaUsuario.email,
    dni: filaUsuario.dni,
    rol: filaUsuario.rol,
    modulosPermitidos: await obtenerModulosPermitidos(filaToken.usuario_id, filaToken.tenant_id),
    tokenVersion: filaUsuario.token_version,
    debeCambiarPassword: filaUsuario.debe_cambiar_password,
  };

  // Reusa emitirSesionCompleta() con el sessionId de la fila que se acaba
  // de rotar -- refrescar el access token EXTIENDE esta sesión, no crea
  // una nueva (ver el comentario de emitirSesionCompleta). Sin session_id
  // (fila emitida antes de migrations/0040) se genera uno nuevo ahí mismo,
  // sin caso especial: el primer refresh de cada dispositivo después del
  // deploy simplemente arranca a llevar sessionId de acá en más.
  return emitirSesionCompleta(usuario, filaToken.session_id);
}

/** Borra TODAS las keys `session:<usuarioId>:*` de Redis -- una por cada
 *  sesión activa del usuario (celular, PC, lo que tenga abierto). SCAN, no
 *  KEYS: esto puede correr con cualquier cantidad de keys en el Redis
 *  entero, y KEYS bloquea el server entero mientras recorre todo el
 *  keyspace -- SCAN no. No es una ruta caliente (revocación global: logout
 *  explícito de "todos los dispositivos", desactivar usuario, reset de
 *  contraseña, robo de refresh token detectado), así que el costo extra de
 *  iterar con cursor es irrelevante frente a hacerlo de la forma correcta. */
async function borrarTodasLasSesionesRedis(usuarioId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    const claves: string[] = [];
    const stream = redis.scanStream({ match: `session:${usuarioId}:*`, count: 100 });
    for await (const lote of stream as AsyncIterable<string[]>) {
      claves.push(...lote);
    }
    if (claves.length > 0) await redis.del(...claves);
  } catch (err) {
    logger.warn({ err }, "No se pudieron limpiar las sesiones en Redis durante la revocación");
  }
}

/** Revoca de una sola vez TODAS las sesiones activas de este usuario, en
 *  todos sus dispositivos (incrementa token_version en BD) — funciona con
 *  o sin Redis. Pensado para acciones que de verdad necesitan cerrar TODO:
 *  desactivar un usuario, resetear su contraseña, o contener un robo de
 *  refresh token detectado (ver refrescarTokenService). Para cerrar UNA
 *  sola sesión (logout normal, un dispositivo), ver logoutService().
 *
 *  Exige tenantId explícito (no se puede resolver desde `usuarios` sin
 *  saberlo ya, por RLS) — todos los callers ya lo tienen a mano (JWT del
 *  usuario o parámetro de ruta de plataforma). */
export async function revocarSesionesService(usuarioId: string, tenantId: string): Promise<void> {
  try {
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE usuarios SET token_version = token_version + 1 WHERE id = $1 AND tenant_id = $2`,
        [usuarioId, tenantId]
      )
    );
    // refresh_tokens no tiene RLS — se actualiza directo.
    await pool.query(
      `UPDATE refresh_tokens SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL`,
      [usuarioId]
    );
  } catch (err) {
    logger.error({ err }, "No se pudo incrementar token_version al revocar sesiones");
    throw new AppError(500, "No se pudo cerrar la sesión");
  }

  await invalidateCachedTokenVersion(usuarioId);
  await borrarTodasLasSesionesRedis(usuarioId);
}

/** Cierra SOLO la sesión actual (este dispositivo/navegador) -- las demás
 *  sesiones activas del usuario, si tiene, siguen funcionando. No toca
 *  token_version (eso derrumbaría TODAS las sesiones, ver
 *  revocarSesionesService) -- solo la fila de refresh_tokens y la key de
 *  Redis de esta sesión puntual.
 *
 *  sessionId puede faltar (JWT emitido antes de migrations/0040, o algún
 *  caller futuro sin sesión propia): en ese caso no hay una key puntual
 *  que borrar, así que no hace nada -- el access token de todos modos
 *  expira solo en `JWT_EXPIRES` (30 min). */
export async function logoutService(
  usuarioId: string,
  sessionId: string | undefined
): Promise<void> {
  if (!sessionId) return;

  await pool.query(
    `UPDATE refresh_tokens SET revocado_en = now()
     WHERE usuario_id = $1 AND session_id = $2 AND revocado_en IS NULL`,
    [usuarioId, sessionId]
  );

  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`session:${usuarioId}:${sessionId}`);
    } catch (err) {
      logger.warn({ err }, "No se pudo limpiar la sesión en Redis durante logout");
    }
  }
}

export async function crearUsuarioService(
  input: {
    tenantId: string;
    nombre: string;
    /** Opcional desde 0084: puede venir DNI en su lugar. */
    email?: string;
    dni?: string;
    password: string;
    rol?: UsuarioPayload["rol"];
  },
  // A diferencia de antes, este parámetro dejó de ser opcional en la
  // práctica: con `usuarios` bajo FORCE ROW LEVEL SECURITY, un INSERT con
  // el `pool` normal (sin transacción, sin app.tenant_id seteado) falla.
  // Todo caller real pasa el `client` de una transacción withTenant() ya
  // abierta con tenantId = input.tenantId — ver crearUsuarioEnTenantService
  // y crearTenantConAdminService en platform.service.ts. El default a
  // `pool` queda solo para no romper la firma del tipo, no como camino
  // funcional.
  db: Pool | PoolClient = pool
): Promise<UsuarioPayload> {
  const passwordHash = await bcrypt.hash(input.password, 12);

  let result;
  try {
    // debe_cambiar_password = true siempre: quien llama a esto le puso la
    // contraseña a otra persona (panel o SCIM), nunca es la propia del
    // usuario -- mismo criterio que crearPlatformAdminService.
    result = await db.query(
      `INSERT INTO usuarios (tenant_id, nombre, email, dni, password_hash, rol, debe_cambiar_password)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::rol_usuario, 'operador'), true)
       RETURNING id, tenant_id, nombre, email, dni, rol, token_version, debe_cambiar_password`,
      [
        input.tenantId,
        input.nombre,
        input.email?.toLowerCase() ?? null,
        input.dni ?? null,
        passwordHash,
        input.rol ?? null,
      ]
    );
  } catch (err) {
    // Mismo criterio que loginService: nunca reenviar el error crudo de la
    // BD al cliente (podría filtrar nombres de tabla/constraint).
    if (esViolacionUnicidad(err)) {
      // Puede ser el correo O el DNI: los dos tienen unicidad por tenant.
      throw new AppError(409, "Ya existe un usuario con ese correo o DNI en este tenant");
    }
    logger.error({ err }, "Error de BD al crear usuario");
    throw new AppError(500, "No se pudo crear el usuario");
  }

  const fila = result.rows[0];

  // Por defecto, un usuario nuevo queda asignado a todo lo que su tenant
  // no tenga explícitamente deshabilitado — incluye 'rollout' a propósito:
  // la asignación acá es "en principio lo puede ver", la visibilidad real
  // de un módulo en rollout la decide el bucketing determinístico de
  // obtenerModulosPermitidos() en cada login. El panel de plataforma puede
  // después restringirlo módulo por módulo (ver actualizarModulosUsuarioService
  // en platform.service.ts).
  const modulosHabilitados = (
    await db.query(
      `SELECT modulo FROM tenant_modulos WHERE tenant_id = $1 AND estado != 'deshabilitado'`,
      [input.tenantId]
    )
  ).rows.map((r) => r.modulo as string);

  if (modulosHabilitados.length > 0) {
    const placeholders = modulosHabilitados.map((_, i) => `($1, $${i + 2})`).join(", ");
    await db.query(
      `INSERT INTO usuario_modulos (usuario_id, modulo) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      [fila.id, ...modulosHabilitados]
    );
  }

  return {
    id: fila.id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    email: fila.email,
    dni: fila.dni,
    rol: fila.rol,
    modulosPermitidos: modulosHabilitados,
    tokenVersion: fila.token_version,
    debeCambiarPassword: fila.debe_cambiar_password,
  };
}

// ── Recuperación de contraseña ───────────────────────────────────────────

const MENSAJE_RECUPERACION =
  "Si el correo existe en nuestros registros, te enviamos instrucciones para recuperar tu contraseña.";

export interface TenantParaRecuperacion {
  id: string;
  slug: string;
  dominioPersonalizado: string | null;
}

/** Exportada además de para recuperación de contraseña: tenantSso.service.ts
 *  la reusa para resolver tenant por slug (arrancar el flujo OIDC) y para
 *  construir la URL de vuelta tras el callback (ver construirUrlTenant) —
 *  mismo shape que ya hacía falta ahí (id + slug + dominioPersonalizado). */
export async function resolverTenantParaRecuperacion(
  tenantSlug: string
): Promise<TenantParaRecuperacion | undefined> {
  const result = await pool.query(
    `SELECT id, slug, dominio_personalizado AS "dominioPersonalizado" FROM tenants WHERE slug = $1 AND activo = true`,
    [tenantSlug]
  );
  return result.rows[0];
}

/** Mismo orden de prioridad que resolveTenantSubdomain.ts, pero al revés:
 *  ahí se parte de un Host y se llega al tenant; acá se parte del tenant y
 *  se arma la URL por la que ese tenant entra — dominio propio primero,
 *  subdominio de la plataforma como respaldo, y APP_PUBLIC_URL solo si
 *  ninguno de los dos está configurado (el caso de hoy, en desarrollo). */
export function construirUrlTenant(tenant: TenantParaRecuperacion): string {
  if (tenant.dominioPersonalizado) return `https://${tenant.dominioPersonalizado}`;
  if (env.appApexDomain) return `https://${tenant.slug}.${env.appApexDomain}`;
  return env.appPublicUrl;
}

async function enviarCorreoRecuperacion(params: {
  nombre: string;
  email: string;
  tenant: TenantParaRecuperacion;
  tokenPlano: string;
}) {
  if (!transporter || !emailConfigured) {
    logger.warn("No se pudo enviar el correo de recuperación: SMTP no configurado");
    return;
  }

  const link = `${construirUrlTenant(params.tenant)}/reset-password?token=${params.tokenPlano}`;
  const nombreSeguro = escapeHtml(params.nombre);

  const text = [
    `Hola ${params.nombre},`,
    "",
    "Recibimos una solicitud para restablecer tu contraseña en MinCore ERP.",
    "Este link vence en 1 hora:",
    link,
    "",
    "Si no pediste esto, ignora este correo — tu contraseña actual sigue funcionando.",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">Recuperar contraseña</h2>
      <p>Hola ${nombreSeguro},</p>
      <p>Recibimos una solicitud para restablecer tu contraseña en MinCore ERP. Este link vence en 1 hora:</p>
      <p><a href="${link}" style="color:#0f172a;">${link}</a></p>
      <p>Si no pediste esto, ignora este correo — tu contraseña actual sigue funcionando.</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"MinCore ERP" <${env.emailUser}>`,
      to: params.email,
      subject: "Recuperar contraseña - MinCore ERP",
      text,
      html,
    });
  } catch (err) {
    logger.error({ err }, "No se pudo enviar el correo de recuperación de contraseña");
  }
}

/** Siempre responde el mismo mensaje genérico, exista o no el
 *  tenant/usuario — mismo criterio anti-enumeración que loginService. El
 *  trabajo real (buscar usuario, generar token, enviar correo) ocurre
 *  igual dentro de un try/catch que nunca relanza: un fallo de BD o de
 *  SMTP no debe delatar nada distinto de "no existe" al que llama. */
export async function solicitarRecuperacionService(
  input: ForgotPasswordInput
): Promise<{ message: string }> {
  try {
    const tenant = await resolverTenantParaRecuperacion(input.tenantSlug);

    if (tenant) {
      const fila = await withTenant(tenant.id, async (client) => {
        const result = await client.query(
          `SELECT id, nombre, email FROM usuarios WHERE tenant_id = $1 AND email = $2 AND activo = true`,
          [tenant.id, input.email.toLowerCase()]
        );
        return result.rows[0];
      });

      if (fila) {
        const tokenPlano = randomBytes(48).toString("hex");
        const expiraEn = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

        await pool.query(
          `INSERT INTO reset_tokens (usuario_id, tenant_id, token_hash, expira_en) VALUES ($1, $2, $3, $4)`,
          [fila.id, tenant.id, hashRefreshToken(tokenPlano), expiraEn]
        );

        await enviarCorreoRecuperacion({
          nombre: fila.nombre,
          email: fila.email,
          tenant,
          tokenPlano,
        });
      }
    }
  } catch (err) {
    logger.error({ err }, "Error al procesar solicitud de recuperación de contraseña");
  }

  return { message: MENSAJE_RECUPERACION };
}

/** El token ya identifica usuario + tenant (ver reset_tokens.tenant_id,
 *  mismo motivo que refresh_tokens.tenant_id) — no hace falta que el
 *  cliente mande tenantSlug de nuevo. Cambiar la contraseña revoca todas
 *  las sesiones activas (mismo criterio que desactivar un usuario, ver
 *  cambiarEstadoUsuarioService en platform.service.ts). */
export async function restablecerPasswordService(input: ResetPasswordInput): Promise<void> {
  const hash = hashRefreshToken(input.token);

  const tokenResult = await pool.query(
    `SELECT usuario_id, tenant_id, expira_en, usado_en FROM reset_tokens WHERE token_hash = $1`,
    [hash]
  );
  const fila = tokenResult.rows[0];

  if (!fila || fila.usado_en || new Date(fila.expira_en).getTime() < Date.now()) {
    throw new AppError(400, "El link de recuperación es inválido o expiró");
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 12);

  const actualizado = await withTenant(fila.tenant_id, (client) =>
    client.query(
      `UPDATE usuarios SET password_hash = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id`,
      [passwordHash, fila.usuario_id, fila.tenant_id]
    )
  );

  // El UPDATE con WHERE que no matchea ninguna fila no lanza error en
  // Postgres -- sin este chequeo, un 0-row update seguía de largo,
  // marcaba el token como usado y revocaba las sesiones, devolviendo
  // éxito al cliente con la contraseña vieja intacta (bug reportado por
  // Kenif: "cambio la clave y el ERP no la reconoce").
  if (actualizado.rowCount === 0) {
    throw new AppError(400, "No se pudo actualizar la contraseña, el usuario ya no existe");
  }

  await pool.query(`UPDATE reset_tokens SET usado_en = now() WHERE token_hash = $1`, [hash]);

  await revocarSesionesService(fila.usuario_id, fila.tenant_id);
}

/** El admin del tenant le pone una clave temporal a alguien de su empresa.
 *
 *  Hace falta porque desde la migración 0084 hay gente que entra con DNI y
 *  NO TIENE CORREO: el flujo de "olvidé mi contraseña" les manda un enlace a
 *  ninguna parte. Sin esto, un grifero que se olvida la clave queda afuera
 *  hasta que alguien toque la base a mano.
 *
 *  Deja `debe_cambiar_password = true` a propósito: la clave que tipeó el
 *  admin sirve UNA vez, para entrar, y el sistema obliga a cambiarla ahí
 *  mismo -- así el admin no termina sabiendo la contraseña con la que su
 *  empleado firma vales. Es el mismo mecanismo del alta (#113/#114).
 *
 *  Y revoca las sesiones: resetear la clave sin cerrar sesiones dejaría
 *  adentro a quien la supiera, que es justo el caso del que uno se está
 *  defendiendo cuando resetea. */
export async function resetearClaveUsuarioService(
  tenantId: string,
  usuarioId: string,
  passwordNueva: string
): Promise<{ id: string; nombre: string; email: string | null; dni: string | null }> {
  const passwordHash = await bcrypt.hash(passwordNueva, 12);

  const fila = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE usuarios
          SET password_hash = $1, debe_cambiar_password = true, actualizado_en = now()
        WHERE id = $2 AND tenant_id = $3
        RETURNING id, nombre, email, dni`,
      [passwordHash, usuarioId, tenantId]
    );
    return result.rows[0];
  });
  if (!fila) throw new AppError(404, "Usuario no encontrado");

  await revocarSesionesService(usuarioId, tenantId);

  return fila;
}

/** Cambia la propia contraseña de un usuario de tenant ya autenticado --
 *  mismo patrón que cambiarMiPasswordService de platform_admins, pensado
 *  primero para la pantalla obligatoria del primer login con clave
 *  temporal (ver debeCambiarPassword en UsuarioPayload), pero sirve para
 *  cualquier cambio voluntario después. A diferencia de platform_admins,
 *  `usuarios` tiene RLS: hace falta withTenant(). */
export async function cambiarMiPasswordUsuarioService(
  usuarioId: string,
  tenantId: string,
  passwordActual: string,
  passwordNueva: string
): Promise<void> {
  const fila = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT password_hash FROM usuarios WHERE id = $1 AND tenant_id = $2`,
      [usuarioId, tenantId]
    );
    return result.rows[0];
  });
  if (!fila) throw new AppError(404, "Usuario no encontrado");

  const passwordValido = await bcrypt.compare(passwordActual, fila.password_hash);
  if (!passwordValido) throw new AppError(401, "Contraseña actual incorrecta");

  const passwordHash = await bcrypt.hash(passwordNueva, 12);
  const actualizado = await withTenant(tenantId, (client) =>
    client.query(
      `UPDATE usuarios SET password_hash = $1, debe_cambiar_password = false
       WHERE id = $2 AND tenant_id = $3 RETURNING id`,
      [passwordHash, usuarioId, tenantId]
    )
  );

  // Mismo chequeo que ya aplicamos hoy en cambiarMiPasswordService
  // (platform_admins): un UPDATE con WHERE que no matchea ninguna fila no
  // lanza error en Postgres -- sin esto, declararía éxito aunque la cuenta
  // haya sido desactivada/borrada justo entre el SELECT y este UPDATE.
  if (actualizado.rowCount === 0) {
    throw new AppError(400, "No se pudo actualizar la contraseña, el usuario ya no existe");
  }
}
