// El kardex de una tanqueta para el conductor: cada movimiento con lo que entra, lo que sale y el
// saldo que quedó, de modo que la última fila sea el saldo del cilindro. Es un cálculo sobre lo ya
// guardado (solo lectura), aparte de la consulta para poder probarlo con datos armados a mano.
//
// El saldo se suma con la misma regla que `COLUMNAS` en tanquetas.service.ts: entradas (excedente,
// previsión desde el tanque, traspaso de otra tanqueta) + ajustes del grifero − salidas (cargas,
// saldo que volvió al pozo o pasó a otra tanqueta). Una anulada se muestra pero no mueve el saldo.
// La asignación a una unidad no mueve combustible: lleva el vale y lo que la tanqueta llevaba.
//
// Para el conductor no hay costos, ni quién registró cada fila, ni el motivo de un ajuste.

export type TipoMovimientoKardex =
  | "excedente"
  | "prevision"
  | "traslado_recibido"
  | "carga_ruta"
  | "carga_planta"
  | "retorno"
  | "retorno_pozo"
  | "retorno_traslado"
  | "asignacion";

/** Una fila de `historialTanqueta`, ya con los tipos de JavaScript. */
export interface MovimientoBruto {
  tipo: TipoMovimientoKardex;
  id: string;
  /** Con signo en `retorno` (la diferencia que corrigió el grifero); null en una asignación
   *  anterior a la 0142, que no guardó cuánto llevaba. */
  cantidad: number | null;
  fecha: Date;
  anulada: boolean;
  /** El tanque, pozo u otra tanqueta del otro lado del movimiento. */
  referencia: string | null;
  unidad: string | null;
  serie: string | null;
  nVale: number | null;
  /** El nombre y el DNI que el vale copió de Equipos cuando se cargó. El DNI solo se usa para
   *  reconocer a la misma persona: no sale en las filas. */
  conductor: string | null;
  conductorDni: string | null;
}

/** Una salida de la tanqueta (de `armarCuadre`): del vale a la unidad hasta que vuelve. */
export interface VentanaDeVale {
  vale: string;
  inicio: Date;
  fin: Date | null;
}

export interface FilaKardex {
  clave: string;
  fecha: string;
  tipo: TipoMovimientoKardex;
  referencia: string | null;
  vale: string | null;
  unidad: string | null;
  conductor: string | null;
  /** Lo que el movimiento dice, anulado o no (para tacharlo en pantalla). */
  cantidad: number | null;
  entra: number;
  sale: number;
  /** El saldo de la tanqueta justo después de esta fila, con todo el historial. */
  saldo: number;
  anulada: boolean;
  /** Solo en una asignación: lo que la tanqueta llevaba al salir con ese vale. */
  lleva: number | null;
}

export interface FiltrosKardex {
  desde?: Date;
  hasta?: Date;
  unidad?: string;
  conductor?: string;
}

export interface Kardex {
  filas: FilaKardex[];
  /** Cuántas filas cumplen los filtros; `filas` trae las más recientes hasta `TOPE_FILAS`. */
  total: number;
  truncado: boolean;
  /** Lo que se puede elegir en los filtros: quienes usaron esta tanqueta, sin importar el filtro. */
  unidades: string[];
  conductores: string[];
  /** Cuándo empezó la salida en curso (o la última que no volvió): lo que se muestra al abrir. */
  desdeSalidaActual: string | null;
  saldoFinal: number;
  /** ¿La última fila coincide con el saldo de la tanqueta? Si no, hay un dato inconsistente. */
  cuadra: boolean;
}

/** Lo máximo que se devuelve de una vez: más allá, el conductor acota con fechas o filtros. */
export const TOPE_FILAS = 500;

const TOLERANCIA = 0.01;

const redondear = (n: number) => Number(n.toFixed(2));

const ENTRADAS: ReadonlySet<TipoMovimientoKardex> = new Set([
  "excedente",
  "prevision",
  "traslado_recibido",
]);
const SALIDAS: ReadonlySet<TipoMovimientoKardex> = new Set([
  "carga_ruta",
  "carga_planta",
  "retorno_pozo",
  "retorno_traslado",
]);

// Si dos filas caen en el mismo instante: primero lo que entra, luego el ajuste del grifero, la
// asignación y al final lo que sale. Así el saldo nunca baja de cero por el orden de dos filas
// que el grifero guardó juntas (ajuste y devolución al pozo).
const prioridad = (tipo: TipoMovimientoKardex) =>
  ENTRADAS.has(tipo) ? 0 : tipo === "retorno" ? 1 : tipo === "asignacion" ? 2 : 3;

