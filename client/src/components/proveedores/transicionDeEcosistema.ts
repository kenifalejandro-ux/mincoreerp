// client/src/components/proveedores/transicionDeEcosistema.ts
//
// Cuánto dura la pantalla de carga entre el ERP y un ecosistema (ver PantallaDeCarga.tsx).
export type TransicionDeEcosistema = "entrar" | "volver";

/** Lo que dura la pantalla antes de mostrar el destino. */
export const DURACION_TRANSICION_MS = 1900;
export const DURACION_TRANSICION_REDUCIDA_MS = 500;

export function duracionDeTransicion(): number {
  const reducir =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reducir ? DURACION_TRANSICION_REDUCIDA_MS : DURACION_TRANSICION_MS;
}
