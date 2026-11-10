// La lógica pura del Control TV: en qué estado está cada unidad, dónde se dibuja en la vista en vivo
// y las cuentas de las tarjetas. Sin pantalla.
import { detencionDe } from "../combustible/motivosDescanso";
import { descansoAbierto, paradasDelViaje, posicion } from "../combustible/paradasViaje";
import type { FilaViaje } from "../combustible/viajesFormato";

export type CatTv = "ruta" | "retorno" | "parada" | "descansa" | "detenida";

export const CATS: { k: CatTv; t: string; c: string }[] = [
  { k: "ruta", t: "En ruta", c: "#38bdf8" },
  { k: "retorno", t: "Retornando", c: "#2dd4bf" },
  { k: "parada", t: "En parada", c: "#a78bfa" },
  { k: "descansa", t: "Descansando", c: "#fbbf24" },
  { k: "detenida", t: "Detenidas", c: "#f87171" },
];

/** El estado de una unidad en curso: detenida (avería, accidente...), descansando, en parada,
 *  retornando (rumbo al punto de salida) o en ruta. */
export function categoriaDe(v: FilaViaje): CatTv {
  const abierto = descansoAbierto(v.descansos?.filter((d) => d.detiene !== false));
  if (abierto) return detencionDe(abierto.motivo) ? "detenida" : "descansa";
  const p = paradasDelViaje(v);
  const pos = posicion(p);
  if (pos.tipo === "en_parada") return "parada";
  if (pos.tipo === "en_marcha" && pos.hacia > 1 && pos.hacia === p.length - 1) {
    return p[pos.hacia].lugar_id === p[0].lugar_id ? "retorno" : "ruta";
  }
  return "ruta";
}

/** Dónde se dibuja la unidad de salida (0) a regreso (1): en la parada donde está, o a mitad del
 *  tramo si va en camino (sin GPS no se sabe más; con GPS será el mapa real). */
export function posicionEnRuta(v: FilaViaje): number {
  const p = paradasDelViaje(v);
  const n = p.length;
  const pos = posicion(p);
  if (pos.tipo === "en_parada") return pos.en / (n - 1);
  if (pos.tipo === "en_marcha") return (pos.hacia - 0.5) / (n - 1);
  if (pos.tipo === "terminado") return 1;
  return 0;
}

/** El porcentaje de la flota que está operando (en ruta, retornando o en parada). */
export function porcentajeOperativas(f: {
  activos: number;
  en_ruta: number;
  retornando: number;
  en_parada: number;
}): number {
  return f.activos > 0
    ? Math.round(((f.en_ruta + f.retornando + f.en_parada) / f.activos) * 100)
    : 0;
}

/** Los días que alcanza el combustible al ritmo del período; null sin consumo. */
export function autonomiaDias(totalGal: number, consumoGal: number, periodo: "24h" | "7d" | "30d") {
  const dias = periodo === "24h" ? 1 : periodo === "7d" ? 7 : 30;
  return consumoGal > 0 ? Math.round((totalGal / (consumoGal / dias)) * 10) / 10 : null;
}

/** El valor del combustible de los tanques: nivel por costo promedio (en la unidad de cada tanque). */
export function valorEnTanques(
  tanques: { nivel: number | string | null; costo_promedio: number | null }[]
): number {
  return tanques.reduce((s, t) => s + Number(t.nivel ?? 0) * (t.costo_promedio ?? 0), 0);
}

/** Los puntos de una mini tendencia (polilínea SVG) dentro de un recuadro. */
export function puntosTendencia(vals: number[], ancho: number, alto: number): string {
  if (vals.length < 2) return "";
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const dy = max - min || 1;
  return vals
    .map(
      (v, i) =>
        `${((i / (vals.length - 1)) * (ancho - 4) + 2).toFixed(1)},${(alto - 4 - ((v - min) / dy) * (alto - 8)).toFixed(1)}`
    )
    .join(" ");
}
