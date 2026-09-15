/** src/server/services/auth.service.ts */

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { randomBytes, randomUUID, createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool, withTenant, withCuenta } from "../config/database";
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
  ElegirEmpresaInput,
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
  /** El id del PERFIL (usuarios.id), no el de la persona. Las sesiones, los
   *  módulos, la auditoría y la cola offline del cliente cuelgan del perfil, a
   *  propósito: ver docs/architecture/cuentas-perfiles-y-administracion.md §4. */
  id: string;
  /** La cuenta (la persona) detrás de este perfil, desde la migración 0087.
   *  null en los accesos por DNI del personal operativo, que no tienen
   *  cuenta: su clave vive en el perfil. */
  cuentaId: string | null;
  tenantId: string;
  nombre: string;
  /** Puede ser null desde 0084: un usuario de cancha entra con DNI y no
   *  tiene correo. Todo lo que le mande un mail tiene que contemplarlo. */
  email: string | null;
  dni?: string | null;
  /** admin > operador > lectura es una escalera; `grifero` y
   *  `conductor_ruta` (migración 0085) NO están en esa escalera -- son
   *  recortes laterales, en direcciones distintas entre sí. Por eso
   *  requireRole recibe una LISTA de roles y no un nivel mínimo. */
  rol: "admin" | "operador" | "lectura" | "grifero" | "conductor_ruta";
  /** Intersección de tenant_modulos (habilitados para la empresa) y
   *  usuario_modulos (asignados a este usuario) al momento del login/
   *  refresh — ver obtenerModulosPermitidos(). Igual que `rol`, un cambio
   *  hecho desde el panel de plataforma tarda hasta el próximo login/
   *  refresh en reflejarse; no se re-consulta en cada request. */
  modulosPermitidos: string[];
  /** Los módulos de `modulosPermitidos` en los que este perfil NO puede
   *  escribir: los ve y los exporta, nada más (migración 0089, las
   *  "autonomías" que pidió Kenif). Ausente en los JWT emitidos antes de esa
   *  migración, y ausente significa "puede operar en todos" -- que es lo que
   *  valía hasta entonces. */
  modulosConsulta?: string[];
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
/** Módulos a los que un ROL da acceso, cuando el rol acota. Los roles de
 *  oficina (admin/operador/lectura) no aparecen acá: para ellos manda solo
 *  lo que el tenant y el panel de plataforma les hayan asignado.
 *
 *  Los de cancha sí acotan, y a propósito no se resuelve desmarcando módulos
 *  usuario por usuario: un grifero nuevo entra cada tanto, y si el alta
 *  dependiera de que alguien se acuerde de desmarcarle seis módulos, el
 *  primer olvido le da acceso a IPERC y a Órdenes de Trabajo. El rol lo dice
 *  una vez y vale para todos. */
const MODULOS_POR_ROL: Partial<Record<UsuarioPayload["rol"], string[]>> = {
  grifero: ["combustible"],
  conductor_ruta: ["combustible"],
};

export async function obtenerModulosPermitidos(
  usuarioId: string,
  tenantId: string,
  /** Sin el rol, un grifero recibiría los mismos módulos que un operador:
   *  `crearUsuarioService` le asigna TODOS los del tenant al darlo de alta. */
  rol: UsuarioPayload["rol"],
  db: Pool | PoolClient = pool
): Promise<string[]> {
  return (await obtenerModulosConNivel(usuarioId, tenantId, rol, db)).map((m) => m.modulo);
}

export interface ModuloConNivel {
  modulo: string;
  nivel: "operar" | "consultas";
}

/** Los módulos que este perfil ve, con qué nivel (migración 0089).
 *
 *  Es la misma consulta de siempre más la columna `nivel`; `obtenerModulos
 *  Permitidos` quedó como la vista corta de esto, para no tocar a sus veinte
 *  llamadores. */
export async function obtenerModulosConNivel(
  usuarioId: string,
  tenantId: string,
  rol: UsuarioPayload["rol"],
  db: Pool | PoolClient = pool
): Promise<ModuloConNivel[]> {
  const result = await db.query(
    `SELECT um.modulo, um.nivel, tm.estado, tm.rollout_porcentaje AS "rolloutPorcentaje"
     FROM usuario_modulos um
     JOIN tenant_modulos tm ON tm.tenant_id = $2 AND tm.modulo = um.modulo
     WHERE um.usuario_id = $1`,
    [usuarioId, tenantId]
  );

  const permitidosPorRol = MODULOS_POR_ROL[rol];

  return result.rows
    .filter((fila) => {
      // El rol RECORTA, nunca agrega: si el tenant no tiene el módulo
      // habilitado, ningún rol lo trae de vuelta.
      if (permitidosPorRol && !permitidosPorRol.includes(fila.modulo)) return false;
      if (fila.estado === "habilitado") return true;
      if (fila.estado === "deshabilitado") return false;
      return enBucketDeRollout(tenantId, fila.modulo, usuarioId, fila.rolloutPorcentaje ?? 0);
    })
    .map((fila) => ({
      modulo: fila.modulo as string,
      nivel: fila.nivel as "operar" | "consultas",
    }));
}

/** Los módulos del perfil en los que solo puede consultar. Va al JWT junto a
 *  `modulosPermitidos`: quien decide si una escritura pasa es el router del
 *  ERP, en cada request, sin volver a la base. */
export function soloConsulta(modulos: ModuloConNivel[]): string[] {
  return modulos.filter((m) => m.nivel === "consultas").map((m) => m.modulo);
}

/** Solo para exponer al cliente: nunca se envía tokenVersion ni sessionId
 *  en las respuestas HTTP (login, /me) — son detalles internos de
 *  revocación/sesión, el cliente no necesita saber su propio sessionId (ya
 *  viaja, invisible, dentro de la cookie httpOnly). `cuentaId` tampoco sale:
 *  es el id de la persona detrás del perfil, y ninguna pantalla lo usa. */
export type UsuarioPublico = Omit<UsuarioPayload, "tokenVersion" | "sessionId" | "cuentaId">;

