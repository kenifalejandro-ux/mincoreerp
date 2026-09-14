// src/server/shared/utils/xlsx.util.ts
//
// Generación de archivos .xlsx (Excel / LibreOffice Calc) SIN DEPENDENCIAS.
//
// ── Por qué escribirlo a mano ───────────────────────────────────────────
//
// Un .xlsx es un ZIP con XML adentro, y Node ya trae las dos piezas que hacen
// falta: `zlib` para comprimir y `Buffer` para armar el contenedor. Lo único
// que hay que escribir es el formato, que para lo que este ERP necesita
// -- hojas, celdas, fórmulas y encabezados en negrita -- entra en un archivo.
//
// La alternativa era SheetJS. El cliente ya la tiene (para IMPORTAR planillas,
// ver CombustiblePanel) y no rompe el gate de `npm audit`, así que el veto que
// quedó escrito en csv.util.ts está viejo. Pero meterla en el backend agrega
// una dependencia grande para usar el 2 % de su superficie, y sobre todo: un
// reporte que se manda por correo o que corre programado NO tiene navegador.
// El generador vive acá para que el servidor pueda armar el archivo solo.
//
// ── Por qué el .xlsx no necesita el escape de csv.util.ts ───────────────
//
// En CSV, una celda que arranca con "=" ES una fórmula: no hay forma de
// distinguir dato de código, y por eso hay que neutralizar con una comilla.
// En .xlsx el tipo de celda es EXPLÍCITO -- un texto va en <is><t> y una
// fórmula en <f> -- así que un motivo de anulación que diga
// `=cmd|' /C calc'!A0` viaja como texto y Excel lo muestra tal cual. La
// inyección de fórmulas no existe en este formato: no hay que hacer nada para
// evitarla, y tampoco hay que romper los números negativos para lograrlo.

import { deflateRawSync } from "zlib";

/** Cómo se MUESTRA un número; el valor guardado no cambia.
 *
 *  - `decimal`: separador de miles y 2 decimales (litros, porcentajes).
 *  - `entero`: separador de miles, sin decimales (conteos, capacidades).
 *
 *  Existe porque sin formato una fórmula muestra todos los decimales que
 *  calcula ("2895.601107233") y el usuario no sabe qué parte importa. Son los
 *  formatos PREDEFINIDOS 4 y 3 del estándar: no hace falta declararlos, y Excel
 *  y LibreOffice los adaptan al separador del idioma de quien abre el archivo. */
export type FormatoNumeroXlsx = "decimal" | "entero";

/** Una celda. El atajo (string/number/null) cubre el caso simple; el objeto es
 *  para fórmulas, negrita y formato de número.
 *
 *  `formula` va SIN el "=" inicial y con los nombres de función en inglés
 *  (AVERAGE, STDEV, SQRT): así se guardan dentro del archivo. Excel y
 *  LibreOffice las muestran traducidas al idioma del usuario -- quien abra
 *  esto en español va a ver PROMEDIO y DESVEST. */
export type CeldaXlsx =
  | string
  | number
  | null
  | {
      valor?: string | number | null;
      formula?: string;
      negrita?: boolean;
      formato?: FormatoNumeroXlsx;
    };

export interface HojaXlsx {
  nombre: string;
  filas: CeldaXlsx[][];
  /** Ancho de cada columna, en caracteres. Opcional: sin esto las columnas
   *  salen con el ancho por defecto y los textos largos quedan cortados a la
   *  vista (el dato está, pero hay que ensanchar a mano). */
  anchos?: number[];
}

// ====================== XML ======================

/** Tab, salto de línea y retorno de carro son válidos en XML; cualquier otro
 *  carácter por debajo del 32 no lo es, y UNO SOLO hace que Excel rechace el
 *  archivo entero. Vienen de texto que tipea un usuario, así que no es un caso
 *  teórico.
 *
 *  Se filtra por código de carácter y no con una expresión regular: una regex
 *  de control lleva esos mismos caracteres escritos en el código fuente, donde
 *  son invisibles al revisarlo (y eslint la rechaza por eso mismo). */
