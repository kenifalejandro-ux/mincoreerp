// El cuadre de cada SALIDA de una tanqueta: del vale con que se entrega a una unidad hasta
// que vuelve. Es un cálculo sobre lo ya guardado (solo lectura): cuánto llevaba, cuánto
// cargó, cuánto debía volver, cuánto volvió. Aparte de la consulta para poder probarlo
// con datos armados a mano.

/** Una entrega a una unidad con su vale: la asignación desde la pestaña (o del retorno a otra
 *  unidad), el llenado de la tanqueta eligiendo la unidad, o la línea del reparto de un excedente. */
export interface SalidaBruta {
  fuente: "asignacion" | "llenado" | "excedente";
  inicio: Date;
  placa: string | null;
  serie: string;
  nVale: number;
  /** Lo que el vale dice que llevaba; null en las asignaciones anteriores a la 0142. */
  cantidad: number | null;
}

export interface RetornoBruto {
  creadoEn: Date;
  placa: string | null;
  calculado: number;
  validado: number;
  diferencia: number;
  motivo: string | null;
  destino: string;
}

export interface CargaBruta {
  en: Date;
  cantidad: number;
}

export interface SalidaCuadre {
  fuente: SalidaBruta["fuente"];
  vale: string;
  unidad: string | null;
  inicio: string;
  fin: string | null;
  /** abierta: sigue con la unidad · cerrada: volvió (hay retorno) · sin_retorno: se liberó o se
   *  entregó de nuevo sin registrar el retorno de esta salida. */
  estado: "abierta" | "cerrada" | "sin_retorno";
  salioCon: number | null;
  cargo: number;
  cargas: number;
  debiaVolver: number | null;
  volvio: number | null;
  diferencia: number | null;
  motivo: string | null;
  destinoDelRetorno: string | null;
  llevaAhora: number | null;
}

const redondear = (n: number) => Number(n.toFixed(2));

export function armarCuadre(
  salidas: SalidaBruta[],
  retornos: RetornoBruto[],
  cargas: CargaBruta[],
  ahora: { saldo: number; unidad: string | null }
): SalidaCuadre[] {
  const orden = [...salidas].sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  // Un retorno cierra la última salida que empezó ANTES que él. Estrictamente antes: el
  // retorno "a otra unidad" guarda la salida nueva en el mismo instante y esa es la que sigue.
  const retornoDe = new Map<number, RetornoBruto>();
  for (const r of [...retornos].sort((a, b) => a.creadoEn.getTime() - b.creadoEn.getTime())) {
    let idx = -1;
    orden.forEach((s, i) => {
      if (s.inicio.getTime() < r.creadoEn.getTime()) idx = i;
    });
    if (idx >= 0 && !retornoDe.has(idx)) retornoDe.set(idx, r);
  }
  const resultado = orden.map((s, i): SalidaCuadre => {
    const retorno = retornoDe.get(i);
    const fin = retorno?.creadoEn ?? orden[i + 1]?.inicio ?? null;
    const sus = cargas.filter(
      (c) =>
        c.en.getTime() >= s.inicio.getTime() && (fin === null || c.en.getTime() < fin.getTime())
    );
    const abierta = !retorno && i === orden.length - 1 && ahora.unidad !== null;
    return {
      fuente: s.fuente,
      vale: `${s.serie}-${s.nVale}`,
      unidad: s.placa ?? retorno?.placa ?? (abierta ? ahora.unidad : null),
      inicio: s.inicio.toISOString(),
      fin: fin ? fin.toISOString() : null,
      estado: retorno ? "cerrada" : abierta ? "abierta" : "sin_retorno",
      salioCon: s.cantidad,
      cargo: redondear(sus.reduce((a, c) => a + c.cantidad, 0)),
      cargas: sus.length,
      debiaVolver: retorno ? retorno.calculado : null,
      volvio: retorno ? retorno.validado : null,
      diferencia: retorno ? retorno.diferencia : null,
      motivo: retorno?.motivo ?? null,
      destinoDelRetorno: retorno?.destino ?? null,
      llevaAhora: abierta ? ahora.saldo : null,
    };
  });
  return resultado.reverse();
}
