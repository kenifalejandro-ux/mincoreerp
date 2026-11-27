// client/src/components/mantenimiento/conformidad.ts
//
// Quién da la conformidad de una orden y la etiqueta «Nuevo» de esa entrega, sin React.
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

const NOVEDAD = "mantenimiento-conformidad-2026-11";
export const conformidadEsNueva = () => novedadVigente(Date.now(), undefined, NOVEDAD);
export const marcarConformidadVista = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD);

/** La casilla la marca el administrador persona por persona: ni el rol admin la trae. El servidor es la
 *  barrera real. */
export const tieneCasillaDeConformidad = (
  u: { permisosPestanas?: Record<string, boolean> } | null | undefined
) => u?.permisosPestanas?.["ordenes_trabajo:conformidad:dar"] === true;
