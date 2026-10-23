// La lógica del recorrido de un viaje nuevo (sin pantalla): qué lugares son y si está completo.

export type TipoRecorrido = "solo_ida" | "ida_vuelta" | "varias";

export interface Recorrido {
  tipo: TipoRecorrido;
  /** Ids de lugar. Ida y vuelta guarda solo la salida y el destino: vuelve a la salida. */
  paradas: string[];
}

export const RECORRIDO_VACIO: Recorrido = { tipo: "solo_ida", paradas: ["", ""] };

/** Los lugares del recorrido, en orden. Ida y vuelta termina donde salió. */
export function paradasDelRecorrido(r: Recorrido): string[] {
  if (r.tipo === "ida_vuelta") return [r.paradas[0], r.paradas[1], r.paradas[0]];
  if (r.tipo === "solo_ida") return [r.paradas[0], r.paradas[1]];
  return r.paradas;
}

/** Qué falta o está mal del recorrido; null si está bien. */
export function errorDelRecorrido(r: Recorrido): string | null {
  const p = paradasDelRecorrido(r);
  if (p.some((x) => !x)) return "Falta elegir algún lugar del recorrido.";
  if (p.some((x, i) => i > 0 && x === p[i - 1])) {
    return "Dos paradas seguidas tienen que ser distintas.";
  }
  return null;
}
