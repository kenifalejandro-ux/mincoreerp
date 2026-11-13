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

/** Una regularización ya guardada (tabla de bajas), con quién la dio. */
export interface BajaDeVale {
  desde: number;
  hasta: number;
  motivo: string;
  detalle: string | null;
  /** Nombre de quien la dio; null si el usuario ya no existe. */
  dado_por: string | null;
  fecha: string;
}

/** Un vale que falta, con su regularización si ya la tiene. */
export interface ValeFaltante {
  n: number;
  baja: BajaDeVale | null;
}

/** Un tramo con cada uno de sus vales y cuántos están regularizados. */
export type TramoConVales = TramoFaltante & {
  vales: ValeFaltante[];
  explicados: number;
  sin_explicar: number;
};

/** Abre cada tramo en sus vales y marca los que tienen regularización. Si un vale tiene dos,
 *  queda la más reciente. */
export function detallarVales(tramos: TramoFaltante[], bajas: BajaDeVale[]): TramoConVales[] {
  const recientes = [...bajas].sort((a, b) => b.fecha.localeCompare(a.fecha));
  return tramos.map((t) => {
    const vales: ValeFaltante[] = [];
    for (let n = t.desde; n <= t.hasta; n++) {
      vales.push({ n, baja: recientes.find((b) => b.desde <= n && b.hasta >= n) ?? null });
    }
    const explicados = vales.filter((v) => v.baja).length;
    return { ...t, vales, explicados, sin_explicar: vales.length - explicados };
  });
}

/** Los números de la lista que ya están dentro de una regularización anterior. */
export function yaRegularizados(numeros: number[], bajas: { desde: number; hasta: number }[]) {
  return numeros.filter((n) => bajas.some((b) => b.desde <= n && b.hasta >= n));
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