export function aPublico(usuario: UsuarioPayload): UsuarioPublico {
  const {
    tokenVersion: _tokenVersion,
    sessionId: _sessionId,
    cuentaId: _cuentaId,
    ...publico
  } = usuario;
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

// ── Cuentas: la persona detrás de los perfiles (migración 0087) ─────────
//
// `cuentas` no tiene tenant_id ni RLS -- es anterior a cualquier empresa,
// igual que `tenants`. Solo la lee y escribe este servicio.

export interface PerfilDeCuenta {
  usuarioId: string;
  tenantId: string;
  tenantNombre: string;
  tenantSlug: string;
  nombre: string;
  rol: UsuarioPayload["rol"];
}

interface CuentaFila {
  id: string;
  email: string;
  password_hash: string | null;
  debe_cambiar_password: boolean;
  activo: boolean;
  ultimo_tenant_id: string | null;
}

async function buscarCuentaPorEmail(email: string): Promise<CuentaFila | undefined> {
  const result = await pool.query(
    `SELECT id, email, password_hash, debe_cambiar_password, activo, ultimo_tenant_id
       FROM cuentas WHERE email = $1`,
    [email.trim().toLowerCase()]
  );
  return result.rows[0];
}

/** Los perfiles ACTIVOS de una cuenta, en empresas activas.
 *
 *  `withCuenta` exige que la cuenta ya esté autenticada (clave verificada,
 *  token de selección validado o SSO resuelto) -- ver database.ts. */
export async function perfilesDeCuenta(cuentaId: string): Promise<PerfilDeCuenta[]> {
  return withCuenta(cuentaId, async (client) => {
    const result = await client.query(
      `SELECT u.id, u.tenant_id, u.nombre, u.rol,
              t.nombre AS tenant_nombre, t.slug AS tenant_slug
         FROM usuarios u
         JOIN tenants t ON t.id = u.tenant_id
        WHERE u.cuenta_id = $1 AND u.activo = true AND t.activo = true
        ORDER BY t.nombre`,
      [cuentaId]
    );
    return result.rows.map((f) => ({
      usuarioId: f.id,
      tenantId: f.tenant_id,
      tenantNombre: f.tenant_nombre,
      tenantSlug: f.tenant_slug,
      nombre: f.nombre,
      rol: f.rol as UsuarioPayload["rol"],
    }));
  });
}

/** Best-effort: si falla, la persona simplemente no ve preseleccionada su
 *  última empresa. Nunca debe voltear un login que ya salió bien. */
async function recordarUltimaEmpresa(cuentaId: string, tenantId: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE cuentas SET ultimo_tenant_id = $2, actualizado_en = now() WHERE id = $1`,
      [cuentaId, tenantId]
    );
  } catch (err) {
    logger.warn({ err, cuentaId }, "No se pudo recordar la última empresa de la cuenta");
  }
}

/** Arma la sesión de UN perfil concreto, leyendo su estado fresco de la base.
 *
 *  Lo comparten el login por correo, la elección de empresa y --en la entrega
 *  2-- el cambio de empresa sin salir. El mensaje de error es siempre el
 *  genérico de credenciales: quien llega hasta acá ya se autenticó, y un
 *  mensaje distinto delataría en qué empresas tiene o no tiene perfil. */
export async function emitirSesionParaPerfil(
  usuarioId: string,
  tenantId: string
): Promise<{ token: string; usuario: UsuarioPayload; refreshToken: string }> {
  const fila = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT u.id, u.tenant_id, u.cuenta_id, u.nombre, u.email, u.dni, u.rol,
              u.token_version, u.debe_cambiar_password, u.activo,
              c.email AS cuenta_email,
              c.debe_cambiar_password AS cuenta_debe_cambiar,
              c.activo AS cuenta_activa
         FROM usuarios u
         LEFT JOIN cuentas c ON c.id = u.cuenta_id
        WHERE u.id = $1 AND u.tenant_id = $2`,
      [usuarioId, tenantId]
    );
    return result.rows[0];
  });

  if (!fila || !fila.activo || (fila.cuenta_id && fila.cuenta_activa === false)) {
    throw new AppError(401, "Credenciales inválidas");
  }

  const modulos = await obtenerModulosConNivel(fila.id, fila.tenant_id, fila.rol);

  const usuario: UsuarioPayload = {
    id: fila.id,
    cuentaId: fila.cuenta_id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    // El correo de la cuenta manda: el del perfil es una copia (ver §4 del
    // documento de arquitectura).
    email: fila.cuenta_email ?? fila.email,
    dni: fila.dni,
    rol: fila.rol,
    modulosPermitidos: modulos.map((m) => m.modulo),
    modulosConsulta: soloConsulta(modulos),
    tokenVersion: fila.token_version,
    debeCambiarPassword: fila.cuenta_id ? fila.cuenta_debe_cambiar : fila.debe_cambiar_password,
  };

  if (fila.cuenta_id) await recordarUltimaEmpresa(fila.cuenta_id, tenantId);

  return emitirSesionCompleta(usuario);
}

// ── Token de selección de empresa ───────────────────────────────────────
//
// Cuando la persona tiene perfil en varias empresas, el login valida la clave
// y devuelve la lista junto a este token, que vale 2 minutos. La clave no
// vuelve a viajar.
//
// Lleva una huella de la clave vigente: si la persona la cambia (o se la
// resetean) entre el paso 1 y el 2, el token deja de servir sin necesidad de
// guardarlo en ninguna tabla.

const SELECCION_TTL_SEGUNDOS = 120;

interface TokenSeleccion {
  tipo: "seleccion-empresa";
  cuentaId: string;
  huella: string;
}

function huellaDeClave(hash: string | null): string {
  return createHash("sha256")
    .update(hash ?? "sin-clave")
    .digest("hex")
    .slice(0, 16);
}

function firmarTokenSeleccion(cuenta: CuentaFila): string {
  const payload: TokenSeleccion = {
    tipo: "seleccion-empresa",
    cuentaId: cuenta.id,
    huella: huellaDeClave(cuenta.password_hash),
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: SELECCION_TTL_SEGUNDOS });
}

export interface EleccionPendiente {
  tipo: "elegir-empresa";
  tokenSeleccion: string;
  empresas: { tenantId: string; nombre: string; slug: string }[];
  ultimoTenantId: string | null;
}

