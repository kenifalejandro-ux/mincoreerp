// src/server/shared/utils/csv.util.ts
//
// Serialización a CSV para los reportes exportables del ERP. Nació con el
// kardex de combustible, que es el primer reporte que un auditor se lleva
// para trabajarlo afuera.
//
// ── Por qué CSV y no .xlsx ──────────────────────────────────────────────
//
// Un .xlsx de verdad necesita una librería, y la popular (SheetJS) arrastra
// advisories de severidad alta: agregarla dejaría main en rojo contra el gate
// `npm audit --audit-level=high` de ci.yml. CSV lo genera Node con un join, y
// el auditor lo abre en Excel y hace exactamente lo mismo: filtrar, ordenar,
// tabla dinámica. Lo que el .xlsx agrega es FORMATO, no datos.
//
// Kenif pidió que el .xlsx llegue después como segunda opción. Por eso este
// módulo solo SERIALIZA: quien lo llama arma las filas. El día que se sume
// el .xlsx, se le enchufa otra función de serialización a los mismos datos.

/** Excel ejecuta como fórmula cualquier celda que arranque con = + - @, y
 *  también con TAB o CR. Es la inyección de CSV, y acá importa de verdad:
 *  las celdas salen de texto que tipea el usuario -- nombre del tanque,
 *  motivo de anulación, nombre del grifo, placa del equipo.
 *
 *  `=cmd|' /C calc'!A0` en un motivo de anulación se vuelve ejecución de
 *  comandos en la máquina del auditor que abre el archivo. Se neutraliza
 *  prefijando una comilla simple, que Excel muestra como texto y no dispara.
 *
 *  No se sanea "limpiando" el contenido: el motivo tiene que llegar TAL CUAL
 *  se escribió (es evidencia). Solo se le antepone el escape. */
function neutralizarFormula(valor: string): string {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}

/** Una celda CSV: comillas dobles duplicadas y el campo entero entrecomillado
 *  si trae separador, comillas o saltos de línea (RFC 4180). */
function celda(valor: unknown, separador: string): string {
  if (valor === null || valor === undefined) return "";
  const texto = neutralizarFormula(String(valor));
  const necesitaComillas = texto.includes(separador) || texto.includes('"') || /[\n\r]/.test(texto);
  return necesitaComillas ? `"${texto.replace(/"/g, '""')}"` : texto;
}

export interface OpcionesCsv {
  /** Por defecto coma. Perú usa el punto como separador decimal, así que la
   *  coma no colisiona con los números y Excel la reconoce sin ayuda. */
  separador?: string;
}

/** Arma el CSV completo, con BOM.
 *
 *  EL BOM NO ES OPCIONAL: sin él, Excel en Windows interpreta el archivo como
 *  ANSI y "Recepción" se ve "Recepci?n". Son tres bytes que evitan que el
 *  reporte llegue ilegible a la única persona que lo va a leer. */
export function armarCsv(
  encabezados: string[],
  filas: unknown[][],
  opciones: OpcionesCsv = {}
): string {
  const sep = opciones.separador ?? ",";
  const lineas = [
    encabezados.map((h) => celda(h, sep)).join(sep),
    ...filas.map((f) => f.map((v) => celda(v, sep)).join(sep)),
  ];
  // CRLF: es lo que dice RFC 4180 y lo que Excel espera en Windows.
  // El BOM va como escape y no como carácter literal: invisible en el
  // editor, es imposible de revisar y eslint lo rechaza (no-irregular-whitespace).
  return `\uFEFF${lineas.join("\r\n")}\r\n`;
}
