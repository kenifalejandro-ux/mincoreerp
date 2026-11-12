// Reporte de talonarios (GET /despachos/talonarios): cálculo puro, sin base de
// datos. La consulta de huecos (findHuecosTalonario) da números sueltos; acá se
// juntan en tramos para que 23 vales faltantes se lean como 9 rangos.

/** Un vale vecino de un tramo: el último que se vio antes o el primero después. */
export interface ValeVecino {
  n: number;
  /** Nombre de quien lo registró; null si el usuario ya no existe. */
  registrado_por: string | null;
  despachado_en: string;
}

export interface TramoFaltante {
  desde: number;
  hasta: number;
  cantidad: number;
  /** El vale de justo antes y el de justo después, solo si son despachos: un vale
   *  vecino que vino de una asignación o de un excedente no tiene "quién". Es una
   *  pista de quién tenía el talonario, no una prueba de quién tenía el faltante. */
  anterior: ValeVecino | null;
  siguiente: ValeVecino | null;
}

/** Números consecutivos juntos: [1289, 1302, 1303, 1304] -> 1289 y 1302-1304.
 *  No exige que vengan ordenados ni sin repetir. */
export function agruparEnTramos(huecos: number[]): { desde: number; hasta: number }[] {
  const orden = [...new Set(huecos)].sort((a, b) => a - b);
  const tramos: { desde: number; hasta: number }[] = [];
  for (const n of orden) {
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && n === ultimo.hasta + 1) ultimo.hasta = n;
    else tramos.push({ desde: n, hasta: n });
  }
  return tramos;
}

/** Tramos con sus vecinos. `vecinos` se busca por número de vale. */
export function armarTramos(huecos: number[], vecinos: Map<number, ValeVecino>): TramoFaltante[] {
  return agruparEnTramos(huecos).map((t) => ({
    ...t,
    cantidad: t.hasta - t.desde + 1,
    anterior: vecinos.get(t.desde - 1) ?? null,
    siguiente: vecinos.get(t.hasta + 1) ?? null,
  }));
}

/** Los números de los vales vecinos que hay que ir a buscar. */
export function numerosVecinos(huecos: number[]): number[] {
  return [...new Set(agruparEnTramos(huecos).flatMap((t) => [t.desde - 1, t.hasta + 1]))];
}
