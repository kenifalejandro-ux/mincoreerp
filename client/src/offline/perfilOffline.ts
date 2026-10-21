// client/src/offline/perfilOffline.ts
//
// El perfil del último usuario que entró con red, para poder reabrir la app
// SIN señal (o con el servidor caído).
//
// Al arrancar, AuthContext le pregunta quién es a /api/auth/me; sin red esa
// llamada falla y la app mandaba al login, que tampoco funciona sin red. Quien
// trabaja en planta o en ruta quedaba fuera justo donde trabaja.
//
// Lo que se guarda NO es una credencial: ni clave ni tokens (la cookie
// httpOnly sigue siendo la sesión real, y el servidor la vuelve a validar
// apenas hay red). Es solo el UsuarioPayload que la pantalla ya muestra, para
// saber qué módulos y pestañas enseñar. Un solo hueco por dispositivo: el
// siguiente que entre con red lo reemplaza, así no se mezclan usuarios ni
// tenants en una tablet compartida.

import {
  claveCoincide,
  crearHuella,
  huellaDisponible,
  huellaValida,
  type HuellaClave,
} from "./claveOffline";
import type { UsuarioPayload } from "../services/authApi";

const CLAVE = "erp-perfil-offline";

/** Cuánto vale el perfil guardado, contado desde la última vez que el
 *  servidor lo confirmó. Pasado el plazo hace falta entrar con red de nuevo. */
export const VIGENCIA_PERFIL_OFFLINE_MS = 7 * 24 * 60 * 60 * 1000;

interface PerfilGuardado {
  usuario: UsuarioPayload;
  guardadoEn: number;
}

/** Decide si lo guardado sirve para entrar sin red. Pura, para probarla. */
export function perfilVigente(
  crudo: string | null,
  ahora: number = Date.now()
): UsuarioPayload | null {
  if (!crudo) return null;
  try {
    const p = JSON.parse(crudo) as Partial<PerfilGuardado>;
    if (!p.usuario || typeof p.guardadoEn !== "number") return null;
    // Con la clave temporal sin cambiar no se entra sin red: el cambio lo
    // valida el servidor.
    if (p.usuario.debeCambiarPassword) return null;
    if (ahora - p.guardadoEn > VIGENCIA_PERFIL_OFFLINE_MS) return null;
    if (p.guardadoEn > ahora) return null;
    return p.usuario;
  } catch {
    return null;
  }
}

/** Llamar solo cuando el SERVIDOR acaba de confirmar al usuario (login o /me):
 *  nunca al restaurar desde acá, o la vigencia se renovaría sin red. */
export function guardarPerfil(usuario: UsuarioPayload, restauradoDesde?: number): void {
  try {
    if (usuario.debeCambiarPassword) {
      localStorage.removeItem(CLAVE);
      return;
    }
    // `restauradoDesde`: al entrar sin señal se conserva la fecha de la última
    // confirmación del servidor; nada se renueva sin que el servidor responda.
    const perfil: PerfilGuardado = { usuario, guardadoEn: restauradoDesde ?? Date.now() };
    localStorage.setItem(CLAVE, JSON.stringify(perfil));
    // El perfil del acceso por clave se mantiene al día, pero su vigencia NO se
    // renueva aquí: solo un login real con clave la renueva (ver guardarAcceso).
    if (restauradoDesde === undefined) actualizarPerfilDeAcceso(usuario);
  } catch {
    // Sin localStorage (modo privado, cuota): la app funciona igual, solo
    // que no podrá reabrir sin señal.
  }
}

export function leerPerfil(): UsuarioPayload | null {
  try {
    return perfilVigente(localStorage.getItem(CLAVE));
  } catch {
    return null;
  }
}

/** Al cerrar sesión, o cuando el servidor rechaza la sesión. */
export function borrarPerfil(): void {
  try {
    localStorage.removeItem(CLAVE);
  } catch {
    // nada que borrar
  }
}

// ── Acceso por clave sin conexión ────────────────────────────────────────
//
// Por identificador (correo o DNI) hay una LISTA de entradas, una por empresa:
// un mismo DNI puede existir en dos empresas. Cada entrada es la huella de la
// clave y el último perfil confirmado. NO es la sesión: la sesión real es la
// cookie; esto solo permite volver a entrar sin señal con la clave.
//
// La vigencia (7 días) cuenta desde el último login CON CLAVE contra el
// servidor. Una confirmación por /me no la renueva: si no, una clave reseteada
// seguiría abriendo el equipo para siempre mientras la sesión se mantuviera.

const CLAVE_ACCESOS = "erp-accesos-offline";

interface Acceso {
  huella: HuellaClave;
  usuario: UsuarioPayload;
  guardadoEn: number;
}

type MapaAccesos = Record<string, Acceso[]>;

/** El correo o DNI tal como lo teclea la persona, sin mayúsculas ni espacios. */
function llaveDe(identificador: string): string {
  return identificador.trim().toLowerCase();
}

function accesoValido(a: unknown): a is Acceso {
  if (typeof a !== "object" || a === null) return false;
  const x = a as Record<string, unknown>;
  const u = x.usuario as Record<string, unknown> | undefined;
  return (
    huellaValida(x.huella) &&
    typeof x.guardadoEn === "number" &&
    typeof u === "object" &&
    u !== null &&
    typeof u.id === "string" &&
    typeof u.tenantId === "string"
  );
}

/** Lo guardado puede estar corrupto, editado o venir del formato anterior (una
 *  sola entrada por identificador): se acepta solo lo que tiene la forma
 *  esperada y el resto se descarta. */
