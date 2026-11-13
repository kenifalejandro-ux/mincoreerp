// Totales de la franja de arriba del reporte de Talonarios: cuántos vales se usaron, cuántos faltan,
// cuántos de los que faltan ya están regularizados y cuántos siguen sin explicar, más lo despachado.
// Sin React, para probarlo solo.
import type { SerieTalonario } from "./valesFaltantesLogica";

export interface ResumenTalonarios {
  usados: number;
  faltan: number;
  regularizados: number;
  sinExplicar: number;
  /** Todos los números del rango de las series: usados + los que faltan. */
  total: number;
  litros: number;
  galones: number;
  /** Porcentaje de vales con respaldo: usados más regularizados, sobre el total. */
  conRespaldoPct: number;
}

export function resumirTalonarios(series: SerieTalonario[]): ResumenTalonarios {
  const suma = (f: (s: SerieTalonario) => number) => series.reduce((acc, s) => acc + f(s), 0);
  const usados = suma((s) => s.usados);
  const faltan = suma((s) => s.faltan);
  const regularizados = suma((s) => s.explicados);
  const total = usados + faltan;
  return {
    usados,
    faltan,
    regularizados,
    sinExplicar: faltan - regularizados,
    total,
    litros: suma((s) => s.litros),
    galones: suma((s) => s.galones),
    conRespaldoPct: total > 0 ? Math.round((100 * (usados + regularizados)) / total) : 100,
  };
}

export type ClaveArco = "usados" | "regularizados" | "sinExplicar";

export interface Arco {
  clave: ClaveArco;
  /** Cuánto de la circunferencia ocupa. */
  largo: number;
  /** Dónde empieza, medido desde el arranque de la dona. */
  desfase: number;
}

/** Los tramos de la dona, uno detrás de otro; los que valen cero no se dibujan. */
export function arcosDeLaDona(
  r: Pick<ResumenTalonarios, "usados" | "regularizados" | "sinExplicar" | "total">,
  circunferencia: number
): Arco[] {
  if (r.total <= 0) return [];
  const partes: [ClaveArco, number][] = [
    ["usados", r.usados],
    ["regularizados", r.regularizados],
    ["sinExplicar", r.sinExplicar],
  ];
  let desfase = 0;
  const arcos: Arco[] = [];
  for (const [clave, valor] of partes) {
    if (valor <= 0) continue;
    const largo = (circunferencia * valor) / r.total;
    arcos.push({ clave, largo, desfase });
    desfase += largo;
  }
  return arcos;
}