function efecto(m: MovimientoBruto): { entra: number; sale: number } {
  const cantidad = m.cantidad ?? 0;
  if (ENTRADAS.has(m.tipo)) return { entra: cantidad, sale: 0 };
  if (SALIDAS.has(m.tipo)) return { entra: 0, sale: cantidad };
  if (m.tipo === "retorno") {
    return cantidad >= 0 ? { entra: cantidad, sale: 0 } : { entra: 0, sale: -cantidad };
  }
  return { entra: 0, sale: 0 };
}

/** El vale de la salida a la que pertenece una carga: la que empezó antes y aún no cerraba. */
function valeDeLaSalida(en: Date, ventanas: VentanaDeVale[]): string | null {
  const v = ventanas.find(
    (w) => w.inicio.getTime() <= en.getTime() && (w.fin === null || en.getTime() < w.fin.getTime())
  );
  return v?.vale ?? null;
}

export function armarKardex(
  movimientos: MovimientoBruto[],
  ventanas: VentanaDeVale[],
  saldoDeLaTanqueta: number,
  filtros: FiltrosKardex = {},
  /** Para probarlo con el tope más chico. */
  tope: number = TOPE_FILAS
): Kardex {
  // Un ajuste de cero no mueve nada: lo dice la fila de devolución o de la nueva asignación.
  const validos = movimientos.filter((m) => !(m.tipo === "retorno" && (m.cantidad ?? 0) === 0));
  const orden = [...validos].sort(
    (a, b) =>
      a.fecha.getTime() - b.fecha.getTime() ||
      prioridad(a.tipo) - prioridad(b.tipo) ||
      Number(a.id) - Number(b.id)
  );

  // Una persona es su DNI (sin DNI, su nombre): el nombre que Equipos tenía al cargar cada vale
  // puede estar escrito distinto y no debe partirla en dos. Se muestra el más reciente.
  const quien = (m: MovimientoBruto) =>
    m.conductorDni?.trim() ? m.conductorDni.trim() : m.conductor ? `n:${m.conductor}` : null;
  const nombreActual = new Map<string, string>();
  for (const m of orden) {
    const persona = quien(m);
    if (persona !== null && m.conductor) nombreActual.set(persona, m.conductor);
  }

  let saldo = 0;
  const todas: FilaKardex[] = orden.map((m) => {
    const { entra, sale } = efecto(m);
    if (!m.anulada) saldo = redondear(saldo + entra - sale);
    const propioVale = m.serie !== null && m.nVale !== null ? `${m.serie}-${m.nVale}` : null;
    return {
      clave: `${m.tipo}-${m.id}`,
      fecha: m.fecha.toISOString(),
      tipo: m.tipo,
      referencia: m.referencia,
      // Una carga muestra el vale de la SALIDA a la que pertenece, aunque tenga uno propio (una
      // carga en planta lo trae): así dice lo mismo que `vale_salida` del listado del conductor.
      vale:
        m.tipo === "carga_ruta" || m.tipo === "carga_planta"
          ? valeDeLaSalida(m.fecha, ventanas)
          : propioVale,
      unidad: m.unidad,
      conductor: nombreActual.get(quien(m) ?? "") ?? null,
      cantidad: m.cantidad,
      entra: m.anulada ? 0 : redondear(entra),
      sale: m.anulada ? 0 : redondear(sale),
      saldo,
      anulada: m.anulada,
      lleva: m.tipo === "asignacion" ? m.cantidad : null,
    };
  });

  const distintos = (campo: "unidad" | "conductor") =>
    [...new Set(todas.map((f) => f[campo]).filter((v): v is string => v !== null))].sort((a, b) =>
      a.localeCompare(b, "es")
    );

  const visibles = todas.filter(
    (f) =>
      (filtros.desde === undefined || new Date(f.fecha).getTime() >= filtros.desde.getTime()) &&
      (filtros.hasta === undefined || new Date(f.fecha).getTime() <= filtros.hasta.getTime()) &&
      (filtros.unidad === undefined || f.unidad === filtros.unidad) &&
      (filtros.conductor === undefined || f.conductor === filtros.conductor)
  );
  const recientes = visibles.reverse();

  // La salida en curso es la última que no volvió; sin ninguna, no hay desde dónde empezar.
  const enCurso = ventanas.reduce<VentanaDeVale | null>(
    (mas, w) => (w.fin === null && (mas === null || w.inicio > mas.inicio) ? w : mas),
    null
  );

  return {
    filas: recientes.slice(0, tope),
    total: recientes.length,
    truncado: recientes.length > tope,
    unidades: distintos("unidad"),
    conductores: distintos("conductor"),
    desdeSalidaActual: enCurso ? enCurso.inicio.toISOString() : null,
    saldoFinal: saldo,
    cuadra: Math.abs(saldo - saldoDeLaTanqueta) < TOLERANCIA,
  };
}
