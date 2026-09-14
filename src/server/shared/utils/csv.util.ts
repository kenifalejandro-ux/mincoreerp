// src/server/shared/utils/csv.util.ts
//
// Serialización a CSV para los reportes exportables del ERP. Nació con el
// kardex de combustible, que es el primer reporte que un auditor se lleva
// para trabajarlo afuera.
//
// ── CSV y .xlsx ─────────────────────────────────────────────────────────
//
// El .xlsx llegó después, en `xlsx.util.ts`, escrito a mano sin dependencias.
// La razón que figuraba acá para no hacerlo -- que SheetJS rompería el gate de
// `npm audit` -- resultó no ser cierta para la versión que el cliente ya usa,
// pero la decisión de no meterla en el backend se sostiene por otro motivo:
// ver el encabezado de xlsx.util.ts.
//
// El CSV se queda porque sirve para otra cosa: lo abre cualquier programa y se
// pega en otro sistema sin conversión. Lo que el .xlsx agrega no es solo
// formato: son números que suman (ver `neutralizarFormula` abajo) y fórmulas.
//
// Este módulo solo SERIALIZA: quien lo llama arma las filas.

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
 *  se escribió (es evidencia). Solo se le antepone el escape.
 *
 *  UN NÚMERO NEGATIVO NO ES UNA FÓRMULA, y no se toca. La primera versión de
 *  esto escapaba todo lo que arrancara con "-", y `-300` también arranca con
 *  "-": cada faltante del kardex salía como TEXTO, y en Excel la columna del
 *  descuadre -- la única que importa -- no sumaba. Lo encontró Kenif haciendo
 *  `=SUMAR.SI(...;"<0")` sobre el archivo y obteniendo cero.
 *
 *  El chequeo es estricto a propósito: solo un número puro (signo opcional,
 *  dígitos, decimales, exponente) pasa sin escape. `-1+1`, `-cmd|...` o
 *  `-HYPERLINK(...)` no son números puros y siguen neutralizados. */
const NUMERO_PURO = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

function neutralizarFormula(valor: string): string {
  if (NUMERO_PURO.test(valor)) return valor;
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
