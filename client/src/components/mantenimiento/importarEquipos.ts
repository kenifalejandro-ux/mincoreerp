// client/src/components/mantenimiento/importarEquipos.ts
//
// Leer la planilla de equipos, sin React: encabezados con nombres libres (con o sin tildes, «Placa» o «Código»),
// filas vacías ignoradas y los valores de medidor y propiedad en palabras. Lo que no se puede entender se dice
// con su fila ANTES de mandar nada; lo demás (placa repetida, tipo vacío…) lo valida el servidor, que también
// dice la fila y la columna.
import type { WorkBook } from "xlsx";

import { leerLectura } from "./formularioEquipo";
import type { UtilidadesXlsx } from "../comunes/useImportacionExcel";

/** Tope de equipos por archivo: espejo del que aplica el servidor (MAX_FILAS_IMPORTACION_EQUIPOS). */
export const MAX_FILAS_IMPORTACION = 1000;

/** Una fila lista para el servidor (el área viaja por su nombre). */
export interface FilaImportacionEquipo {
  placa_codigo: string;
  tipo: string;
  marca: string;
  modelo: string;
  medidor: "horometro" | "odometro";
  lectura: number;
  propiedad: "propia" | "alquilada";
  area: string;
}

type Columna = "placa" | "tipo" | "marca" | "modelo" | "medidor" | "lectura" | "propiedad" | "area";

const clave = (texto: unknown) =>
  String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Cómo puede llamarse cada columna en el encabezado (ya sin tildes, mayúsculas ni signos). */
const NOMBRES: Record<Columna, string[]> = {
  placa: ["placa", "placacodigo", "placaocodigo", "codigo", "equipo"],
  tipo: ["tipo", "tipodeequipo"],
  marca: ["marca"],
  modelo: ["modelo"],
  medidor: ["medidor", "semidecon"],
  lectura: ["lectura", "lecturaactual"],
  propiedad: ["propiedad"],
  area: ["area", "areadetrabajo"],
};

export const COLUMNAS_DE_LA_PLANILLA =
  "Placa, Tipo, Marca, Modelo, Medidor, Lectura, Propiedad y Área";

const texto = (v: unknown) => String(v ?? "").trim();

function medidorDe(v: unknown, fila: number): FilaImportacionEquipo["medidor"] {
  const c = clave(v);
  if (c === "" || ["horometro", "horas", "hora", "h"].includes(c)) return "horometro";
  if (["odometro", "km", "kilometros", "kilometro"].includes(c)) return "odometro";
  throw new Error(
    `Fila ${fila}: el medidor «${texto(v)}» no se entiende. Escribe Horómetro u Odómetro.`
  );
}

function propiedadDe(v: unknown, fila: number): FilaImportacionEquipo["propiedad"] {
  const c = clave(v);
  if (c === "" || ["propia", "propio"].includes(c)) return "propia";
  if (["alquilada", "alquilado", "alquiler"].includes(c)) return "alquilada";
  throw new Error(
    `Fila ${fila}: la propiedad «${texto(v)}» no se entiende. Escribe Propia o Alquilada.`
  );
}

function lecturaDe(v: unknown, fila: number): number {
  if (typeof v === "number") {
    if (v >= 0) return v;
  } else {
    const n = leerLectura(texto(v));
    if (!Number.isNaN(n)) return n;
  }
  throw new Error(`Fila ${fila}: la lectura «${texto(v)}» no es un número.`);
}

/** Las filas de una hoja leída como arreglo de arreglos (la primera es el encabezado). */
export function leerFilasDeLaPlanilla(hoja: unknown[][]): FilaImportacionEquipo[] {
  if (hoja.length === 0) return [];
  const encabezado = hoja[0].map(clave);
  const indice = {} as Record<Columna, number>;
  for (const col of Object.keys(NOMBRES) as Columna[]) {
    indice[col] = encabezado.findIndex((h) => NOMBRES[col].includes(h));
  }
  if (indice.placa < 0 || indice.tipo < 0) {
    throw new Error(
      `La primera fila debe tener los encabezados. Las columnas son: ${COLUMNAS_DE_LA_PLANILLA} (Placa y Tipo son obligatorias).`
    );
  }
  const celda = (fila: unknown[], col: Columna) => (indice[col] >= 0 ? fila[indice[col]] : "");
  const filas: FilaImportacionEquipo[] = [];
  hoja.slice(1).forEach((fila, i) => {
    if (fila.every((c) => texto(c) === "")) return; // fila vacía
    const numero = i + 2; // la fila del Excel (el encabezado es la 1)
    filas.push({
      placa_codigo: texto(celda(fila, "placa")),
      tipo: texto(celda(fila, "tipo")),
      marca: texto(celda(fila, "marca")),
      modelo: texto(celda(fila, "modelo")),
      medidor: medidorDe(celda(fila, "medidor"), numero),
      lectura: lecturaDe(celda(fila, "lectura"), numero),
      propiedad: propiedadDe(celda(fila, "propiedad"), numero),
      area: texto(celda(fila, "area")),
    });
  });
  return filas;
}

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

/** El mensaje de éxito: cuántos entraron y, si se crearon áreas nuevas, cuáles (por si es un error de tipeo). */
export function mensajeDeImportacion(cuerpo: Record<string, unknown>): string {
  const n = Number(cuerpo.importados ?? 0);
  const creadas = Array.isArray(cuerpo.areasCreadas) ? (cuerpo.areasCreadas as string[]) : [];
  const base =
    n === 1 ? "Se importó 1 equipo correctamente." : `Se importaron ${n} equipos correctamente.`;
  return creadas.length === 0
    ? base
    : `${base} Se crearon ${creadas.length === 1 ? "el área" : "las áreas"} ${creadas.join(", ")}: revísalas en «Áreas» por si hay un error de escritura.`;
}
