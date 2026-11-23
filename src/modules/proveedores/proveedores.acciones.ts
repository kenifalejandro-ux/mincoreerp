/** src/modules/proveedores/proveedores.acciones.ts
 *
 * Eliminar un proveedor: cuándo se puede y cómo se dice. Lógica pura, sin base de datos.
 *
 * Un proveedor SIN historia se puede eliminar (p. ej. uno creado por error): su ficha, sus contactos y sus
 * cuentas bancarias se van con él. Con historia (precios —también los anulados—, compras, recepciones o
 * despachos) no: se desactiva, que lo saca de las listas de trabajo sin perder lo que se hizo con él.
 */

export interface MovimientosDeProveedor {
  precios: number;
  compras: number;
  recepciones: number;
  despachos: number;
}

export const hayMovimientos = (m: MovimientosDeProveedor): boolean =>
  m.precios + m.compras + m.recepciones + m.despachos > 0;

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** «2 precios», «1 compra»… solo lo que tiene, en un orden fijo. */
export function descripcionDeMovimientos(m: MovimientosDeProveedor): string[] {
  const partes: string[] = [];
  if (m.precios > 0) partes.push(plural(m.precios, "precio", "precios"));
  if (m.compras > 0) partes.push(plural(m.compras, "compra", "compras"));
  if (m.recepciones > 0) partes.push(plural(m.recepciones, "recepción", "recepciones"));
  if (m.despachos > 0) partes.push(plural(m.despachos, "despacho", "despachos"));
  return partes;
}

/** El mensaje cuando no se puede eliminar. */
export function mensajeDeNoEliminable(m: MovimientosDeProveedor): string {
  const partes = descripcionDeMovimientos(m);
  const lista =
    partes.length <= 1 ? partes.join("") : `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}`;
  return `No se puede eliminar: tiene ${lista}. Desactívalo en su lugar.`;
}
