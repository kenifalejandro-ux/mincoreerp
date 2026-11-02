// Lo que devuelve GET /tanquetas/:id/kardex y su lectura segura. Aparte del componente para poder
// probarlo, y porque lo que se pinta puede venir de un caché viejo o roto (sin señal) o de un
// servidor con otra forma: eso no debe tumbar la pantalla.

export interface FilaKardex {
  clave: string;
  fecha: string;
  /** Un tipo que el servidor agregue después de este cliente se muestra como "Movimiento". */
  tipo: string;
  referencia: string | null;
  vale: string | null;
  unidad: string | null;
  conductor: string | null;
  cantidad: number | null;
  entra: number;
  sale: number;
  /** El saldo de la tanqueta justo después de esta fila, con todo el historial. */
  saldo: number;
  anulada: boolean;
  /** Solo en una asignación: lo que la tanqueta llevaba al salir con ese vale. */
  lleva: number | null;
}

/** El cierre de una salida de la tanqueta: del vale a la unidad hasta que volvió al grifero. */
export interface CierreDeSalida {
  vale: string;
  unidad: string | null;
  inicio: string;
  fin: string | null;
  /** abierta: sigue con la unidad · cerrada: volvió · sin_retorno: se entregó de nuevo sin retorno. */
  estado: string;
  salioCon: number | null;
  cargo: number;
  cargas: number;
  volvio: number | null;
  diferencia: number | null;
  /** Lo que escribió el grifero al corregir el saldo. */
  motivo: string | null;
  /** pozo, tanqueta o reserva: nunca el nombre de nadie. */
  destinoDelRetorno: string | null;
  /** Lo que le entró a la tanqueta después de salir (un llenado, un excedente). */
  entroDespues: number;
}

/** Una tanqueta que fue de su unidad y ya no, con el cierre de cada salida. */
export interface TanquetaCerrada {
  id: number;
  codigo: string;
  salidas: CierreDeSalida[];
}

export interface KardexDeTanqueta {
  filas: FilaKardex[];
  /** Las salidas que fueron de su unidad, con su cierre. */
  salidas: CierreDeSalida[];
  total: number;
  truncado: boolean;
  unidades: string[];
  conductores: string[];
  desdeSalidaActual: string | null;
  saldoFinal: number;
  cuadra: boolean;
}

/** Lo máximo que el servidor manda; el cliente no pinta más aunque llegue más. */
const MAX_FILAS = 500;

const numero = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const textoONulo = (v: unknown) => typeof v === "string" || v === null;
const numeroONulo = (v: unknown) => v === null || numero(v);
const textos = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function esFilaValida(f: unknown): f is FilaKardex {
  if (typeof f !== "object" || f === null) return false;
  const x = f as Record<string, unknown>;
  return (
    typeof x.clave === "string" &&
    typeof x.fecha === "string" &&
    !Number.isNaN(Date.parse(x.fecha)) &&
    typeof x.tipo === "string" &&
    textoONulo(x.referencia) &&
    textoONulo(x.vale) &&
    textoONulo(x.unidad) &&
    textoONulo(x.conductor) &&
    numeroONulo(x.cantidad) &&
    numero(x.entra) &&
    numero(x.sale) &&
    numero(x.saldo) &&
    typeof x.anulada === "boolean" &&
    numeroONulo(x.lleva)
  );
}

function leerCierre(c: unknown): CierreDeSalida | null {
  if (typeof c !== "object" || c === null) return null;
  const x = c as Record<string, unknown>;
  if (
    typeof x.vale !== "string" ||
    typeof x.inicio !== "string" ||
    Number.isNaN(Date.parse(x.inicio)) ||
    typeof x.estado !== "string" ||
    !numero(x.cargo) ||
    !numero(x.cargas) ||
    !textoONulo(x.unidad) ||
    !textoONulo(x.fin) ||
    !numeroONulo(x.salioCon) ||
    !numeroONulo(x.volvio) ||
    !numeroONulo(x.diferencia) ||
    !textoONulo(x.motivo) ||
    !textoONulo(x.destinoDelRetorno)
  ) {
    return null;
  }
  return {
    vale: x.vale,
    unidad: x.unidad as string | null,
    inicio: x.inicio,
    fin: x.fin as string | null,
    estado: x.estado,
    salioCon: x.salioCon as number | null,
    cargo: x.cargo as number,
    cargas: x.cargas as number,
    volvio: x.volvio as number | null,
    diferencia: x.diferencia as number | null,
    motivo: x.motivo as string | null,
    destinoDelRetorno: x.destinoDelRetorno as string | null,
    entroDespues: numero(x.entroDespues) ? (x.entroDespues as number) : 0,
  };
}

const leerCierres = (v: unknown): CierreDeSalida[] =>
  Array.isArray(v) ? v.map(leerCierre).filter((c): c is CierreDeSalida => c !== null) : [];

/** Las tanquetas cerradas con la forma que la pantalla necesita; las rotas se descartan. */
export function leerCerradas(v: unknown): TanquetaCerrada[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t) => {
    if (typeof t !== "object" || t === null) return [];
    const x = t as Record<string, unknown>;
    if (!numero(x.id) || typeof x.codigo !== "string") return [];
    return [{ id: x.id as number, codigo: x.codigo, salidas: leerCierres(x.salidas) }];
  });
}

/** El kardex con la forma que la pantalla necesita, o null si lo recibido no se puede leer. Una fila
 *  rota se descarta sin llevarse todo el kardex; las claves repetidas se quedan con la primera. */
export function leerKardex(k: unknown): KardexDeTanqueta | null {
  if (typeof k !== "object" || k === null) return null;
  const x = k as Record<string, unknown>;
  if (
    !Array.isArray(x.filas) ||
    !numero(x.total) ||
    typeof x.truncado !== "boolean" ||
    !numero(x.saldoFinal) ||
    typeof x.cuadra !== "boolean"
  ) {
    return null;
  }
  const vistas = new Set<string>();
  const filas = x.filas
    .slice(0, MAX_FILAS)
    .filter(esFilaValida)
    .filter((f) => !vistas.has(f.clave) && vistas.add(f.clave));
  return {
    filas,
    salidas: leerCierres(x.salidas),
    total: x.total as number,
    truncado: x.truncado,
    unidades: textos(x.unidades),
    conductores: textos(x.conductores),
    desdeSalidaActual: typeof x.desdeSalidaActual === "string" ? x.desdeSalidaActual : null,
    saldoFinal: x.saldoFinal as number,
    cuadra: x.cuadra,
  };
}
