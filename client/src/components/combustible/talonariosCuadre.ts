// Cuadre del reporte de talonarios: lo que se despachó con vale contra lo que le falta al tanque
// en su última varilla. Sin React, para probarlo solo. Todo lo de los vales que faltan es una
// ESTIMACIÓN (promedio por vale × cantidad), nunca un dato registrado.
import { textoBaja, type SerieTalonario } from "./valesFaltantesLogica";

export interface FilaDeKardex {
  tipo: string;
  anulada: boolean;
  historico: boolean;
  ocurrido_en: string;
  nivel_medido: number | null;
  saldo_teorico: number | null;
}

export interface UltimaVarilla {
  ocurrido_en: string;
  medido: number;
  teorico: number;
}

/** La última varilla válida del kardex: ni anulada, ni anterior a la primera medición. */
export function ultimaVarilla(filas: FilaDeKardex[]): UltimaVarilla | null {
  let ultima: UltimaVarilla | null = null;
  for (const f of filas) {
    if (f.tipo !== "lectura" || f.anulada || f.historico) continue;
    if (f.nivel_medido === null || f.saldo_teorico === null) continue;
    if (ultima && new Date(f.ocurrido_en) < new Date(ultima.ocurrido_en)) continue;
    ultima = { ocurrido_en: f.ocurrido_en, medido: f.nivel_medido, teorico: f.saldo_teorico };
  }
  return ultima;
}

export interface Cuadre {
  /** Lo despachado con vale en el período (en la unidad del tanque). */
  despachado: number;
  usados: number;
  faltan: number;
  promedioPorVale: number;
  /** Lo que habrían despachado los vales que faltan, si fueran como el promedio. */
  estimadoFaltantes: number;
  /** Teórico − medido: positivo es combustible que no está en el tanque. */
  faltanteTanque: number;
  /** Lo que los vales que faltan NO alcanzan a explicar (nunca negativo). */
  sinExplicar: number;
  /** Cuántos vales más equivale lo que sigue sin explicar; null si no hay promedio. */
  valesSinExplicar: number | null;
}

export function calcularCuadre(
  series: SerieTalonario[],
  varilla: UltimaVarilla,
  unidad: "gal" | "L"
): Cuadre {
  const despachado = series.reduce((s, x) => s + (unidad === "gal" ? x.galones : x.litros), 0);
  const usados = series.reduce((s, x) => s + x.usados, 0);
  // Un vale dado de baja no despachó nada: solo los que siguen sin explicar entran en la estimación.
  const faltan = series.reduce((s, x) => s + x.sin_explicar, 0);
  const promedioPorVale = usados > 0 ? despachado / usados : 0;
  const estimadoFaltantes = faltan * promedioPorVale;
  const faltanteTanque = varilla.teorico - varilla.medido;
  const sinExplicar = Math.max(0, faltanteTanque - estimadoFaltantes);
  return {
    despachado,
    usados,
    faltan,
    promedioPorVale,
    estimadoFaltantes,
    faltanteTanque,
    sinExplicar,
    valesSinExplicar: promedioPorVale > 0 ? sinExplicar / promedioPorVale : null,
  };
}

/** Las dos hojas del Excel: las series y, aparte, cada tramo que falta con sus vales vecinos. */
export function hojasDelExcel(series: SerieTalonario[], formatearFecha: (iso: string) => string) {
  const filasSeries = series.map((s) => ({
    Serie: s.serie,
    Desde: s.minimo,
    Hasta: s.maximo,
    Usados: s.usados,
    Faltan: s.faltan,
    "Dados de baja": s.explicados,
    "Sin explicar": s.sin_explicar,
    Litros: s.litros,
    Galones: s.galones,
    "Último vale": s.ultimo_vale,
    "Fecha del último vale": formatearFecha(s.ultima_fecha),
  }));
  const vecino = (v: { registrado_por: string | null; despachado_en: string } | null) =>
    v ? `${v.registrado_por ?? "usuario borrado"}, ${formatearFecha(v.despachado_en)}` : "";
  const filasTramos = series.flatMap((s) =>
    s.tramos.map((t) => ({
      Serie: s.serie,
      Desde: t.desde,
      Hasta: t.hasta,
      Cantidad: t.cantidad,
      "Vale anterior": t.desde - 1,
      "Registrado el anterior": vecino(t.anterior),
      "Vale siguiente": t.hasta + 1,
      "Registrado el siguiente": vecino(t.siguiente),
      Baja: t.baja ? textoBaja(t.baja, formatearFecha) : "",
    }))
  );
  return { filasSeries, filasTramos };
}
