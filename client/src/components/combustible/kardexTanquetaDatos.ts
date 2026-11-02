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

export interface KardexDeTanqueta {
  filas: FilaKardex[];
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
    total: x.total as number,
    truncado: x.truncado,
    unidades: textos(x.unidades),
    conductores: textos(x.conductores),
    desdeSalidaActual: typeof x.desdeSalidaActual === "string" ? x.desdeSalidaActual : null,
    saldoFinal: x.saldoFinal as number,
    cuadra: x.cuadra,
  };
}