export interface SesionEmitida {
  tipo: "sesion";
  token: string;
  usuario: UsuarioPayload;
  refreshToken: string;
}

export type ResultadoAutenticacion = SesionEmitida | EleccionPendiente;

/** Paso 2 del login: canjea el token de selección por la sesión de una
 *  empresa. Verifica de nuevo que el perfil exista y esté activo -- entre los
 *  dos pasos pudo haber cambiado. */
export async function elegirEmpresaService(input: ElegirEmpresaInput): Promise<SesionEmitida> {
  let payload: TokenSeleccion;
  try {
    payload = jwt.verify(input.token, JWT_SECRET) as TokenSeleccion;
  } catch {
    throw new AppError(401, "La elección de empresa expiró, volvé a iniciar sesión");
  }
  if (payload.tipo !== "seleccion-empresa") {
    throw new AppError(401, "La elección de empresa expiró, volvé a iniciar sesión");
  }

  const cuenta = await pool.query(`SELECT id, password_hash, activo FROM cuentas WHERE id = $1`, [
    payload.cuentaId,
  ]);
  const fila = cuenta.rows[0];
  if (!fila || !fila.activo || huellaDeClave(fila.password_hash) !== payload.huella) {
    throw new AppError(401, "La elección de empresa expiró, volvé a iniciar sesión");
  }

  const perfiles = await perfilesDeCuenta(payload.cuentaId);
  const elegido = perfiles.find((perfil) => perfil.tenantId === input.tenantId);
  if (!elegido) {
    // Genérico a propósito: no se confirma ni se niega que la empresa exista.
    throw new AppError(401, "Credenciales inválidas");
  }

  const sesion = await emitirSesionParaPerfil(elegido.usuarioId, elegido.tenantId);
  return { tipo: "sesion", ...sesion };
}

/** Entrar. Dos caminos, según lo que se escriba en el campo:
 *
 *  - **Correo** (administrativos): la persona tiene UNA cuenta y sus perfiles
 *    cuelgan de ella. No hace falta decir la empresa: si tiene una, entra
 *    directo; si tiene varias, las elige DESPUÉS de validar la clave.
 *  - **DNI** (operativos de cancha): sigue siendo por empresa, y la empresa
 *    tiene que venir de la dirección por la que entró.
 *
 *  Lo que decide es la presencia de "@": un DNI nunca lo tiene y un correo
 *  siempre sí. */
export async function loginService(input: LoginInput): Promise<ResultadoAutenticacion> {
  return input.identificador.includes("@") ? loginConCorreo(input) : loginConDni(input);
}

async function loginConCorreo(input: LoginInput): Promise<ResultadoAutenticacion> {
  const cuenta = await buscarCuentaPorEmail(input.identificador);

  // Se compara SIEMPRE contra un hash (real o señuelo) para que el tiempo de
  // respuesta sea el mismo exista o no el correo -- evita enumeración por
  // timing, igual que antes de 0087.
  const claveValida = await bcrypt.compare(input.password, cuenta?.password_hash ?? HASH_SEÑUELO);

  // `password_hash` nulo = invitación todavía sin aceptar (entrega 3): la
  // cuenta existe pero no tiene clave, así que no puede entrar con una.
  if (!cuenta || !cuenta.activo || !cuenta.password_hash || !claveValida) {
    throw new AppError(401, "Credenciales inválidas");
  }

  let perfiles = await perfilesDeCuenta(cuenta.id);

  // Si el request entró por la dirección de una empresa (subdominio o dominio
  // propio, ver resolveTenantSubdomain), la sesión es de esa empresa y de
  // ninguna otra. Sin perfil ahí, el MISMO 401 de siempre: nunca se revela
  // que la persona tiene perfil en otra.
  if (input.tenantSlug) {
    perfiles = perfiles.filter((perfil) => perfil.tenantSlug === input.tenantSlug);
  }

  if (perfiles.length === 0) {
    throw new AppError(401, "Credenciales inválidas");
  }

  if (perfiles.length === 1) {
    const sesion = await emitirSesionParaPerfil(perfiles[0].usuarioId, perfiles[0].tenantId);
    return { tipo: "sesion", ...sesion };
  }

  return {
    tipo: "elegir-empresa",
    tokenSeleccion: firmarTokenSeleccion(cuenta),
    empresas: perfiles.map((perfil) => ({
      tenantId: perfil.tenantId,
      nombre: perfil.tenantNombre,
      slug: perfil.tenantSlug,
    })),
    ultimoTenantId: cuenta.ultimo_tenant_id,
  };
}

/** El DNI no es único entre empresas: dos mineras pueden tener cargado al
 *  mismo conductor. Sin la empresa no hay a quién buscar, y como ya no existe
 *  el campo "Empresa" en el login, la respuesta no es "credenciales
 *  inválidas" --que mandaría al grifero a probar su clave diez veces-- sino
 *  decirle por dónde entrar. */
export const MENSAJE_DNI_SIN_EMPRESA =
  "Entrá desde la dirección de tu empresa para ingresar con tu DNI";

async function loginConDni(input: LoginInput): Promise<ResultadoAutenticacion> {
  if (!input.tenantSlug) {
    throw new AppError(400, MENSAJE_DNI_SIN_EMPRESA);
  }

  const tenant = await resolverTenantActivoPorSlug(input.tenantSlug);

  let fila: { id: string; tenant_id: string; password_hash: string | null } | undefined;
  if (tenant) {
    try {
      fila = await withTenant(tenant.id, async (client) => {
        // `cuenta_id IS NULL`: un perfil con cuenta entra por su correo. Sin
        // esto, alguien administrativo con DNI cargado tendría dos puertas, y
        // la del DNI usaría la clave vieja del perfil en vez de la de su
        // cuenta.
        const result = await client.query(
          `SELECT id, tenant_id, password_hash
             FROM usuarios
            WHERE tenant_id = $1 AND activo = true AND dni = $2 AND cuenta_id IS NULL`,
          [tenant.id, input.identificador]
        );
        return result.rows[0];
      });
    } catch (err) {
      // Nunca reenviar al cliente el error crudo de la BD.
      logger.error({ err }, "Error de BD durante login por DNI");
      throw new AppError(401, "Credenciales inválidas");
    }
  }

  const claveValida = await bcrypt.compare(input.password, fila?.password_hash ?? HASH_SEÑUELO);
  if (!fila || !claveValida) {
    throw new AppError(401, "Credenciales inválidas");
  }

  const sesion = await emitirSesionParaPerfil(fila.id, fila.tenant_id);
  return { tipo: "sesion", ...sesion };
}

