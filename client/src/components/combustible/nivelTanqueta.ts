// Cuánto se dibuja del cilindro de "Mi tanqueta" y de qué color. Aparte del componente para
// poder probarlo con números sueltos.
//
// El saldo puede ser NEGATIVO (el sobregiro se acepta a propósito: los galones en ruta son
// estimados) y `libre` puede dar más que la capacidad (300 sobre 280). El cilindro nunca se
// sale del vidrio, pero el número que se muestra es el real.

/** Cuánto del vidrio se llena: entre 0 y 100, aunque el saldo sea negativo o pase la capacidad. */
export function porcentajeDelNivel(saldo: number, capacidad: number): number {
  if (!Number.isFinite(saldo) || !Number.isFinite(capacidad) || capacidad <= 0) return 0;
  return Math.min(100, Math.max(0, (saldo / capacidad) * 100));
}

/** Lo que queda de espacio, sin pasarse de la capacidad ni bajar de cero. */
export function espacioLibre(libre: number, capacidad: number): number {
  if (!Number.isFinite(libre) || !Number.isFinite(capacidad)) return 0;
  return Math.min(Math.max(0, capacidad), Math.max(0, libre));
}

/** [base, claro (reflejo), oscuro (bordes), resplandor]. La tanqueta no tiene umbral mínimo:
 *  verde desde 40 %, ámbar entre 15 % y 40 %, rojo por debajo (o con saldo negativo). */
export function coloresDelNivel(
  saldo: number,
  pct: number
): [base: string, claro: string, oscuro: string, brillo: string] {
  if (saldo <= 0 || pct < 15) return ["#ef4444", "#fca5a5", "#7f1d1d", "rgba(239,68,68,0.4)"];
  if (pct < 40) return ["#f59e0b", "#fde68a", "#78350f", "rgba(245,158,11,0.4)"];
  return ["#a3e635", "#ecfccb", "#3f6212", "rgba(163,230,53,0.45)"];
}
