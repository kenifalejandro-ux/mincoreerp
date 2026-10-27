import { filasDeViajes } from "./filasDeViajes";
import type { FilaViaje } from "./viajesFormato";

/** Baja un .xlsx con los viajes que la lista muestra ahora (respeta los filtros). La librería
 *  se carga recién al exportar: no pesa en el resto de la pantalla. */
export async function exportarViajesExcel(
  viajes: FilaViaje[],
  estadoDe: (v: FilaViaje) => string,
  nombreArchivo: string
) {
  if (viajes.length === 0) return;
  const XLSX = await import("xlsx");
  const hoja = XLSX.utils.json_to_sheet(filasDeViajes(viajes, estadoDe));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Viajes");
  XLSX.writeFile(libro, nombreArchivo);
}
