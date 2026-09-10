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

export interface UsuarioDelTenant {
  id: string;
  nombre: string;
  /** Uno de los dos puede ser null (migración 0084), nunca los dos: el
   *  personal de cancha entra con DNI y no tiene correo de empresa. */
  email: string | null;
  dni: string | null;
  rol: string;
  activo: boolean;
}

export type RolUsuario = "admin" | "operador" | "lectura";

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

export async function crearUsuarioApi(input: {
  nombre: string;
  email?: string;
  dni?: string;
  password: string;
  rol: RolUsuario;
}): Promise<UsuarioDelTenant> {
  return leerRespuesta(
    await apiFetch("/api/erp/usuarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function resetearClaveApi(usuarioId: string, password: string): Promise<void> {
  await leerRespuesta(
    await apiFetch(`/api/erp/usuarios/${usuarioId}/clave`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
  );
}

export async function cambiarEstadoUsuarioApi(
  usuarioId: string,
  activo: boolean,
  motivo?: string
): Promise<void> {
  await leerRespuesta(
    await apiFetch(`/api/erp/usuarios/${usuarioId}/estado`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activo, ...(motivo ? { motivo } : {}) }),
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
