// Las paradas de un viaje vistas desde el celular del conductor (0148): en qué punto va,
// cuál es su próxima marca y cómo queda el viaje mientras esa marca espera señal. Lógica
// sin pantalla; el servidor valida lo mismo (viajes.service.ts).

export interface ParadaMia {
  orden: number;
  lugar_id: number;
  lugar: string;
  llegada_en: string | null;
  llegada_medidor: string | number | null;
  salida_en: string | null;
  salida_medidor: string | number | null;
}

export type Posicion =
  | { tipo: "sin_salir" }
  | { tipo: "en_marcha"; hacia: number }
  | { tipo: "en_parada"; en: number }
  | { tipo: "terminado" };

/** En qué punto del recorrido va el viaje, según las marcas de sus paradas. */
export function posicion(p: ParadaMia[]): Posicion {
  for (let i = 0; i < p.length - 1; i++) {
    if (!p[i].salida_en) return i === 0 ? { tipo: "sin_salir" } : { tipo: "en_parada", en: i };
    if (!p[i + 1].llegada_en) return { tipo: "en_marcha", hacia: i + 1 };
  }
  return { tipo: "terminado" };
}

export interface ProximaMarca {
  accion: "llegada-mia" | "salida-mia";
  /** La parada a la que llega o de la que sale: el servidor rechaza la marca si ya no vale. */
  orden: number;
  texto: string;
  /** Llegar a la última parada cierra el viaje. */
  cierra: boolean;
  /** La última lectura del viaje: la nueva no puede ser menor. */
  minimo: number | null;
}

const numeroONull = (x: string | number | null): number | null => (x == null ? null : Number(x));

/** Lo que sigue en el recorrido, o null si el viaje todavía no salió o ya terminó. */
export function proximaMarca(p: ParadaMia[]): ProximaMarca | null {
  const pos = posicion(p);
  if (pos.tipo === "en_marcha") {
    const cierra = pos.hacia === p.length - 1;
    const lugar = p[pos.hacia].lugar;
    return {
      accion: "llegada-mia",
      orden: pos.hacia,
      texto: cierra ? `Llegué a ${lugar} · terminar viaje` : `Llegué a ${lugar}`,
      cierra,
      minimo: numeroONull(p[pos.hacia - 1].salida_medidor),
    };
  }
  if (pos.tipo === "en_parada") {
    return {
      accion: "salida-mia",
      orden: pos.en,
      texto: `Salir hacia ${p[pos.en + 1].lugar}`,
      cierra: false,
      minimo: numeroONull(p[pos.en].llegada_medidor),
    };
  }
  return null;
}

/** Las paradas con la marca ya puesta, para mostrarla aunque todavía no haya señal. */
export function conMarcaLocal(
  p: ParadaMia[],
  m: ProximaMarca,
  marcadoEn: string,
  lectura: number | null
): ParadaMia[] {
  const medidor = lectura === null ? null : String(lectura);
  return p.map((x) => {
    if (x.orden !== m.orden) return x;
    return m.accion === "llegada-mia"
      ? { ...x, llegada_en: marcadoEn, llegada_medidor: medidor }
      : { ...x, salida_en: marcadoEn, salida_medidor: medidor };
  });
}

/** Cuántas marcas tiene el viaje: sirve para saber qué versión va más adelantada. */
export const marcasHechas = (p: ParadaMia[]): number =>
  p.reduce((n, x) => n + (x.llegada_en ? 1 : 0) + (x.salida_en ? 1 : 0), 0);

interface ViajeConRuta {
  paradas?: ParadaMia[] | null;
  origen_id: string;
  origen: string;
  destino_id: string;
  destino: string;
  inicio_en: string | null;
  fin_en: string | null;
  medidor_inicio: string | null;
  medidor_fin: string | null;
}

/** Las paradas del viaje; si la lista guardada en el celular es de antes de las paradas
 *  (origen → destino), se arman las dos de la ida. */
export function paradasDelViaje(v: ViajeConRuta): ParadaMia[] {
  if (v.paradas && v.paradas.length >= 2) return v.paradas;
  return [
    {
      orden: 0,
      lugar_id: Number(v.origen_id),
      lugar: v.origen,
      llegada_en: null,
      llegada_medidor: null,
      salida_en: v.inicio_en,
      salida_medidor: v.medidor_inicio,
    },
    {
      orden: 1,
      lugar_id: Number(v.destino_id),
      lugar: v.destino,
      llegada_en: v.fin_en,
      llegada_medidor: v.medidor_fin,
      salida_en: null,
      salida_medidor: null,
    },
  ];
}
