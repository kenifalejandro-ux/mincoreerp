// client/src/services/usuariosApi.ts
//
// La gente de la empresa, administrada por el admin del propio tenant --
// no por el dueño del ERP desde el panel de plataforma (ver
// src/server/routes/usuariosTenant.ts).
//
// Nada de esto pasa por la cola offline, a propósito: dar de alta a alguien
// o resetearle la clave son decisiones que se toman con conexión, en la
// oficina, y encolarlas significaría que una credencial "existe" en la
// tablet y no en el servidor. `apiFetch` ya lo maneja solo -- estas rutas no
// están declaradas en el registry offline, así que un fallo de red tira en
// vez de encolar.

import { apiFetch } from "./apiClient";

export type EstadoPerfil = "activo" | "inactivo" | "bloqueado";

export interface UsuarioDelTenant {
  id: string;
  nombre: string;
  /** Uno de los dos puede ser null (migración 0084), nunca los dos: el
   *  personal de cancha entra con DNI y no tiene correo de empresa. */
  email: string | null;
  dni: string | null;
  rol: string;
  /** La copia booleana de `estado`, que el servidor mantiene al día. */
  activo: boolean;
  /** activo / inactivo (lo dio de baja un admin) / bloqueado (se le trabó la
   *  clave por intentos fallidos). Migración 0090. */
  estado: EstadoPerfil;
  celular: string | null;
  bloqueadoEn: string | null;
}

export type RolUsuario = "admin" | "operador" | "lectura" | "grifero" | "conductor_ruta";

async function leerRespuesta(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Dos formas de error conviven en la API: `{ errors: [{field, message}] }`
    // de la validación (Zod) y `{ message }` de un AppError. La primera es la
    // que trae el texto útil ("Indicá un correo o un DNI"), así que va primero.
    throw new Error(
      data.errors?.[0]?.message || data.message || `No se pudo completar (HTTP ${res.status})`
    );
  }
  return data;
}

export async function listarUsuariosApi(): Promise<UsuarioDelTenant[]> {
  const data = await leerRespuesta(await apiFetch("/api/erp/usuarios"));
  return data.data ?? [];
}

/** Cómo quedó el acceso de quien se acaba de dar de alta:
 *
 *  - `invitacion-enviada`: tiene correo, así que define su propia clave desde
 *    el enlace que le llega. El administrador no elige ninguna ni la ve.
 *  - `clave-temporal`: personal de cancha, entra con DNI. La clave se la
 *    dicta el administrador, porque no hay correo a donde mandar nada. */
export type ModoAlta = "clave-temporal" | "invitacion-enviada";

export async function crearUsuarioApi(input: {
  nombre: string;
  email?: string;
  dni?: string;
  /** Solo para el alta por DNI: con correo, la clave la define la persona. */
  password?: string;
  rol: RolUsuario;
}): Promise<UsuarioDelTenant & { modo: ModoAlta }> {
  const creado = await leerRespuesta(
    await apiFetch("/api/erp/usuarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
  // Un servidor viejo (sin la entrega 3) no manda `modo` y siempre pone la
  // clave que se le mandó.
  return {
    ...creado,
    modo: creado.modo === "invitacion-enviada" ? "invitacion-enviada" : "clave-temporal",
  };
}

/** Qué pasó con el reseteo (migración 0087):
 *
 *  - `clave-temporal`: la clave que mandó el admin quedó puesta. Es el caso
 *    del personal de cancha, que entra con DNI y no tiene correo.
 *  - `correo-enviado`: la persona tiene cuenta (entra con correo), así que su
 *    clave no es de esta empresa -- la misma le sirve en cualquier otra donde
 *    trabaje. El servidor ignora la clave que se le mandó y le envía un enlace
 *    para que la elija ella. */
export type ModoReseteo = "clave-temporal" | "correo-enviado";

/** `password` va siempre, aunque el servidor lo ignore cuando la persona
 *  tiene cuenta: quién decide es el servidor, no esta pantalla. Lo que se le
 *  muestra al admin lo manda el `modo` que vuelve. */
export async function resetearClaveApi(
  usuarioId: string,
  password: string
): Promise<{ modo: ModoReseteo }> {
  const data = await leerRespuesta(
    await apiFetch(`/api/erp/usuarios/${usuarioId}/clave`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
  );
  // Un servidor viejo (sin 0087) no manda `modo` y siempre pone la clave.
  return { modo: data.modo === "correo-enviado" ? "correo-enviado" : "clave-temporal" };
}

/** El motivo es obligatorio para cualquier estado que no sea 'activo': dejar
 *  a alguien afuera del sistema se explica. */
export async function cambiarEstadoUsuarioApi(
  usuarioId: string,
  estado: EstadoPerfil,
  motivo?: string
): Promise<void> {
  await leerRespuesta(
    await apiFetch(`/api/erp/usuarios/${usuarioId}/estado`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado, ...(motivo ? { motivo } : {}) }),
    })
  );
}

