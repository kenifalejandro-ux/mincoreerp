// client/src/offline/claveOffline.ts
//
// La "huella" de una clave, para poder comprobarla sin servidor.
//
// Se guarda cuando alguien entra CON red y la clave la validó el servidor. Sin
// señal, la clave tecleada se compara contra esa huella y, si coincide, se deja
// entrar con el perfil guardado (ver perfilOffline.ts). La clave en sí nunca se
// guarda: solo un derivado PBKDF2 con sal propia, que no se puede revertir y
// que hace lento cada intento.
//
// WebCrypto solo existe en contextos seguros (https o localhost). En una
// dirección http de la red local no hay `crypto.subtle`: ahí no se guarda
// huella y ese equipo simplemente no entra sin señal.

/** 600.000 (OWASP para PBKDF2-SHA256): como no hay tope de intentos, lo que
 *  frena a quien tenga el equipo es lo caro de cada intento. */
const ITERACIONES = 600_000;

/** Solo se aceptan estos valores al comprobar: la huella vive en localStorage y
 *  un valor editado (1, o uno enorme que cuelgue el login) no se obedece. 310.000
 *  es el de las huellas guardadas antes de subirlo. */
const ITERACIONES_PERMITIDAS: readonly number[] = [310_000, 600_000];

export interface HuellaClave {
  sal: string;
  hash: string;
  iteraciones: number;
}

function aBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function deBase64(texto: string): Uint8Array {
  const s = atob(texto);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function huellaDisponible(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

async function derivar(clave: string, sal: Uint8Array, iteraciones: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clave),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal as BufferSource, iterations: iteraciones },
    material,
    256
  );
  return new Uint8Array(bits);
}

export async function crearHuella(clave: string): Promise<HuellaClave> {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(clave, sal, ITERACIONES);
  return { sal: aBase64(sal), hash: aBase64(hash), iteraciones: ITERACIONES };
}

/** ¿Lo leído de localStorage tiene la forma de una huella y valores admitidos? */
export function huellaValida(h: unknown): h is HuellaClave {
  if (typeof h !== "object" || h === null) return false;
  const x = h as Record<string, unknown>;
  return (
    typeof x.sal === "string" &&
    typeof x.hash === "string" &&
    typeof x.iteraciones === "number" &&
    ITERACIONES_PERMITIDAS.includes(x.iteraciones)
  );
}

export async function claveCoincide(clave: string, huella: HuellaClave): Promise<boolean> {
  if (!huellaValida(huella)) return false;
  const esperado = deBase64(huella.hash);
  const obtenido = await derivar(clave, deBase64(huella.sal), huella.iteraciones);
  if (esperado.length !== obtenido.length) return false;
  // Comparación sin cortocircuito.
  let diferencia = 0;
  for (let i = 0; i < esperado.length; i++) diferencia |= (esperado[i] ?? 0) ^ (obtenido[i] ?? 0);
  return diferencia === 0;
}