function leerAccesos(): MapaAccesos {
  try {
    const crudo = localStorage.getItem(CLAVE_ACCESOS);
    if (!crudo) return {};
    const parsed: unknown = JSON.parse(crudo);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const mapa: MapaAccesos = {};
    for (const [llave, valor] of Object.entries(parsed as Record<string, unknown>)) {
      const lista = (Array.isArray(valor) ? valor : [valor]).filter(accesoValido);
      if (lista.length > 0) mapa[llave] = lista;
    }
    return mapa;
  } catch {
    return {};
  }
}

function escribirAccesos(mapa: MapaAccesos): void {
  try {
    localStorage.setItem(CLAVE_ACCESOS, JSON.stringify(mapa));
  } catch {
    // Sin localStorage: no hay acceso sin señal en este equipo.
  }
}

/** Llamar solo con el login CONFIRMADO por el servidor: crea (o reemplaza) la
 *  huella de esta clave para esta persona y renueva su vigencia. Quien tiene la
 *  clave temporal pendiente no entra sin señal. */
export async function guardarAcceso(
  identificador: string,
  clave: string,
  usuario: UsuarioPayload
): Promise<void> {
  if (!huellaDisponible()) return;
  const llave = llaveDe(identificador);
  // Entrar con una clave temporal significa que el servidor acaba de cambiarla:
  // la huella que hubiera de esta persona es de la clave anterior y se borra.
  if (usuario.debeCambiarPassword) {
    const mapa = leerAccesos();
    const resto = (mapa[llave] ?? []).filter((a) => a.usuario.id !== usuario.id);
    if (resto.length > 0) mapa[llave] = resto;
    else delete mapa[llave];
    escribirAccesos(mapa);
    return;
  }
  try {
    const huella = await crearHuella(clave);
    const mapa = leerAccesos();
    const resto = (mapa[llave] ?? []).filter((a) => a.usuario.id !== usuario.id);
    mapa[llave] = [...resto, { huella, usuario, guardadoEn: Date.now() }];
    escribirAccesos(mapa);
  } catch {
    // Sin WebCrypto utilizable: ese equipo no entrará sin señal.
  }
}

/** Mantiene al día el perfil (rol, permisos) de los accesos de esta persona sin
 *  tocar su huella ni su vigencia.
 *
 *  Si el servidor confirma un perfil que no tiene entrada pero la persona sí la
 *  tiene por su correo (la clave es de la CUENTA, así que vale para todas sus
 *  empresas), se agrega la entrada de ese perfil con la misma huella y la misma
 *  vigencia: tras cambiar de empresa, el acceso sin señal abre la última. */
export function actualizarPerfilDeAcceso(usuario: UsuarioPayload): void {
  const mapa = leerAccesos();
  let cambio = false;
  for (const lista of Object.values(mapa)) {
    const i = lista.findIndex((a) => a.usuario.id === usuario.id);
    if (i === -1) continue;
    const [acceso] = lista.splice(i, 1) as [Acceso];
    acceso.usuario = usuario;
    lista.push(acceso); // la última confirmada queda al final
    cambio = true;
  }
  if (!cambio && usuario.email) {
    const lista = mapa[llaveDe(usuario.email)];
    const base = lista?.[lista.length - 1];
    if (lista && base) {
      lista.push({ huella: base.huella, usuario, guardadoEn: base.guardadoEn });
      cambio = true;
    }
  }
  if (cambio) escribirAccesos(mapa);
}

export type ResultadoAccesoLocal =
  | { estado: "ok"; usuario: UsuarioPayload; guardadoEn: number }
  | { estado: "clave" }
  | { estado: "vencido" }
  | { estado: "ambiguo" }
  | { estado: "sin_acceso" };

/** Sin servidor: ¿esta clave abre el acceso guardado de esta persona? No hay
 *  tope de intentos a propósito (decisión de producto): un conductor que se
 *  equivoca no debe quedar bloqueado en ruta. */
export async function accesoSinConexion(
  identificador: string,
  clave: string,
  ahora: number = Date.now()
): Promise<ResultadoAccesoLocal> {
  const lista = leerAccesos()[llaveDe(identificador)] ?? [];
  if (lista.length === 0 || !huellaDisponible()) return { estado: "sin_acceso" };
  const vigentes = lista.filter(
    (a) => ahora - a.guardadoEn <= VIGENCIA_PERFIL_OFFLINE_MS && a.guardadoEn <= ahora
  );
  if (vigentes.length === 0) return { estado: "vencido" };
  const abiertos: Acceso[] = [];
  for (const acceso of vigentes) {
    try {
      if (await claveCoincide(clave, acceso.huella)) abiertos.push(acceso);
    } catch {
      // una entrada ilegible no impide probar las demás
    }
  }
  if (abiertos.length === 0) return { estado: "clave" };
  // Misma huella en varias entradas = la misma cuenta en varias empresas: gana
  // la última que el servidor confirmó. Huellas distintas que abren con la misma
  // clave son DOS personas o perfiles distintos: no se adivina cuál.
  const mismaCuenta = abiertos.every((a) => a.huella.hash === abiertos[0]?.huella.hash);
  if (abiertos.length > 1 && !mismaCuenta) return { estado: "ambiguo" };
  const acceso = abiertos[abiertos.length - 1] as Acceso;
  return { estado: "ok", usuario: acceso.usuario, guardadoEn: acceso.guardadoEn };
}
