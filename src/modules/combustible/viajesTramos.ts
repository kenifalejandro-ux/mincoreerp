// El consumo de cada tramo de un viaje (0148). Lógica pura, sin base de datos: las cargas del
// viaje se derivan por hora (ver la migración 0123), así que repartirlas entre tramos es una
// cuenta sobre las horas de cada llegada.
import { LITROS_POR_GALON } from "../../server/shared/utils/unidades";

export interface ParadaDeTramo {
  orden: number;
  lugar: string;
  llegada_en: string | Date | null;
  llegada_medidor: string | number | null;
  salida_en: string | Date | null;
  salida_medidor: string | number | null;
}

export interface CargaDeTramo {
  despachado_en: string | Date;
  producto: "combustible" | "urea";
  litros: string | number;
}

export interface Tramo {
  orden: number;
  de: string;
  a: string;
  salida_en: string | Date | null;
  llegada_en: string | Date | null;
  /** Lo que recorrió, si se leyó el medidor al salir y al llegar. */
  recorrido: number | null;
  combustible_gal: number;
  urea_l: number;
}

const hora = (t: string | Date) => new Date(t).getTime();
const numero = (x: string | number | null) => (x === null ? null : Number(x));

/** Una carga cuenta para el tramo que termina después de ella: la tanqueada antes de salir y
 *  la que se hace en una parada entran al tramo que sigue; las de un tramo sin terminar, a ese. */
export function repartirPorTramo(paradas: ParadaDeTramo[], cargas: CargaDeTramo[]): Tramo[] {
  const tramos: Tramo[] = paradas.slice(0, -1).map((p, i) => {
    const sig = paradas[i + 1];
    const salida = numero(p.salida_medidor);
    const llegada = numero(sig.llegada_medidor);
    return {
      orden: i,
      de: p.lugar,
      a: sig.lugar,
      salida_en: p.salida_en,
      llegada_en: sig.llegada_en,
      recorrido: salida !== null && llegada !== null ? llegada - salida : null,
      combustible_gal: 0,
      urea_l: 0,
    };
  });
  for (const c of cargas) {
    const t = tramos.find(
      (x) => x.llegada_en === null || hora(c.despachado_en) <= hora(x.llegada_en)
    );
    if (!t) continue;
    const litros = Number(c.litros);
    if (c.producto === "urea") t.urea_l += litros;
    else t.combustible_gal += litros / LITROS_POR_GALON;
  }
  return tramos;
}
