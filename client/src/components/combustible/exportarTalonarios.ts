import { hojasDelExcel } from "./talonariosCuadre";
import { fechaCorta, type SerieTalonario } from "./valesFaltantesLogica";

/** Baja un .xlsx con las series del período y, en otra hoja, los tramos que faltan. La librería
 *  se carga recién al exportar: no pesa en el resto de la pantalla. */
export async function exportarTalonariosExcel(series: SerieTalonario[], nombreArchivo: string) {
  if (series.length === 0) return;
  const XLSX = await import("xlsx");
  const { filasSeries, filasTramos } = hojasDelExcel(series, fechaCorta);
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasSeries), "Talonarios");
  if (filasTramos.length > 0) {
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasTramos), "Vales que faltan");
  }
  XLSX.writeFile(libro, nombreArchivo);
}
