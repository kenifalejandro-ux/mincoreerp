import { ETIQUETA_TIPO_ALERTA } from "../combustible/alertasTexto";

// Las cuentas del Resumen corporativo del Control TV (medidor, barras de progreso, histograma, desvíos).
// Sin pantalla, para poder probarlas.

/** Media móvil de n puntos (la línea de tendencia sobre las barras de consumo). */
export function tendenciaMovil(datos: number[], n = 3): number[] {
  return datos.map((_, i) => {
    // Centrada en el punto; en los bordes usa los vecinos que hay.
    const mitad = Math.floor(n / 2);
    const tramo = datos.slice(Math.max(0, i - mitad), Math.min(datos.length, i + mitad + 1));
    return tramo.reduce((s, x) => s + x, 0) / tramo.length;
  });
}

export interface ClaseHistograma {
  desde: number;
  hasta: number;
  n: number;
}

/** Reparte las duraciones (horas) en hasta `clases` rangos del mismo ancho. Null si no hay viajes. */
export function histograma(
  horas: number[],
  clases = 7
): { bins: ClaseHistograma[]; promedio: number } | null {
  const v = horas.filter((h) => Number.isFinite(h) && h >= 0);
  if (v.length === 0) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const ancho = Math.max(1, Math.ceil((max - min + 0.001) / clases));
  const inicio = Math.floor(min / ancho) * ancho;
  const cuantas = Math.max(1, Math.ceil((max - inicio + 0.001) / ancho));
  const bins: ClaseHistograma[] = Array.from({ length: cuantas }, (_, i) => ({
    desde: inicio + i * ancho,
    hasta: inicio + (i + 1) * ancho,
    n: 0,
  }));
  for (const h of v) bins[Math.min(cuantas - 1, Math.floor((h - inicio) / ancho))].n += 1;
  return { bins, promedio: v.reduce((s, x) => s + x, 0) / v.length };
}

export interface DesvioTv {
  placa: string;
  vs_pares_pct: number | null;
  vs_pasado_pct: number | null;
}

/** Las unidades que más se apartan de lo normal: el mayor desvío contra pares o contra su pasado. */
export function topDesvios(desvios: DesvioTv[], n = 5): { placa: string; pct: number }[] {
  return desvios
    .map((d) => {
      const a = d.vs_pares_pct;
      const b = d.vs_pasado_pct;
      const pct = Math.abs(a ?? 0) >= Math.abs(b ?? 0) ? (a ?? b ?? 0) : (b ?? 0);
      return { placa: d.placa, pct };
    })
    .sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct))
    .slice(0, n);
}

/** El color de un desvío: sobre el promedio es alerta; por debajo, bien. */
export function colorDesvio(pct: number): string {
  if (pct >= 30) return "#f87171";
  if (pct >= 15) return "#fb923c";
  if (pct > 5) return "#fbbf24";
  return "#a3c93a";
}

/** Las zonas de la barra de autonomía sobre una escala de 10 días: roja menos de 3, ámbar de 3 a 6. */
export const ESCALA_AUTONOMIA_DIAS = 10;
export const ZONAS_AUTONOMIA: [number, string][] = [
  [0.3, "#f87171"],
  [0.6, "#fbbf24"],
  [1, "#34d399"],
];

/** Lo mínimo que tiene que durar la referencia para comparar contra ella: una de 12 minutos contra un
 *  viaje de 31 horas daría «+15,568 %», que no dice nada. */
export const MINIMO_REFERENCIA_MIN = 30;
/** Pasado este porcentaje se dice «muy por encima» en vez de dar el número. */
export const TOPE_PORCENTAJE = 300;

export interface ComparacionConNormal {
  /** Porcentaje sobre lo normal; null si no hay referencia o es absurdo. */
  pct: number | null;
  /** No hay referencia confiable (falta o es menor al mínimo). */
  sinReferencia: boolean;
  /** Se pasa del tope: se avisa sin dar la cifra. */
  muyPorEncima: boolean;
}

/** Cuánto se aparta lo real de lo normal. Sin referencia confiable no se compara. */
export function compararConNormal(
  real: number | null,
  normal: number | null
): ComparacionConNormal {
  if (
    real === null ||
    normal === null ||
    !Number.isFinite(normal) ||
    normal < MINIMO_REFERENCIA_MIN
  ) {
    return { pct: null, sinReferencia: true, muyPorEncima: false };
  }
  const pct = ((real - normal) / normal) * 100;
  if (pct > TOPE_PORCENTAJE) return { pct: null, sinReferencia: false, muyPorEncima: true };
  return { pct, sinReferencia: false, muyPorEncima: false };
}

/** El nombre de una alerta en español: el catálogo del módulo; si es nueva y no está, se lee el código. */
export const nombreAlerta = (tipo: string) =>
  (ETIQUETA_TIPO_ALERTA as Record<string, string>)[tipo] ??
  tipo.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
