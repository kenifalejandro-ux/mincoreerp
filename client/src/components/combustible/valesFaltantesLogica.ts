// Aviso de vales faltantes del kardex: tipos de GET /despachos/talonarios y los
// textos que se arman a partir de ellos. Sin React, para poder probarlos solos.

export interface ValeVecino {
  n: number;
  registrado_por: string | null;
  despachado_en: string;
}

/** Una baja ya dada (0185): por qué esos vales no tienen movimiento, quién lo dijo y cuándo. */
export interface BajaDeVale {
  desde: number;
  hasta: number;
  motivo: string;
  detalle: string | null;
  dado_por: string | null;
  fecha: string;
}

export interface TramoFaltante {
  desde: number;
  hasta: number;
  cantidad: number;
  anterior: ValeVecino | null;
  siguiente: ValeVecino | null;
  /** La baja que cubre el tramo; null si sigue sin explicar. */
  baja: BajaDeVale | null;
}

export interface SerieTalonario {
  serie: string;
  minimo: number;
  maximo: number;
  usados: number;
  faltan: number;
  /** De los que faltan, cuántos tienen baja y cuántos siguen sin explicar. */
  explicados: number;
  sin_explicar: number;
  litros: number;
  galones: number;
  ultimo_vale: number;
  ultima_fecha: string;
  tramos: TramoFaltante[];
}

/** El vale como se lee en el papel y en el resto de la pantalla: SERIE-00123. */
export const valeTexto = (serie: string, n: number) => `${serie}-${String(n).padStart(5, "0")}`;

/** «01302 – 01304», o un solo número si el tramo es un vale. */
export const rangoTexto = (t: { desde: number; hasta: number }) =>
  t.desde === t.hasta
    ? String(t.desde).padStart(5, "0")
    : `${String(t.desde).padStart(5, "0")} – ${String(t.hasta).padStart(5, "0")}`;

export const totalFaltantes = (series: SerieTalonario[]) =>
  series.reduce((suma, s) => suma + s.faltan, 0);

/** Los que siguen sin explicación: lo que de verdad preocupa. */
export const totalSinExplicar = (series: SerieTalonario[]) =>
  series.reduce((suma, s) => suma + s.sin_explicar, 0);

/** Los motivos de una baja, en el orden en que se ofrecen. */
export const MOTIVOS_BAJA = [
  { valor: "roto", texto: "Vale roto" },
  { valor: "perdido", texto: "Vale perdido" },
  { valor: "mal_llenado", texto: "Mal llenado, se anuló" },
  { valor: "otro", texto: "Otro" },
] as const;

/** «Vale roto · se mojó · por Sigma, 11/11 9:52 a. m.» */
export function textoBaja(b: BajaDeVale, formatearFecha: (iso: string) => string) {
  const motivo = MOTIVOS_BAJA.find((m) => m.valor === b.motivo)?.texto ?? b.motivo;
  const detalle = b.detalle ? ` · ${b.detalle}` : "";
  return `${motivo}${detalle} · por ${b.dado_por ?? "un usuario ya borrado"}, ${formatearFecha(b.fecha)}`;
}

/** Solo las series con algo que mostrar. */
export const seriesConFaltantes = (series: SerieTalonario[]) => series.filter((s) => s.faltan > 0);

/** La línea «entre el vale X (registrado por …) y el vale Y (…)». Es una pista de
 *  quién tenía el talonario, no una prueba de quién tenía el vale que falta. */
export function textoVecinos(
  serie: string,
  t: TramoFaltante,
  formatearFecha: (iso: string) => string
) {
  const parte = (n: number, v: ValeVecino | null) =>
    v
      ? `${valeTexto(serie, n)} (registrado por ${v.registrado_por ?? "un usuario ya borrado"}, ${formatearFecha(v.despachado_en)})`
      : valeTexto(serie, n);
  return `Entre el ${parte(t.desde - 1, t.anterior)} y el ${parte(t.hasta + 1, t.siguiente)}`;
}

/** «12/11 8:59 a. m.», sin año: el período ya dice cuál es. */
export const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
