// Las horas de un viaje separadas por lo que fueron: manejando entre paradas y quieto en una
// parada (la estadía). Salen de las marcas que ya existen (llegada_en y salida_en de cada parada);
// no se guarda nada nuevo. Lógica sin pantalla.
import type { DescansoMio, ParadaMia } from "./paradasViaje";

const MIN = 60_000;

export interface HorasDelViaje {
  /** Minutos de cada tramo (parada i → i+1); null si todavía no salió de i. */
  tramos: (number | null)[];
  /** Minutos quieto en cada parada (la 0 y la última no tienen estadía); null si no llegó. */
  estadias: (number | null)[];
  /** Suma de los tramos: lo que estuvo en marcha o detenido en el camino. */
  enRuta: number;
  /** Suma de las estadías en paradas intermedias. */
  enParadas: number;
  /** De la primera salida a la última llegada (o a este momento si sigue en curso). */
  total: number;
  /** Ruta A → B → A: el tramo 0 es la ida y el 1 la vuelta, con la estadía en B. */
  idaYVuelta: boolean;
  ida: number | null;
  vuelta: number | null;
  estadia: number | null;
}

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Cuánto duró cada tramo y cada estadía. Null si el viaje todavía no salió del origen. Lo abierto
 *  (un tramo sin llegada, una estadía sin salida) cuenta hasta `ahora`. */
export function horasDelViaje(paradas: ParadaMia[], ahora: number): HorasDelViaje | null {
  const n = paradas.length;
  const salida0 = n >= 2 ? ms(paradas[0].salida_en) : null;
  if (salida0 === null) return null;

  const tramos: (number | null)[] = [];
  for (let i = 0; i < n - 1; i++) {
    const s = ms(paradas[i].salida_en);
    if (s === null) {
      tramos.push(null);
      continue;
    }
    const l = ms(paradas[i + 1].llegada_en);
    tramos.push(Math.max(0, ((l ?? ahora) - s) / MIN));
  }

  const estadias: (number | null)[] = paradas.map((p, i) => {
    if (i === 0 || i === n - 1) return null;
    const l = ms(p.llegada_en);
    if (l === null) return null;
    const s = ms(p.salida_en);
    // Sin salida y con la llegada siguiente ya marcada, la estadía quedó sin cerrar: no corre sola.
    const fin = s ?? (paradas[i + 1].llegada_en ? l : ahora);
    return Math.max(0, (fin - l) / MIN);
  });

  const suma = (v: (number | null)[]) => v.reduce<number>((a, x) => a + (x ?? 0), 0);
  const ultimaLlegada = ms(paradas[n - 1].llegada_en);
  const total = Math.max(0, ((ultimaLlegada ?? ahora) - salida0) / MIN);
  const idaYVuelta = n === 3 && paradas[2].lugar_id === paradas[0].lugar_id;

  return {
    tramos,
    estadias,
    enRuta: suma(tramos),
    enParadas: suma(estadias),
    total,
    idaYVuelta,
    ida: idaYVuelta ? tramos[0] : null,
    vuelta: idaYVuelta ? tramos[1] : null,
    estadia: idaYVuelta ? estadias[1] : null,
  };
}

/** Los minutos de descanso que detienen la unidad dentro de una ventana de tiempo (un tramo). El
 *  descanso abierto cuenta hasta `ahora`; el que se cruza con los bordes cuenta solo lo de adentro. */
export function descansoEnVentana(
  descansos: DescansoMio[] | null | undefined,
  desde: string | null,
  hasta: string | null,
  ahora: number
): number {
  const a = ms(desde);
  if (a === null) return 0;
  const b = ms(hasta) ?? ahora;
  let total = 0;
  for (const d of descansos ?? []) {
    if (d.detiene === false) continue;
    const ini = ms(d.inicio_en);
    if (ini === null) continue;
    const fin = ms(d.fin_en) ?? ahora;
    total += Math.max(0, Math.min(fin, b) - Math.max(ini, a)) / MIN;
  }
  return total;
}
