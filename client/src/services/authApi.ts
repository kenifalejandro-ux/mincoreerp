// client/src/services/authApi.ts

import { apiFetch } from "./apiClient";

export interface UsuarioPayload {
  id: string;
  tenantId: string;
  nombre: string;
  /** null desde 0084: el personal de cancha entra con DNI y no tiene correo.
   *  Al menos uno de los dos siempre está. */
  email: string | null;
  dni?: string | null;
  rol: "admin" | "operador" | "lectura" | "grifero" | "conductor_ruta";
  modulosPermitidos: string[];
  debeCambiarPassword: boolean;
}

async function parseOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Error HTTP ${res.status}`);
  }
  return data;
}

/** Una de las empresas en las que la persona tiene perfil. */
export interface EmpresaDeLaCuenta {
  tenantId: string;
  nombre: string;
  slug: string;
}

/** Entrar puede terminar de dos maneras (migración 0087):
 *
 *  - `sesion`: lo normal — una sola empresa, o la dirección por la que entró
 *    ya dice cuál es.
 *  - `elegir-empresa`: la persona trabaja en varias. La clave YA se validó;
 *    falta decir a cuál entra. El `token` dura 2 minutos y reemplaza a la
 *    clave en el segundo paso, así no vuelve a viajar. */
export type ResultadoLogin =
  | { tipo: "sesion"; usuario: UsuarioPayload }
  | {
      tipo: "elegir-empresa";
      token: string;
      empresas: EmpresaDeLaCuenta[];
      /** La última en la que entró, para ofrecerla primero. */
      ultimoTenantId: string | null;
    };

interface RespuestaLogin {
  usuario?: UsuarioPayload;
  elegirEmpresa?: {
    token: string;
    empresas: EmpresaDeLaCuenta[];
    ultimoTenantId: string | null;
  };
}

function interpretarLogin(data: RespuestaLogin): ResultadoLogin {
  if (data.elegirEmpresa) {
    return {
      tipo: "elegir-empresa",
      token: data.elegirEmpresa.token,
      empresas: data.elegirEmpresa.empresas ?? [],
      ultimoTenantId: data.elegirEmpresa.ultimoTenantId ?? null,
    };
  }
  return { tipo: "sesion", usuario: data.usuario as UsuarioPayload };
}

/** El body lleva `tenantSlug` solo cuando de verdad hay uno: mandarlo vacío
 *  lo rechaza la validación del servidor, y mandarlo cuando no corresponde
 *  limitaría el login a esa empresa. Sin él, el servidor resuelve la empresa
 *  por la dirección de la petición o por la cuenta. */
function conEmpresa(tenantSlug: string | null, resto: Record<string, unknown>) {
  return JSON.stringify(tenantSlug ? { tenantSlug, ...resto } : resto);
}

/** `identificador` puede ser un correo o un DNI (migración 0084): el grifero
 *  y los conductores de ruta no tienen correo corporativo. El servidor decide
 *  por cuál buscar según tenga "@" o no.
 *
 *  `tenantSlug` es opcional desde 0087: con correo, la empresa la resuelve la
 *  cuenta; con DNI sigue haciendo falta, porque un DNI puede repetirse entre
 *  empresas. */
export async function loginApi(
  tenantSlug: string | null,
  identificador: string,
  password: string
): Promise<ResultadoLogin> {
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: conEmpresa(tenantSlug, { identificador, password }),
  });
  return interpretarLogin(await parseOrThrow(res));
}

/** Segundo paso cuando la persona tiene perfil en varias empresas. */
export async function elegirEmpresaApi(token: string, tenantId: string): Promise<UsuarioPayload> {
  const res = await apiFetch("/api/auth/elegir-empresa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, tenantId }),
  });
  const data = await parseOrThrow(res);
  return data.usuario;
}

export async function googleLoginApi(
  tenantSlug: string | null,
  credential: string
): Promise<ResultadoLogin> {
  const res = await apiFetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: conEmpresa(tenantSlug, { credential }),
  });
  return interpretarLogin(await parseOrThrow(res));
}

/** El `tenantSlug` acá no decide a quién se le manda el correo --la
 *  recuperación es de la CUENTA, no de una empresa-- solo con qué dirección
 *  se arma el enlace del correo. */
export async function forgotPasswordApi(tenantSlug: string | null, email: string): Promise<string> {
  const res = await apiFetch("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: conEmpresa(tenantSlug, { email }),
  });
  const data = await parseOrThrow(res);
  return data.message;
}

export async function resetPasswordApi(token: string, newPassword: string): Promise<void> {
  const res = await apiFetch("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  await parseOrThrow(res);
}

export async function logoutApi(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
}

export async function ssoDisponibleApi(tenantSlug: string): Promise<boolean> {
  const res = await apiFetch(
    `/api/auth/sso-disponible?tenantSlug=${encodeURIComponent(tenantSlug)}`
  );
  const data = await parseOrThrow(res);
  return data.disponible;
}

/** No es un fetch: el login SSO es un redirect real de navegador (baile de
 *  Authorization Code con el IdP), no algo que se pueda resolver con XHR —
 *  el caller hace `window.location.href = ssoIniciarUrl(...)`. */
export function ssoIniciarUrl(tenantSlug: string): string {
  return `/api/auth/sso/iniciar?tenantSlug=${encodeURIComponent(tenantSlug)}`;
}

/** Una empresa a la que esta persona puede pasar sin volver a entrar. */
export interface EmpresaDelUsuario {
  tenantId: string;
  nombre: string;
  slug: string;
  actual: boolean;
}

/** Vacío para el personal operativo (entra con DNI, su acceso es de UNA
 *  empresa) y para quien tiene un solo perfil. */
export async function misEmpresasApi(): Promise<EmpresaDelUsuario[]> {
  const res = await apiFetch("/api/auth/mis-empresas");
  const data = await parseOrThrow(res);
  return data.empresas ?? [];
}

/** Cambia la sesión a otra empresa. La anterior se cierra del lado del
 *  servidor, así que después de esto hay que recargar la app entera: lo que
 *  está en pantalla es de la empresa de la que se viene. */
export async function cambiarEmpresaApi(tenantId: string): Promise<UsuarioPayload> {
  const res = await apiFetch("/api/auth/cambiar-empresa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId }),
  });
  const data = await parseOrThrow(res);
  return data.usuario;
}

export async function getMeApi(): Promise<UsuarioPayload> {
  // Si el access token ya expiró (usuario dejó la pestaña abierta más de
  // 30 min), apiFetch intenta /api/auth/refresh solo y reintenta antes de
  // rendirse — así no se fuerza un re-login mientras el refresh token siga
  // vigente (hasta 30 días).
  const res = await apiFetch("/api/auth/me");
  const data = await parseOrThrow(res);
  return data.usuario;
}

/** Cambia la propia contraseña estando ya logueado -- pensado primero para
 *  la pantalla obligatoria del primer login con clave temporal (ver
 *  debeCambiarPassword). El JWT actual sigue diciendo `true` hasta el
 *  próximo login/refresh (se arma en cada uno desde una lectura fresca de
 *  la base, no vive en el token) -- por eso quien llama a esto debe
 *  actualizar el `usuario` en memoria a mano en vez de volver a pedir
 *  /api/auth/me, que devolvería el token viejo sin refrescar. */
export async function cambiarMiPasswordApi(
  passwordActual: string,
  passwordNueva: string
): Promise<void> {
  const res = await apiFetch("/api/auth/mi-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passwordActual, passwordNueva }),
  });
  await parseOrThrow(res);
}
