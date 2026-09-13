/** tests/xlsxLectura.ts
 *
 * Lectura mínima de los .xlsx que genera `xlsx.util.ts`, para que los tests
 * puedan mirar adentro del archivo. No es un lector general de ZIP: se puede
 * hacer así de simple porque el generador no usa descriptores de datos, así
 * que el tamaño comprimido siempre está en la cabecera local.
 *
 * Vive aparte y no en helpers.ts porque no necesita ni la app ni la base: el
 * test del generador es puramente unitario y no tiene por qué levantarlas.
 */
import { inflateRawSync } from "zlib";

interface Parte {
  nombre: string;
  contenido: string;
}

function partes(zip: Buffer): Parte[] {
  const resultado: Parte[] = [];
  let off = 0;
  while (off + 30 <= zip.length && zip.readUInt32LE(off) === 0x04034b50) {
    const compSize = zip.readUInt32LE(off + 18);
    const nameLen = zip.readUInt16LE(off + 26);
    const extraLen = zip.readUInt16LE(off + 28);
    const nombre = zip.subarray(off + 30, off + 30 + nameLen).toString("utf8");
    const inicio = off + 30 + nameLen + extraLen;
    resultado.push({
      nombre,
      contenido: inflateRawSync(zip.subarray(inicio, inicio + compSize)).toString("utf8"),
    });
    off = inicio + compSize;
  }
  return resultado;
}

export function nombresDePartes(zip: Buffer): string[] {
  return partes(zip).map((p) => p.nombre);
}

export function leerEntrada(zip: Buffer, buscado: string): string {
  const parte = partes(zip).find((p) => p.nombre === buscado);
  if (!parte) throw new Error(`No existe la parte ${buscado} en el archivo`);
  return parte.contenido;
}

/** Los nombres de las hojas, en orden, tal como los ve Excel en las solapas. */
export function nombresDeHojas(zip: Buffer): string[] {
  const workbook = leerEntrada(zip, "xl/workbook.xml");
  return [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
}

/** El XML de una hoja por su nombre visible, no por su número interno. */
export function hojaPorNombre(zip: Buffer, nombre: string): string {
  const indice = nombresDeHojas(zip).indexOf(nombre);
  if (indice < 0) throw new Error(`No existe la hoja "${nombre}"`);
  return leerEntrada(zip, `xl/worksheets/sheet${indice + 1}.xml`);
}
