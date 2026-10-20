// client/src/components/ureaCompartido.ts
//
// Las funciones puras que UreaPanel y "Compra en ruta" comparten: qué envases
// se pueden usar, el precio de catálogo vigente, los renglones de una compra y
// la hora local del formulario. Van aparte porque un archivo de componentes no
// puede exportar funciones sueltas (react-refresh/only-export-components).
import type { PrecioUrea, PresentacionFila, RenglonCompra } from "./UreaPanel";

type Presentacion = string;

/** La etiqueta de un movimiento YA cargado: el nombre que el envase tiene
 *  hoy, con los litros que ESA FILA congeló (`factor_litros`, columna de
 *  0092). Usar los litros del catálogo acá haría que corregir la caja de 16
 *  a 20 reescribiera en pantalla todos los vales viejos -- exactamente lo
 *  que la columna congelada existe para impedir. Un envase dado de baja
 *  sigue mostrando su nombre; si ya no está en el catálogo, se muestra el
 *  código crudo antes que un hueco. */
/** Las que se pueden usar para cargar algo NUEVO. Una desactivada sigue
 *  siendo legible en el historial, pero el servidor la rechaza en un
 *  movimiento nuevo (resolverFactorPresentacionUrea), así que ofrecerla
 *  sería ofrecer un error. */
export function presentacionesActivas(presentaciones: PresentacionFila[]): PresentacionFila[] {
  return presentaciones.filter((p) => p.activa);
}

/** La que arranca seleccionada en los formularios: la de referencia de la
 *  empresa, y si no hay, la primera activa. Nunca un código fijo -- "bolsa"
 *  puede no existir en una empresa que dio de alta sus propios envases. */
export function presentacionPorDefecto(presentaciones: PresentacionFila[]): Presentacion {
  const activas = presentacionesActivas(presentaciones);
  return (activas.find((p) => p.es_referencia) ?? activas[0])?.codigo ?? "";
}

export function ahoraParaInputLocal(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** El precio de catálogo que rige para este proveedor y esta presentación a
 *  esta fecha: el más reciente no anulado con vigencia <= fecha. El mismo
 *  criterio que usa el servidor para la alerta (findPrecioUreaVigente) -- si
 *  el formulario autocompletara con otra regla, sugeriría un precio y después
 *  alertaría contra otro. */
export function precioVigenteUrea(
  precios: PrecioUrea[],
  grifoId: string,
  presentacion: string,
  fechaLocal: string
): PrecioUrea | null {
  if (!grifoId || !presentacion) return null;
  const fecha = fechaLocal ? new Date(fechaLocal).getTime() : Date.now();
  return (
    precios
      .filter(
        (p) =>
          String(p.grifo_id) === grifoId &&
          p.presentacion === presentacion &&
          p.anulada_en === null &&
          new Date(p.vigente_desde).getTime() <= fecha
      )
      .sort(
        (a, b) => new Date(b.vigente_desde).getTime() - new Date(a.vigente_desde).getTime()
      )[0] ?? null
  );
}

export function nuevoRenglon(presentacion: string, precio = ""): RenglonCompra {
  return { clave: crypto.randomUUID(), presentacion, cantidad: "", precio, precioAuto: true };
}

/** Si los renglones se pueden mandar: cada uno con su cantidad (y su precio,
 *  si el papel lo trae), y sin el mismo envase dos veces -- el servidor lo
 *  rechaza igual, pero la persona se entera antes. */
export function estadoRenglones(renglones: RenglonCompra[], conPrecio: boolean) {
  const codigos = renglones.map((r) => r.presentacion);
  const repetida = new Set(codigos).size !== codigos.length;
  const completos = renglones.every(
    (r) => r.presentacion && Number(r.cantidad) > 0 && (!conPrecio || Number(r.precio) > 0)
  );
  return { repetida, listos: completos && !repetida };
}
