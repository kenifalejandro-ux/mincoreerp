// Las cuentas de los gráficos de la vista de una unidad (acumulado por origen, consumo por tramo,
// barras de desvío). Sin pantalla, para poder probarlas.
const LITROS_POR_GALON = 3.785411784;

export type OrigenCarga = "grifo" | "tanqueta" | "ruta";

export const ORIGENES: { k: OrigenCarga; t: string; c: string }[] = [
  { k: "grifo", t: "Grifo", c: "#BADC1E" },
  { k: "tanqueta", t: "Tanqueta", c: "#38bdf8" },
  { k: "ruta", t: "Compra en ruta", c: "#fbbf24" },
];

export interface CargaGrafica {
  producto: string;
  origen: string;
  despachado_en: string;
  cantidad: string | number;
  unidad: string;
}

/** De dónde vino la carga: la tanqueta, una compra en ruta, o (todo lo demás) el grifo/tanque propio. */
export function origenDe(origen: string): OrigenCarga {
  if (origen === "tanqueta") return "tanqueta";
  if (origen === "compra_externa") return "ruta";
  return "grifo";
}

export interface BarraAcumulada {
  k: OrigenCarga;
  gal: number;
  acumulado: number;
}

/** Los galones de combustible del viaje por origen, en el orden en que cada origen empezó a cargar,
 *  con lo acumulado hasta ahí. Los orígenes sin galones no aparecen. */
export function acumuladoPorOrigen(cargas: CargaGrafica[]): BarraAcumulada[] {
  const por = new Map<OrigenCarga, { gal: number; primera: number }>();
  for (const c of cargas) {
    if (c.producto !== "combustible") continue;
    const gal = Number(c.cantidad) * (c.unidad === "L" ? 1 / LITROS_POR_GALON : 1);
    if (!Number.isFinite(gal) || gal <= 0) continue;
    const k = origenDe(c.origen);
    const t = Date.parse(c.despachado_en) || 0;
    const previo = por.get(k);
    por.set(k, { gal: (previo?.gal ?? 0) + gal, primera: Math.min(previo?.primera ?? t, t) });
  }
  let acumulado = 0;
  return [...por.entries()]
    .sort((a, b) => a[1].primera - b[1].primera)
    .map(([k, v]) => ({ k, gal: v.gal, acumulado: (acumulado += v.gal) }));
}

/** Un tope «redondo» para el eje (que se parte en cuartos) y las marcas del eje. */
export function escalaY(max: number): { tope: number; marcas: number[] } {
  const m = Number.isFinite(max) && max > 0 ? max : 4;
  const pot = 10 ** Math.floor(Math.log10(m));
  const tope = ([1, 2, 4, 10].map((x) => x * pot).find((x) => x >= m) ?? 10 * pot) as number;
  return { tope, marcas: [0, 0.25, 0.5, 0.75, 1].map((f) => f * tope) };
}

/** Qué tan alta es la barra, de 0 a 100 %. */
export const alturaPct = (valor: number, tope: number) =>
  tope > 0 ? Math.max(0, Math.min(100, (valor / tope) * 100)) : 0;

/** Una barra que sale del centro: a la derecha si sube (malo), a la izquierda si baja. El ancho es la
 *  fracción de la mitad de la pista; pasado el tope (±50 %) la barra llena su mitad y no se sale. */
export function barraDivergente(pct: number, tope = 50): { derecha: boolean; ancho: number } {
  return { derecha: pct > 0, ancho: Math.min(Math.abs(pct), tope) / tope };
}

/** El texto de un desvío sin cifras absurdas: «+22 %», «−15 %», o «> 999 %». */
export function textoDesvio(pct: number): string {
  if (Math.abs(pct) > 999) return pct > 0 ? "> 999 %" : "< −999 %";
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(Math.round(pct))} %`;
}
