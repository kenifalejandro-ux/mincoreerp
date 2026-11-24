// client/src/components/mantenimiento/rutaMantenimiento.ts
//
// La dirección (URL) del ecosistema «Gestión de mantenimiento». Una por sección, para que F5 deje a la
// persona donde estaba, el botón «atrás» funcione y un enlace se pueda guardar o mandar:
//
//   /mantenimiento            Centro de control
//   /mantenimiento/equipos    Equipos
//
// Lógica pura, sin React ni `window`. Una dirección que no se entiende se lee como el Centro, nunca rompe.
// Qué sección puede ver cada persona NO se decide acá: lo decide el ecosistema.

export type SeccionDeRuta = "centro" | "equipos";

export interface EstadoDeRuta {
  seccion: SeccionDeRuta;
}

export const PREFIJO_DE_RUTA = "/mantenimiento";

/** Cómo se escribe cada sección en la dirección. */
const SLUG_DE_SECCION: Record<SeccionDeRuta, string> = {
  centro: "",
  equipos: "equipos",
};

const ETIQUETA_DE_SECCION: Record<SeccionDeRuta, string> = {
  centro: "Centro de control",
  equipos: "Equipos",
};

/** ¿Esta dirección es del ecosistema? (`/mantenimiento` o `/mantenimiento/…`; no `/mantenimientoX`). */
export function esRutaDeMantenimiento(pathname: string): boolean {
  return pathname === PREFIJO_DE_RUTA || pathname.startsWith(`${PREFIJO_DE_RUTA}/`);
}

/** El estado que describe una dirección, o `null` si no es del ecosistema. */
export function leerRuta(pathname: string): EstadoDeRuta | null {
  if (!esRutaDeMantenimiento(pathname)) return null;
  const primera = pathname
    .slice(PREFIJO_DE_RUTA.length)
    .split("/")
    .filter((p) => p !== "")[0]
    ?.toLowerCase();
  const seccion = (Object.keys(SLUG_DE_SECCION) as SeccionDeRuta[]).find(
    (s) => SLUG_DE_SECCION[s] !== "" && SLUG_DE_SECCION[s] === primera
  );
  return { seccion: seccion ?? "centro" };
}

/** La dirección de un estado. La inversa de `leerRuta` para todo estado válido. */
export function rutaDe(estado: EstadoDeRuta): string {
  const slug = SLUG_DE_SECCION[estado.seccion];
  return slug === "" ? PREFIJO_DE_RUTA : `${PREFIJO_DE_RUTA}/${slug}`;
}

/** El título de la pestaña del navegador: la sección en la que está. */
export function tituloDeRuta(estado: EstadoDeRuta): string {
  return `${ETIQUETA_DE_SECCION[estado.seccion]} · Gestión de mantenimiento`;
}
