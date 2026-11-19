// client/src/components/combustible/unidadEscrita.ts
//
// La unidad de un vale que se ESCRIBE (placa a mano) en vez de elegirse de la lista. Es la misma
// regla del vale del tanque propio (0176) y de lo que el servidor hace con la placa: si coincide
// con una unidad dada de alta se toma esa; si no, el vale queda con la placa escrita
// (`unidad_sin_alta`). Sin Flota la lista de unidades llega vacía y todo cae en la segunda rama.
//
// Lógica pura, sin React: la prueba vive en tests/unidad-escrita-cliente.test.ts.

/** La placa para comparar: mayúsculas, sin espacios ni guiones ("t8m 821" = "T8M-821"). */
export const normalizarPlaca = (texto: string) => texto.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Lo mínimo que se necesita de una unidad registrada. */
export interface UnidadRegistrada {
  id: number;
  placa_codigo: string;
  tipo?: string | null;
}

export type UnidadDelVale<T extends UnidadRegistrada> =
  { tipo: "registrada"; equipo: T } | { tipo: "escrita"; placa: string } | { tipo: "vacia" };

/** Qué unidad es la que se escribió. Menos de 3 caracteres útiles no es una placa todavía. */
export function resolverUnidad<T extends UnidadRegistrada>(
  texto: string,
  equipos: readonly T[]
): UnidadDelVale<T> {
  const clave = normalizarPlaca(texto);
  if (!clave) return { tipo: "vacia" };
  const equipo = equipos.find((e) => normalizarPlaca(e.placa_codigo) === clave);
  if (equipo) return { tipo: "registrada", equipo };
  return clave.length >= 3 ? { tipo: "escrita", placa: texto.trim() } : { tipo: "vacia" };
}

/** Los campos del body del vale que dicen a qué unidad va. */
export function camposDeUnidad<T extends UnidadRegistrada>(unidad: UnidadDelVale<T>) {
  if (unidad.tipo === "registrada") {
    return { tipo_destino: "equipo" as const, equipo_id: unidad.equipo.id };
  }
  if (unidad.tipo === "escrita") {
    return { tipo_destino: "unidad_sin_alta" as const, placa_sin_alta: unidad.placa };
  }
  return null;
}