/** Nombre y celular. El correo no se edita: es la identidad de la persona en
 *  toda la plataforma, y cambiarlo sería moverla a otra cuenta. */
export async function actualizarUsuarioApi(
  usuarioId: string,
  cambios: { nombre?: string; celular?: string | null }
): Promise<UsuarioDelTenant> {
  return leerRespuesta(
    await apiFetch(`/api/erp/usuarios/${usuarioId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cambios),
    })
  );
}

// ── Autonomías (Administración → Configuración) ──────────────────────────

export type NivelModulo = "operar" | "consultas";

export interface PermisoDeModulo {
  modulo: string;
  asignado: boolean;
  nivel: NivelModulo;
}

export interface PermisosDeUsuario {
  usuarioId: string;
  nombre: string;
  rol: RolUsuario;
  /** Solo los módulos que la empresa tiene contratados. */
  modulos: PermisoDeModulo[];
}

export async function permisosDeUsuarioApi(usuarioId: string): Promise<PermisosDeUsuario> {
  return leerRespuesta(await apiFetch(`/api/erp/usuarios/${usuarioId}/permisos`));
}

export async function guardarPermisosApi(
  usuarioId: string,
  cambio: { rol?: RolUsuario; modulos: PermisoDeModulo[]; motivo?: string }
): Promise<{ recorta: boolean }> {
  return leerRespuesta(
    await apiFetch(`/api/erp/usuarios/${usuarioId}/permisos`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cambio),
    })
  );
}

/** Clave temporal para dictar POR TELÉFONO a alguien que está en cancha.
 *
 *  De ahí las decisiones raras: dos palabras cortas y comunes en castellano
 *  más tres dígitos, separadas por guiones. Nada de símbolos ni mayúsculas
 *  intercaladas -- una clave "fuerte" que se dicta mal se termina anotando en
 *  un papel pegado al monitor, y eso es peor que una débil que vive 5
 *  minutos: dura lo que tarda la persona en entrar, porque el servidor la
 *  marca como `debe_cambiar_password` y la obliga a cambiarla ahí mismo.
 *
 *  Sin la letra "b/v" ni palabras que se confundan al dictarlas. */
const PALABRAS = [
  "campo",
  "cerro",
  "rueda",
  "motor",
  "piedra",
  "arena",
  "norte",
  "faro",
  "puente",
  "tanque",
  "grifo",
  "rampa",
  "torre",
  "risco",
  "cauce",
  "planta",
];

export function generarClaveTemporal(): string {
  // crypto.getRandomValues y no Math.random(): esto genera una credencial.
  const azar = new Uint32Array(3);
  crypto.getRandomValues(azar);
  const a = PALABRAS[azar[0] % PALABRAS.length];
  let b = PALABRAS[azar[1] % PALABRAS.length];
  if (b === a) b = PALABRAS[(azar[1] + 1) % PALABRAS.length];
  // 100-999: siempre tres dígitos, para que dictarla sea siempre igual.
  return `${a}-${b}-${100 + (azar[2] % 900)}`;
}
