// La etiqueta «Nuevo» del botón de lecturas del medidor en Flota. Reusa el mecanismo del Control TV
// (24 horas después del primer clic) con su propia clave.
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

export const NOVEDAD_LECTURAS = "flota-lecturas-2026-11";

export const lecturasEsNuevo = () => novedadVigente(Date.now(), undefined, NOVEDAD_LECTURAS);
export const marcarLecturasVistas = () =>
  marcarNovedadVista(Date.now(), undefined, NOVEDAD_LECTURAS);
