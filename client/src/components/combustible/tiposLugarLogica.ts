// Los tipos de lugar (Viajes › Lugares): el tipo es opcional y libre. Hay tres de siempre (mina, ciudad,
// abastecimiento) con su ícono y la persona puede escribir otro («Planta», «Puerto»). Sin pantalla, para
// poder probarlo.

export const TIPOS_FIJOS: { valor: string; etiqueta: string }[] = [
  { valor: "mina", etiqueta: "Mina" },
  { valor: "ciudad", etiqueta: "Ciudad" },
  { valor: "abastecimiento", etiqueta: "Abastecimiento" },
];

/** Cómo se guarda un tipo: sin espacios de más y en minúsculas, así «Mina», «mina» y « mina  » son el mismo. */
export const normalizarTipo = (t: string | null | undefined): string =>
  (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** El nombre que se ve: el de los tres de siempre, o el tipo escrito con su primera letra en mayúscula. */
export function etiquetaDeTipo(t: string | null | undefined): string {
  const n = normalizarTipo(t);
  if (!n) return "";
  const fijo = TIPOS_FIJOS.find((x) => x.valor === n);
  return fijo ? fijo.etiqueta : n.charAt(0).toUpperCase() + n.slice(1);
}

/** Lo que ofrece la lista al escribir: los tres de siempre y los que ya usan los lugares, sin repetir, y
 *  filtrados por lo escrito (sin importar mayúsculas ni tildes). */
export function opcionesDeTipo(
  lugares: { tipo: string | null }[],
  escrito: string
): { valor: string; etiqueta: string }[] {
  const vistos = new Set(TIPOS_FIJOS.map((x) => x.valor));
  const propios: { valor: string; etiqueta: string }[] = [];
  for (const l of lugares) {
    const n = normalizarTipo(l.tipo);
    if (!n || vistos.has(n)) continue;
    vistos.add(n);
    propios.push({ valor: n, etiqueta: etiquetaDeTipo(n) });
  }
  const clave = sinTildes(normalizarTipo(escrito));
  return [...TIPOS_FIJOS, ...propios].filter((o) => !clave || sinTildes(o.valor).includes(clave));
}
