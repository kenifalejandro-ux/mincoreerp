// La etiqueta «Nuevo» de las horas y tareas de la orden (24 horas desde el primer clic). Reusa el
// mecanismo del Control TV con su propia clave.
import { marcarNovedadVista, novedadVigente } from "../controlTv/novedad";

const NOVEDAD = "ot-horas-tareas-2026-11";

export const horasYTareasEsNuevo = () => novedadVigente(Date.now(), undefined, NOVEDAD);
export const marcarHorasYTareasVistas = () => marcarNovedadVista(Date.now(), undefined, NOVEDAD);
