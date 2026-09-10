// client/src/services/authApi.ts

import { apiFetch } from "./apiClient";

export interface UsuarioPayload {
  id: string;
  tenantId: string;
  nombre: string;
  email: string;
  rol: "admin" | "operador" | "lectura";
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

/** `identificador` puede ser un correo o un DNI (migración 0084): el grifero
 *  y los conductores de ruta no tienen correo corporativo. El servidor decide
 *  por cuál buscar según tenga "@" o no. */
export async function loginApi(
  tenantSlug: string,
  identificador: string,
  password: string
): Promise<UsuarioPayload> {
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantSlug, identificador, password }),
  });
  const data = await parseOrThrow(res);
  return data.usuario;
}

export async function googleLoginApi(
  tenantSlug: string,
  credential: string
): Promise<UsuarioPayload> {
  const res = await apiFetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantSlug, credential }),
  });
  const data = await parseOrThrow(res);
  return data.usuario;
}

export async function forgotPasswordApi(tenantSlug: string, email: string): Promise<string> {
  const res = await apiFetch("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantSlug, email }),
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
