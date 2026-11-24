// client/src/components/mantenimiento/parsearPlanillaEquipos.ts
//
// Lee el libro de Excel que entrega el hook de importación y lo pasa a la lógica de importarEquipos.ts. Va aparte
// porque necesita los tipos de `xlsx`, que solo existen con las dependencias del cliente instaladas.
import type { WorkBook } from "xlsx";

import { leerFilasDeLaPlanilla, type FilaImportacionEquipo } from "./importarEquipos";
import type { UtilidadesXlsx } from "../comunes/useImportacionExcel";

/** Para el hook de importación: lee la primera hoja del libro. */
export function parsearPlanillaEquipos(
  libro: WorkBook,
  utils: UtilidadesXlsx
): FilaImportacionEquipo[] {
  const hoja = libro.Sheets[libro.SheetNames[0]];
  if (!hoja) throw new Error("El archivo no tiene ninguna hoja de cálculo.");
  return leerFilasDeLaPlanilla(
    utils.sheet_to_json<unknown[]>(hoja, { header: 1, defval: "", blankrows: false })
  );
}