/** "Continuar con Google": el ID token lo emite Google (GIS en el navegador),
 *  acá solo se verifica su firma/audiencia. Que Google confirme el correo
 *  equivale a validar la clave, así que desde ahí sigue el MISMO camino que
 *  `loginConCorreo`: se busca la cuenta, se listan sus perfiles y se elige
 *  empresa si hay varias.
 *
 *  No hay auto-registro: si el correo no tiene cuenta, o la cuenta no tiene
 *  perfil en ninguna empresa (o en la empresa por la que entró), no entra. */
export async function googleLoginService(input: GoogleLoginInput): Promise<ResultadoAutenticacion> {
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

  const cuenta = await buscarCuentaPorEmail(email);
  if (!cuenta || !cuenta.activo) {
    // Mismo mensaje sin importar si la cuenta no existe o no tiene acceso:
    // no se confirma ni se niega que el correo esté registrado.
    throw new AppError(401, "Esta cuenta de Google no tiene acceso a esta empresa");
  }

  let perfiles = await perfilesDeCuenta(cuenta.id);
  if (input.tenantSlug) {
    perfiles = perfiles.filter((perfil) => perfil.tenantSlug === input.tenantSlug);
  }

  if (perfiles.length === 0) {
    throw new AppError(401, "Esta cuenta de Google no tiene acceso a esta empresa");
  }

  if (perfiles.length === 1) {
    const sesion = await emitirSesionParaPerfil(perfiles[0].usuarioId, perfiles[0].tenantId);
    return { tipo: "sesion", ...sesion };
  }

  return {
    tipo: "elegir-empresa",
    tokenSeleccion: firmarTokenSeleccion(cuenta),
    empresas: perfiles.map((perfil) => ({
      tenantId: perfil.tenantId,
      nombre: perfil.tenantNombre,
      slug: perfil.tenantSlug,
    })),
    ultimoTenantId: cuenta.ultimo_tenant_id,
  };
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
      `SELECT u.nombre, u.email, u.dni, u.rol, u.token_version, u.activo,
              u.debe_cambiar_password, u.cuenta_id,
              c.email AS cuenta_email,
              c.debe_cambiar_password AS cuenta_debe_cambiar,
              c.activo AS cuenta_activa
         FROM usuarios u
         LEFT JOIN cuentas c ON c.id = u.cuenta_id
        WHERE u.id = $1 AND u.tenant_id = $2`,
      [filaToken.usuario_id, filaToken.tenant_id]
    );
    return result.rows[0];
  });

  // Una cuenta desactivada desde plataforma corta también el refresco, no
  // solo el login: si no, la sesión se seguiría renovando sola hasta que
  // venza el refresh token.
  if (
    !filaUsuario ||
    !filaUsuario.activo ||
    (filaUsuario.cuenta_id && filaUsuario.cuenta_activa === false)
  ) {
    throw new AppError(401, "Sesión expirada, inicia sesión nuevamente");
  }

  const modulosDelRefresh = await obtenerModulosConNivel(
    filaToken.usuario_id,
    filaToken.tenant_id,
    filaUsuario.rol
  );

  const usuario: UsuarioPayload = {
    id: filaToken.usuario_id,
    cuentaId: filaUsuario.cuenta_id,
    tenantId: filaToken.tenant_id,
    nombre: filaUsuario.nombre,
    email: filaUsuario.cuenta_email ?? filaUsuario.email,
    dni: filaUsuario.dni,
    rol: filaUsuario.rol,
    modulosPermitidos: modulosDelRefresh.map((m) => m.modulo),
    modulosConsulta: soloConsulta(modulosDelRefresh),
    tokenVersion: filaUsuario.token_version,
    debeCambiarPassword: filaUsuario.cuenta_id
      ? filaUsuario.cuenta_debe_cambiar
      : filaUsuario.debe_cambiar_password,
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

/** Revoca las sesiones de una cuenta en TODAS sus empresas.
 *
 *  Es lo que hace falta cuando cambia algo de la persona y no de una empresa:
 *  cambio de clave, recuperación, o desactivación de la cuenta desde
 *  plataforma. Se implementa recorriendo sus perfiles y usando la revocación
 *  de siempre en cada uno -- así el middleware de autenticación no cambia:
 *  sigue comparando `token_version` del PERFIL.
 *
 *  Incluye los perfiles inactivos a propósito: un perfil que se dio de baja
 *  hace un minuto todavía puede tener una sesión viva. */
export async function revocarSesionesDeCuentaService(cuentaId: string): Promise<void> {
  const perfiles = await withCuenta(cuentaId, async (client) => {
    const result = await client.query(`SELECT id, tenant_id FROM usuarios WHERE cuenta_id = $1`, [
      cuentaId,
    ]);
    return result.rows as { id: string; tenant_id: string }[];
  });

  for (const perfil of perfiles) {
    await revocarSesionesService(perfil.id, perfil.tenant_id);
  }
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

// ═══════════════ CAMBIAR DE EMPRESA SIN SALIR (entrega 2) ═══════════════

export interface EmpresaDelUsuario {
  tenantId: string;
  nombre: string;
  slug: string;
  /** La empresa de la sesión que está abierta ahora mismo. */
  actual: boolean;
}

/** Las empresas a las que esta persona puede pasar sin volver a entrar.
 *
 *  Devuelve lista vacía para el personal operativo (entra por DNI, no tiene
 *  cuenta): su acceso es de UNA empresa y no hay a dónde cambiar. El cliente
 *  usa eso para no mostrar el selector. */
export async function misEmpresasService(usuario: UsuarioPayload): Promise<EmpresaDelUsuario[]> {
  if (!usuario.cuentaId) return [];

  const perfiles = await perfilesDeCuenta(usuario.cuentaId);
  return perfiles.map((perfil) => ({
    tenantId: perfil.tenantId,
    nombre: perfil.tenantNombre,
    slug: perfil.tenantSlug,
    actual: perfil.tenantId === usuario.tenantId,
  }));
}

/** Pasa la sesión a otra de las empresas de esta persona.
 *
 *  No hay clave de por medio: la persona ya se autenticó, y lo único que hace
 *  falta verificar es que el perfil de destino siga existiendo y activo -- se
 *  revalida contra la base, nunca contra el JWT, porque entre que entró y
 *  ahora la pudieron dar de baja ahí.
 *
 *  La sesión anterior se cierra: una persona tiene UNA sesión abierta por
 *  navegador, y dejar viva la de la empresa anterior dejaría dos cookies
 *  compitiendo y, peor, una sesión que nadie ve pero sigue sirviendo. */
export async function cambiarEmpresaService(
  usuario: UsuarioPayload,
  tenantId: string
): Promise<SesionEmitida> {
  if (!usuario.cuentaId) {
    throw new AppError(
      403,
      "Tu acceso es de esta empresa. Para entrar a otra, pedile el acceso a su administrador"
    );
  }
  if (tenantId === usuario.tenantId) {
    throw new AppError(400, "Ya estás en esa empresa");
  }

  const perfiles = await perfilesDeCuenta(usuario.cuentaId);
  const destino = perfiles.find((perfil) => perfil.tenantId === tenantId);
  if (!destino) {
    // Genérico: no se confirma ni se niega que esa empresa exista.
    throw new AppError(403, "No tenés acceso a esa empresa");
  }

  const sesion = await emitirSesionParaPerfil(destino.usuarioId, destino.tenantId);
  // Después de emitir la nueva, nunca antes: si emitir fallara, la persona se
  // quedaría sin ninguna sesión y tendría que volver a entrar con su clave.
  await logoutService(usuario.id, usuario.sessionId);

  return { tipo: "sesion", ...sesion };
}

/** Devuelve la cuenta de ese correo, creándola si no existía.
 *
 *  Si YA existía -- la persona trabaja en otra empresa -- **no se le toca la
 *  clave**: cambiársela sería cambiársela en todas sus empresas, y el admin
 *  que da el alta no puede hacer eso. Por eso `ON CONFLICT DO NOTHING` y no
 *  `DO UPDATE`: de la cuenta ajena no se escribe ni `actualizado_en`.
 *
 *  Consecuencia conocida y transitoria: en ese caso la clave temporal que el
 *  admin ve NO sirve, porque la persona entra con la suya. La entrega 3 lo
 *  resuelve reemplazando la clave temporal por una invitación por correo,
 *  idéntica para los dos casos (así el admin tampoco puede deducir que la
 *  persona ya estaba en otra empresa). */
async function asegurarCuenta(
  email: string,
  /** null = alta por invitación: la cuenta queda sin clave y la define la
   *  persona desde el enlace que le llega. Sin clave no se puede entrar (ver
   *  loginConCorreo), así que una invitación sin aceptar no es un acceso. */
  passwordHash: string | null,
  db: Pool | PoolClient = pool
): Promise<string> {
  const creada = await db.query(
    `INSERT INTO cuentas (email, password_hash, debe_cambiar_password)
     VALUES ($1, $2, true)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, passwordHash]
  );
  if (creada.rows[0]) return creada.rows[0].id;

  const existente = await db.query(`SELECT id FROM cuentas WHERE email = $1`, [email]);
  return existente.rows[0].id;
}

export async function crearUsuarioService(
  input: {
    tenantId: string;
    nombre: string;
    /** Opcional desde 0084: puede venir DNI en su lugar. */
    email?: string;
    dni?: string;
    /** Opcional desde la entrega 3: con correo, la clave la define la persona
     *  desde la invitación. Sin correo es obligatoria (lo valida el schema):
     *  el personal de cancha no tiene a dónde recibir un enlace. */
    password?: string;
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
  const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : null;
  const emailNormalizado = input.email?.trim().toLowerCase() ?? null;

  if (!passwordHash && !emailNormalizado) {
    // El schema ya lo impide; acá por si alguna vez se llama al servicio
    // desde otro lado. Sin clave y sin correo, el alta crearía un acceso que
    // no sirve para entrar ni se puede recuperar.
    throw new AppError(400, "Sin correo hay que ponerle una clave para dictarle");
  }

  // Con correo, la clave vive en la CUENTA (0087); el perfil queda sin clave
  // propia. Sin correo (operativo por DNI) sigue como antes: la clave es del
  // perfil, porque no hay cuenta.
  const cuentaId = emailNormalizado
    ? await asegurarCuenta(emailNormalizado, passwordHash, db)
    : null;

  let result;
  try {
    // debe_cambiar_password = true siempre: quien llama a esto le puso la
    // contraseña a otra persona (panel o SCIM), nunca es la propia del
    // usuario -- mismo criterio que crearPlatformAdminService.
    result = await db.query(
      `INSERT INTO usuarios (tenant_id, nombre, email, dni, password_hash, rol, debe_cambiar_password, cuenta_id)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::rol_usuario, 'operador'), true, $7)
       RETURNING id, tenant_id, nombre, email, dni, rol, token_version, debe_cambiar_password, cuenta_id`,
      [
        input.tenantId,
        input.nombre,
        emailNormalizado,
        input.dni ?? null,
        cuentaId ? null : passwordHash,
        input.rol ?? null,
        cuentaId,
      ]
    );
  } catch (err) {
    // Mismo criterio que loginService: nunca reenviar el error crudo de la
    // BD al cliente (podría filtrar nombres de tabla/constraint).
    if (esViolacionUnicidad(err)) {
      // El correo (por su cuenta), el DNI, o el índice (tenant_id, cuenta_id)
      // de 0087: los tres significan lo mismo para quien da el alta.
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

  // Las filas de usuario_modulos se insertan para TODOS los módulos del
  // tenant, incluso para un rol de cancha: si mañana el admin lo pasa a
  // operador, la asignación ya está y no hay que reconstruirla. El recorte
  // por rol se aplica al LEER (ver obtenerModulosPermitidos) -- y acá también,
  // para que la respuesta del alta no le prometa al grifero ocho módulos que
  // no va a ver en su primer login.
  const permitidosPorRol = MODULOS_POR_ROL[fila.rol as UsuarioPayload["rol"]];

  return {
    id: fila.id,
    cuentaId: fila.cuenta_id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    email: fila.email,
    dni: fila.dni,
    rol: fila.rol,
    modulosPermitidos: permitidosPorRol
      ? modulosHabilitados.filter((m) => permitidosPorRol.includes(m))
      : modulosHabilitados,
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
export function construirUrlTenant(tenant: TenantParaRecuperacion | undefined): string {
  if (!tenant) return env.appPublicUrl;
  if (tenant.dominioPersonalizado) return `https://${tenant.dominioPersonalizado}`;
  if (env.appApexDomain) return `https://${tenant.slug}.${env.appApexDomain}`;
  return env.appPublicUrl;
}

async function enviarCorreoRecuperacion(params: {
  nombre: string;
  email: string;
  /** Sin empresa (una cuenta recién creada, todavía sin perfiles) el enlace
   *  va a APP_PUBLIC_URL. */
  tenant: TenantParaRecuperacion | undefined;
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

// ═══════════════ INVITACIÓN AL DAR DE ALTA (entrega 3) ══════════════════

/** Una invitación dura una semana, no una hora como la recuperación: la pide
 *  un administrador, no la persona, y entre que la da de alta y la persona
 *  abre su correo puede pasar un fin de semana. */
const INVITACION_HORAS = 24 * 7;

/** Le avisa a la persona que tiene acceso a una empresa.
 *
 *  Dos correos distintos según su situación, y esa diferencia NO le llega al
 *  administrador, que ve siempre lo mismo: si supiera cuál de los dos se
 *  mandó, sabría si esa persona ya usa MinCore en otra empresa.
 *
 *  - Sin clave todavía (persona nueva): enlace para definirla.
 *  - Con clave (ya trabaja en otra empresa): aviso, sin enlace y sin token.
 *    Entra con la clave que ya tiene; mandarle un enlace de cambio de clave
 *    por un alta ajena sería pedirle que toque la clave de sus otras empresas.
 */
export async function invitarAlPerfilService(params: {
  email: string;
  nombre: string;
  tenantId: string;
}): Promise<void> {
  try {
    const cuenta = await buscarCuentaPorEmail(params.email);
    if (!cuenta || !cuenta.activo) return;

    const tenant = (
      await pool.query(
        `SELECT id, nombre, slug, dominio_personalizado AS "dominioPersonalizado"
           FROM tenants WHERE id = $1`,
        [params.tenantId]
      )
    ).rows[0];
    if (!tenant) return;

    if (cuenta.password_hash) {
      await enviarCorreoAccesoNuevo({
        nombre: params.nombre,
        email: cuenta.email,
        tenant,
      });
      return;
    }

    const tokenPlano = randomBytes(48).toString("hex");
    await pool.query(
      `INSERT INTO reset_tokens (cuenta_id, token_hash, expira_en)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
      [cuenta.id, hashRefreshToken(tokenPlano), String(INVITACION_HORAS)]
    );

    await enviarCorreoInvitacion({
      nombre: params.nombre,
      email: cuenta.email,
      tenant,
      tokenPlano,
    });
  } catch (err) {
    // Un alta no se cae porque el correo no salga: la persona ya tiene su
    // perfil, y el administrador puede reenviarle la invitación.
    logger.error({ err }, "No se pudo enviar la invitación al perfil nuevo");
  }
}

type TenantConNombre = TenantParaRecuperacion & { nombre: string };

async function enviarCorreoInvitacion(params: {
  nombre: string;
  email: string;
  tenant: TenantConNombre;
  tokenPlano: string;
}) {
  if (!transporter || !emailConfigured) {
    logger.warn("No se pudo enviar la invitación: SMTP no configurado");
    return;
  }

  const link = `${construirUrlTenant(params.tenant)}/reset-password?token=${params.tokenPlano}`;
  const nombreSeguro = escapeHtml(params.nombre);
  const empresaSegura = escapeHtml(params.tenant.nombre);

  const text = [
    `Hola ${params.nombre},`,
    "",
    `Te dieron de alta en MinCore ERP para ${params.tenant.nombre}.`,
    "Definí tu contraseña acá (el enlace vence en 7 días):",
    link,
    "",
    "Tu contraseña es tuya: nadie de la empresa la ve ni la puede elegir por vos.",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">Te dieron acceso a MinCore ERP</h2>
      <p>Hola ${nombreSeguro},</p>
      <p>Te dieron de alta en MinCore ERP para <strong>${empresaSegura}</strong>. Definí tu contraseña acá (el enlace vence en 7 días):</p>
      <p><a href="${link}" style="color:#0f172a;">${link}</a></p>
      <p>Tu contraseña es tuya: nadie de la empresa la ve ni la puede elegir por vos.</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"MinCore ERP" <${env.emailUser}>`,
      to: params.email,
      subject: `Definí tu contraseña - ${params.tenant.nombre}`,
      text,
      html,
    });
  } catch (err) {
    logger.error({ err }, "No se pudo enviar el correo de invitación");
  }
}

/** Para quien YA tiene clave: no se le manda ningún enlace, solo el aviso de
 *  que ahora también entra a esta empresa. */
async function enviarCorreoAccesoNuevo(params: {
  nombre: string;
  email: string;
  tenant: TenantConNombre;
}) {
  if (!transporter || !emailConfigured) return;

  const url = construirUrlTenant(params.tenant);
  const nombreSeguro = escapeHtml(params.nombre);
  const empresaSegura = escapeHtml(params.tenant.nombre);

  const text = [
    `Hola ${params.nombre},`,
    "",
    `Ahora también tenés acceso a ${params.tenant.nombre} en MinCore ERP.`,
    "Entrá con tu correo y la contraseña que ya usás:",
    url,
    "",
    "Si no esperabas esto, avisale a tu administrador.",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">Tenés acceso a una empresa más</h2>
      <p>Hola ${nombreSeguro},</p>
      <p>Ahora también tenés acceso a <strong>${empresaSegura}</strong> en MinCore ERP. Entrá con tu correo y la contraseña que ya usás:</p>
      <p><a href="${url}" style="color:#0f172a;">${url}</a></p>
      <p>Si no esperabas esto, avisale a tu administrador.</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"MinCore ERP" <${env.emailUser}>`,
      to: params.email,
      subject: `Tenés acceso a ${params.tenant.nombre} - MinCore ERP`,
      text,
      html,
    });
  } catch (err) {
    logger.error({ err }, "No se pudo enviar el aviso de acceso nuevo");
  }
}

/** A qué dirección apunta el enlace del correo. La recuperación es de la
 *  CUENTA, pero el enlace tiene que llevar a alguna dirección concreta: la de
 *  la empresa por la que pidió, la de su última empresa, o la de la primera
 *  que tenga. Sin ninguna (cuenta sin perfiles) se usa APP_PUBLIC_URL. */
async function resolverTenantParaEnlace(
  tenantSlug: string | undefined,
  cuenta: CuentaFila,
  perfiles: PerfilDeCuenta[]
): Promise<TenantParaRecuperacion | undefined> {
  if (tenantSlug) {
    const porSlug = await resolverTenantParaRecuperacion(tenantSlug);
    if (porSlug) return porSlug;
  }
  if (cuenta.ultimo_tenant_id) {
    const result = await pool.query(
      `SELECT id, slug, dominio_personalizado AS "dominioPersonalizado"
         FROM tenants WHERE id = $1 AND activo = true`,
      [cuenta.ultimo_tenant_id]
    );
    if (result.rows[0]) return result.rows[0];
  }
  if (perfiles[0]) return resolverTenantParaRecuperacion(perfiles[0].tenantSlug);
  return undefined;
}

/** Siempre responde el mismo mensaje genérico, exista o no la cuenta -- mismo
 *  criterio anti-enumeración que el login. El trabajo real (buscar la cuenta,
 *  generar el token, enviar el correo) ocurre dentro de un try/catch que nunca
 *  relanza: un fallo de BD o de SMTP no debe delatar nada distinto de "no
 *  existe" al que llama.
 *
 *  Desde 0087 la recuperación es de la CUENTA: una sola clave para todas sus
 *  empresas. Por eso no pide empresa, y el token apunta a `cuentas`. */
export async function solicitarRecuperacionService(
  input: ForgotPasswordInput
): Promise<{ message: string }> {
  try {
    const cuenta = await buscarCuentaPorEmail(input.email);

    if (cuenta && cuenta.activo) {
      const tokenPlano = randomBytes(48).toString("hex");
      const expiraEn = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

      await pool.query(
        `INSERT INTO reset_tokens (cuenta_id, token_hash, expira_en) VALUES ($1, $2, $3)`,
        [cuenta.id, hashRefreshToken(tokenPlano), expiraEn]
      );

      const perfiles = await perfilesDeCuenta(cuenta.id);
      const tenant = await resolverTenantParaEnlace(input.tenantSlug, cuenta, perfiles);

      await enviarCorreoRecuperacion({
        // El nombre lo pone el perfil: la cuenta no guarda nombre, cada
        // empresa tiene el suyo. Sin perfiles, el correo alcanza.
        nombre: perfiles[0]?.nombre ?? cuenta.email,
        email: cuenta.email,
        tenant,
        tokenPlano,
      });
    }
  } catch (err) {
    logger.error({ err }, "Error al procesar solicitud de recuperación de contraseña");
  }

  return { message: MENSAJE_RECUPERACION };
}

/** El token identifica a quién le cambia la clave: desde 0087 apunta a una
 *  CUENTA (administrativos); los tokens viejos, y los de personal operativo,
 *  apuntan a un perfil de una empresa. Los dos caminos siguen funcionando.
 *
 *  Cambiar la clave revoca todas las sesiones -- de la cuenta, en todas sus
 *  empresas; o del perfil, si el token era de un perfil. */
export async function restablecerPasswordService(input: ResetPasswordInput): Promise<void> {
  const hash = hashRefreshToken(input.token);

  const tokenResult = await pool.query(
    `SELECT cuenta_id, usuario_id, tenant_id, expira_en, usado_en
       FROM reset_tokens WHERE token_hash = $1`,
    [hash]
  );
  const fila = tokenResult.rows[0];

  if (!fila || fila.usado_en || new Date(fila.expira_en).getTime() < Date.now()) {
    throw new AppError(400, "El link de recuperación es inválido o expiró");
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 12);

  if (fila.cuenta_id) {
    const actualizado = await pool.query(
      `UPDATE cuentas
          SET password_hash = $1, debe_cambiar_password = false, actualizado_en = now()
        WHERE id = $2 AND activo = true
        RETURNING id`,
      [passwordHash, fila.cuenta_id]
    );
    // Un UPDATE que no matchea ninguna fila no lanza error en Postgres. Sin
    // este chequeo, declararía éxito con la clave vieja intacta (el bug que
    // reportó Kenif: "cambio la clave y el ERP no la reconoce").
    if (actualizado.rowCount === 0) {
      throw new AppError(400, "No se pudo actualizar la contraseña, la cuenta ya no existe");
    }

    await pool.query(`UPDATE reset_tokens SET usado_en = now() WHERE token_hash = $1`, [hash]);
    await revocarSesionesDeCuentaService(fila.cuenta_id);
    return;
  }

  // Token de perfil: puede ser viejo (anterior a 0087) o de personal
  // operativo. Si ese perfil tiene cuenta, la clave que vale para entrar es la
  // de la CUENTA -- escribirla en el perfil dejaría la vieja funcionando y el
  // usuario diría, con razón, "cambié la clave y el ERP no la reconoce".
  const cuentaDelPerfil = await withTenant(fila.tenant_id, async (client) => {
    const result = await client.query(
      `SELECT cuenta_id FROM usuarios WHERE id = $1 AND tenant_id = $2`,
      [fila.usuario_id, fila.tenant_id]
    );
    return result.rows[0]?.cuenta_id as string | null | undefined;
  });

  if (cuentaDelPerfil) {
    const actualizado = await pool.query(
      `UPDATE cuentas
          SET password_hash = $1, debe_cambiar_password = false, actualizado_en = now()
        WHERE id = $2 AND activo = true
        RETURNING id`,
      [passwordHash, cuentaDelPerfil]
    );
    if (actualizado.rowCount === 0) {
      throw new AppError(400, "No se pudo actualizar la contraseña, la cuenta ya no existe");
    }

    await pool.query(`UPDATE reset_tokens SET usado_en = now() WHERE token_hash = $1`, [hash]);
    await revocarSesionesDeCuentaService(cuentaDelPerfil);
    return;
  }

  const actualizado = await withTenant(fila.tenant_id, (client) =>
    client.query(
      `UPDATE usuarios SET password_hash = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id`,
      [passwordHash, fila.usuario_id, fila.tenant_id]
    )
  );

  if (actualizado.rowCount === 0) {
    throw new AppError(400, "No se pudo actualizar la contraseña, el usuario ya no existe");
  }

  await pool.query(`UPDATE reset_tokens SET usado_en = now() WHERE token_hash = $1`, [hash]);

  await revocarSesionesService(fila.usuario_id, fila.tenant_id);
}

/** El admin de una empresa destraba a alguien que no puede entrar.
 *
 *  Hace DOS cosas distintas según de quién se trate, y la diferencia es de
 *  seguridad, no de comodidad:
 *
 *  - **Operativo por DNI**: el admin le pone una clave temporal, que sirve una
 *    vez y obliga a cambiarla al entrar (así el admin no termina sabiendo la
 *    clave con la que su empleado firma vales). Es el único camino posible:
 *    esa gente no tiene correo al cual mandarle nada.
 *  - **Administrativo con cuenta**: NO se le pone ninguna clave. Su clave es
 *    de la CUENTA y vale para todas las empresas donde trabaja; que el admin
 *    de una de ellas pudiera cambiarla sería darle acceso a las otras. En vez
 *    de eso se le envía el correo de recuperación, y la persona elige su
 *    clave.
 *
 *  Si lo que el admin necesita es cortar el acceso de alguien (cuenta robada,
 *  renuncia), lo que corresponde es dar de baja el perfil: eso sí es inmediato
 *  y solo afecta a su empresa. */
export async function resetearClaveUsuarioService(
  tenantId: string,
  usuarioId: string,
  passwordNueva: string
): Promise<{
  id: string;
  nombre: string;
  email: string | null;
  dni: string | null;
  modo: "clave-temporal" | "correo-enviado";
}> {
  const perfil = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT u.id, u.nombre, u.email, u.dni, u.cuenta_id, c.email AS cuenta_email
         FROM usuarios u
         LEFT JOIN cuentas c ON c.id = u.cuenta_id
        WHERE u.id = $1 AND u.tenant_id = $2`,
      [usuarioId, tenantId]
    );
    return result.rows[0];
  });
  if (!perfil) throw new AppError(404, "Usuario no encontrado");

  if (perfil.cuenta_id) {
    await solicitarRecuperacionService({ email: perfil.cuenta_email, tenantSlug: undefined });
    return {
      id: perfil.id,
      nombre: perfil.nombre,
      email: perfil.cuenta_email,
      dni: perfil.dni,
      modo: "correo-enviado",
    };
  }

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

  // Resetear la clave sin cerrar sesiones dejaría adentro a quien la supiera,
  // que es justo el caso del que uno se defiende al resetear.
  await revocarSesionesService(usuarioId, tenantId);

  return { ...fila, modo: "clave-temporal" };
}