function quitarCaracteresDeControl(texto: string): string {
  let limpio = "";
  for (const ch of texto) {
    const codigo = ch.charCodeAt(0);
    if (codigo < 32 && codigo !== 9 && codigo !== 10 && codigo !== 13) continue;
    limpio += ch;
  }
  return limpio;
}

function escaparXml(texto: string): string {
  return quitarCaracteresDeControl(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". Las planillas de hoy no llegan ni a la Z,
 *  pero un reporte nuevo con treinta columnas no tiene por qué descubrir que
 *  esto no estaba contemplado. */
export function letraColumna(indice: number): string {
  let n = indice;
  let letras = "";
  do {
    letras = String.fromCharCode(65 + (n % 26)) + letras;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letras;
}

/** Excel rechaza el archivo si un nombre de hoja pasa los 31 caracteres o
 *  trae alguno de estos signos. Se recorta en silencio: el nombre de la hoja
 *  es presentación, y fallar la descarga por eso sería peor que el recorte. */
function sanearNombreHoja(nombre: string, indice: number): string {
  const limpio = nombre
    .replace(/[[\]:*?/\\]/g, " ")
    .slice(0, 31)
    // El trim va DESPUÉS del recorte, no antes: cortar en el carácter 31
    // puede dejar espacios colgando al final, y una hoja llamada "Detalle  "
    // se ve como un error de tipeo en la solapa.
    .trim();
  return limpio.length > 0 ? limpio : `Hoja${indice + 1}`;
}

function celdaXml(celda: CeldaXlsx, ref: string): string {
  if (celda === null || celda === undefined || celda === "") return "";

  const obj = typeof celda === "object" ? celda : { valor: celda };
  const indice = indiceEstilo(obj.negrita ?? false, obj.formato);
  const estilo = indice > 0 ? ` s="${indice}"` : "";

  if (obj.formula) {
    return `<c r="${ref}"${estilo}><f>${escaparXml(obj.formula)}</f></c>`;
  }

  const valor = obj.valor;
  if (valor === null || valor === undefined || valor === "") return "";

  // `Number.isFinite` y no `typeof`: un NaN o un Infinity escritos como <v>
  // hacen que Excel declare el archivo corrupto y no abra NADA. Un promedio
  // sobre una lista vacía es NaN, y eso puede pasar en un período sin datos.
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) return "";
    return `<c r="${ref}"${estilo}><v>${valor}</v></c>`;
  }

  return `<c r="${ref}"${estilo} t="inlineStr"><is><t xml:space="preserve">${escaparXml(
    String(valor)
  )}</t></is></c>`;
}

function hojaXml(hoja: HojaXlsx): string {
  const cols =
    hoja.anchos && hoja.anchos.length > 0
      ? `<cols>${hoja.anchos
          .map(
            (ancho, i) => `<col min="${i + 1}" max="${i + 1}" width="${ancho}" customWidth="1"/>`
          )
          .join("")}</cols>`
      : "";

  const filas = hoja.filas
    .map((fila, f) => {
      const celdas = fila.map((celda, c) => celdaXml(celda, `${letraColumna(c)}${f + 1}`)).join("");
      return celdas ? `<row r="${f + 1}">${celdas}</row>` : "";
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${filas}</sheetData></worksheet>`;
}

/** Seis estilos, en pares (normal / negrita) por cada formato de número:
 *
 *    0 normal            1 negrita
 *    2 decimal           3 decimal + negrita
 *    4 entero            5 entero + negrita
 *
 *  Los bloques `fonts`/`fills`/`borders`/`cellStyleXfs` son obligatorios
 *  aunque no se usen, y `fills` necesita SÍ o SÍ sus dos entradas (none y
 *  gray125) o Excel considera el archivo inválido. */
function indiceEstilo(negrita: boolean, formato?: FormatoNumeroXlsx): number {
  const base = formato === "decimal" ? 2 : formato === "entero" ? 4 : 0;
  return base + (negrita ? 1 : 0);
}

const xf = (numFmtId: number, fontId: number) =>
  `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="0" borderId="0" xfId="0"` +
  `${fontId > 0 ? ' applyFont="1"' : ""}${numFmtId > 0 ? ' applyNumberFormat="1"' : ""}/>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">${xf(0, 0)}${xf(0, 1)}${xf(4, 0)}${xf(4, 1)}${xf(3, 0)}${xf(3, 1)}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ====================== ZIP ======================

const TABLA_CRC32 = (() => {
  const tabla = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[i] = c >>> 0;
  }
  return tabla;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC32[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fecha fija (1/1/2020) en vez de `new Date()`: hace que el mismo contenido
 *  produzca SIEMPRE el mismo archivo, byte por byte. Sin esto un test no puede
 *  comparar salidas y dos descargas del mismo reporte difieren. La fecha
 *  interna del ZIP no se muestra en ningún lado. */
const FECHA_DOS = ((2020 - 1980) << 9) | (1 << 5) | 1;
const HORA_DOS = 0;

interface EntradaZip {
  nombre: string;
  contenido: Buffer;
}

function armarZip(entradas: EntradaZip[]): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;

  for (const entrada of entradas) {
    const nombre = Buffer.from(entrada.nombre, "utf8");
    const crudo = entrada.contenido;
    const comprimido = deflateRawSync(crudo);
    const crc = crc32(crudo);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión mínima para extraer
    local.writeUInt16LE(0, 6); // sin flags
    local.writeUInt16LE(8, 8); // método: deflate
    local.writeUInt16LE(HORA_DOS, 10);
    local.writeUInt16LE(FECHA_DOS, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(crudo.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28); // sin campo extra
    locales.push(local, nombre, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // versión que lo creó
    central.writeUInt16LE(20, 6); // versión mínima para extraer
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(HORA_DOS, 12);
    central.writeUInt16LE(FECHA_DOS, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(crudo.length, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentario
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    central.writeUInt32LE(offset, 42);
    centrales.push(central, nombre);

    offset += local.length + nombre.length + comprimido.length;
  }

  const cuerpo = Buffer.concat(locales);
  const directorio = Buffer.concat(centrales);

  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(0, 4); // número de disco
  fin.writeUInt16LE(0, 6); // disco del directorio
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(cuerpo.length, 16);
  fin.writeUInt16LE(0, 20); // sin comentario

  return Buffer.concat([cuerpo, directorio, fin]);
}

// ====================== API ======================

/** Arma el .xlsx completo. Devuelve el Buffer listo para `res.send()`.
 *
 *  `fullCalcOnLoad` en el workbook NO es decorativo: las fórmulas se guardan
 *  sin su resultado (no hay motor de cálculo acá), así que sin esa bandera
 *  LibreOffice las muestra vacías hasta que el usuario toca una celda. Con
 *  ella, el archivo llega calculado. */
export function armarXlsx(hojas: HojaXlsx[]): Buffer {
  if (hojas.length === 0) throw new Error("Un .xlsx necesita al menos una hoja");

  const nombres = hojas.map((h, i) => sanearNombreHoja(h.nombre, i));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${hojas
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join("\n")}
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${nombres
    .map(
      (nombre, i) => `<sheet name="${escaparXml(nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join("")}</sheets>
<calcPr calcId="0" fullCalcOnLoad="1"/>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${hojas
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join("\n")}
<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return armarZip([
    { nombre: "[Content_Types].xml", contenido: Buffer.from(contentTypes, "utf8") },
    { nombre: "_rels/.rels", contenido: Buffer.from(rels, "utf8") },
    { nombre: "xl/workbook.xml", contenido: Buffer.from(workbook, "utf8") },
    { nombre: "xl/_rels/workbook.xml.rels", contenido: Buffer.from(workbookRels, "utf8") },
    { nombre: "xl/styles.xml", contenido: Buffer.from(STYLES_XML, "utf8") },
    ...hojas.map((hoja, i) => ({
      nombre: `xl/worksheets/sheet${i + 1}.xml`,
      contenido: Buffer.from(hojaXml(hoja), "utf8"),
    })),
  ]);
}

/** El Content-Type que espera el navegador para que el archivo se descargue
 *  como planilla y no como texto plano. */
export const CONTENT_TYPE_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
