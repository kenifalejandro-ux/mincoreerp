// La lógica de las ubicaciones de un viaje (0182) para la oficina: qué se manda, qué se rechaza antes
// de mandar y cómo se lee «hace 2 h». Pura, sin pantalla: se prueba sola.
import type { Lugar } from "./empezarViaje";
import type { ParadaMia } from "./paradasViaje";
import { deValorLocal } from "./ponerAlDiaLogica";
import { duracion } from "./viajesFormato";

/** Un punto del historial: la oficina lo anotó, o nació de un descanso con «¿Dónde?». */
export interface UbicacionViaje {
  id: number;
  lugar_id: number | null;
  texto: string;
  nota: string | null;
  registrado_en: string;
  origen: "oficina" | "descanso";
}

/** Lo mismo que tolera el servidor entre el reloj de la PC y el suyo. */
const MARGEN_RELOJ_MS = 5 * 60 * 1000;

const alMinuto = (ms: number) => Math.floor(ms / 60_000) * 60_000;

/** Por qué todavía no se puede registrar, o null si está lista. */
export function errorDeUbicacion(e: {
  lugar: Lugar;
  horaLocal: string;
  inicioViaje: string | null;
  ahora: number;
}): string | null {
  const nombre = typeof e.lugar === "string" ? e.lugar.trim() : e.lugar;
  if (nombre === null || nombre === "") return "Elige un lugar o escribe dónde está.";
  if (typeof nombre === "string" && nombre.length > 160) return "Escribe menos: máximo 160 letras.";
  const hora = deValorLocal(e.horaLocal);
  if (hora === null) return "Pon la fecha y la hora.";
  if (hora > e.ahora + MARGEN_RELOJ_MS) return "La hora no puede ser futura.";
  // El campo de hora llega al minuto: la salida de las 10:00:40 se compara como 10:00, y una hora de
  // ese mismo minuto es válida (al mandarla se ajusta a la salida, ver `cuerpoDeUbicacion`).
  const inicio = e.inicioViaje ? alMinuto(Date.parse(e.inicioViaje)) : null;
  if (inicio !== null && hora < inicio)
    return "La hora tiene que ser posterior a la salida del viaje.";
  return null;
}

/** El cuerpo del POST: un lugar del catálogo va por su id; lo escrito, como texto libre. */
export function cuerpoDeUbicacion(e: {
  lugar: Lugar;
  horaLocal: string;
  nota: string;
  clienteUuid: string;
  inicioViaje?: string | null;
}) {
  let hora = deValorLocal(e.horaLocal) as number;
  // «Ahora» en el primer minuto del viaje queda unos segundos antes de la salida (el campo corta al
  // minuto): se manda la hora de la salida, que es lo más cercano que el servidor acepta.
  const inicio = e.inicioViaje ? Date.parse(e.inicioViaje) : null;
  if (inicio !== null && hora < inicio && hora >= alMinuto(inicio)) hora = inicio;
  const nota = e.nota.trim();
  return {
    ...(typeof e.lugar === "number" ? { lugar_id: e.lugar } : { texto: String(e.lugar).trim() }),
    registrado_en: new Date(hora).toISOString(),
    ...(nota ? { nota } : {}),
    cliente_uuid: e.clienteUuid,
  };
}

/** «hace 2 h» para la última ubicación; menos de un minuto es «ahora». */
export function haceCuanto(iso: string, ahora: number): string {
  const min = (ahora - Date.parse(iso)) / 60_000;
  return min < 1 ? "ahora" : `hace ${duracion(min)}`;
}

/** Los lugares activos del catálogo, listos para el selector. La API manda el id como texto
 *  ("3782", viene de un BIGINT): se pasa a número, porque el selector distingue un lugar del
 *  catálogo (número) de un texto libre (texto). */
export function lugaresDelCatalogo(datos: unknown): { id: number; nombre: string }[] {
  if (!Array.isArray(datos)) return [];
  return (datos as { id: number | string; nombre: string; activo?: boolean }[])
    .filter((l) => l.activo !== false)
    .map((l) => ({ id: Number(l.id), nombre: l.nombre }));
}

export interface UbicacionVigente {
  texto: string;
  en: string;
  /** De dónde sale: la llegada a una parada, la salida de una parada o un punto anotado. */
  origen: "llegada" | "salida" | "punto";
}

/** Dónde está el viaje. Si la última marca del recorrido es una llegada, la unidad está en esa
 *  parada y manda la llegada: ningún punto de ubicación la pisa. Si salió (o aún no hay marcas), vale
 *  el último punto anotado, siempre que sea posterior a la salida; si no, «Salió de X». */
export function ubicacionVigente(
  paradas: ParadaMia[] | null | undefined,
  ultima: UbicacionViaje | null | undefined
): UbicacionVigente | null {
  let marca: { texto: string; en: string; t: number; origen: "llegada" | "salida" } | null = null;
  for (const p of paradas ?? []) {
    for (const [iso, origen, texto] of [
      [p.llegada_en, "llegada", `En ${p.lugar}`],
      [p.salida_en, "salida", `Salió de ${p.lugar}`],
    ] as const) {
      const t = iso ? Date.parse(iso) : NaN;
      if (!Number.isNaN(t) && (!marca || t > marca.t)) {
        marca = { texto, en: iso as string, t, origen };
      }
    }
  }
  if (marca?.origen === "llegada") return { texto: marca.texto, en: marca.en, origen: "llegada" };
  const punto: UbicacionVigente | null = ultima
    ? { texto: ultima.texto, en: ultima.registrado_en, origen: "punto" }
    : null;
  if (marca && (!punto || marca.t >= Date.parse(punto.en))) {
    return { texto: marca.texto, en: marca.en, origen: "salida" };
  }
  return punto;
}