/** Cambia su propia clave, ya autenticado. Pensado primero para la pantalla
 *  obligatoria del primer ingreso con clave temporal, y sirve para cualquier
 *  cambio voluntario después.
 *
 *  Con cuenta (administrativo) la clave es de la CUENTA: cambiarla vale para
 *  todas sus empresas. Sin cuenta (operativo por DNI) sigue siendo del perfil.
 *
 *  No revoca sesiones a propósito: quien cambia su clave es la propia persona,
 *  y tirarle abajo la sesión desde la que la está cambiando sería hostil
 *  --justo en la pantalla de cambio obligatorio del primer ingreso. */
export async function cambiarMiPasswordUsuarioService(
  usuarioId: string,
  tenantId: string,
  passwordActual: string,
  passwordNueva: string
): Promise<void> {
  const perfil = await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT u.password_hash, u.cuenta_id, c.password_hash AS cuenta_password_hash
         FROM usuarios u
         LEFT JOIN cuentas c ON c.id = u.cuenta_id
        WHERE u.id = $1 AND u.tenant_id = $2`,
      [usuarioId, tenantId]
    );
    return result.rows[0];
  });
  if (!perfil) throw new AppError(404, "Usuario no encontrado");

  const hashVigente = perfil.cuenta_id ? perfil.cuenta_password_hash : perfil.password_hash;
  const passwordValido = await bcrypt.compare(passwordActual, hashVigente ?? HASH_SEÑUELO);
  if (!hashVigente || !passwordValido) throw new AppError(401, "Contraseña actual incorrecta");

  const passwordHash = await bcrypt.hash(passwordNueva, 12);

  const actualizado = perfil.cuenta_id
    ? await pool.query(
        `UPDATE cuentas
            SET password_hash = $1, debe_cambiar_password = false, actualizado_en = now()
          WHERE id = $2 AND activo = true RETURNING id`,
        [passwordHash, perfil.cuenta_id]
      )
    : await withTenant(tenantId, (client) =>
        client.query(
          `UPDATE usuarios SET password_hash = $1, debe_cambiar_password = false
            WHERE id = $2 AND tenant_id = $3 RETURNING id`,
          [passwordHash, usuarioId, tenantId]
        )
      );

  // Un UPDATE con WHERE que no matchea ninguna fila no lanza error en
  // Postgres: sin esto declararía éxito aunque la cuenta o el perfil se hayan
  // desactivado entre el SELECT y este UPDATE.
  if (actualizado.rowCount === 0) {
    throw new AppError(400, "No se pudo actualizar la contraseña, el usuario ya no existe");
  }
}
