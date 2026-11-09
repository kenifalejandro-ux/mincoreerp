// La lógica pura de «Poner al día»: la oficina registra de una vez lo que ya pasó en un viaje en
// curso (llegadas, salidas y descansos con su fecha y hora reales). Qué marcas faltan, qué atajos
// de hora hay, qué está mal antes de enviar y el cuerpo que se manda. Sin pantalla.
//
// El servidor es quien manda: ordena las acciones por hora y rechaza lo que no cuadra. Estas reglas
// existen para avisar ANTES de guardar, con el mismo criterio, y no para sustituirlo.
import { motivoGuardado, pideDetalle } from "./motivosDescanso";
import type { ParadaMia } from "./paradasViaje";

const HORA_MS = 3_600_000;

export type ClaseMarca = "llegada" | "salida";

/** Una marca que todavía no está puesta, con lo que la oficina escribe en ella. */
export interface MarcaPorPoner {
  /** Identifica a la marca mientras el viaje cambia: "llegada-1", "salida-1"... */
  clave: string;
  clase: ClaseMarca;
  /** El índice de la parada: el `orden` que espera el servidor. */
  orden: number;
  /** "Llegada a B" o "Salida de B hacia A". */
  texto: string;
  /** La llegada a la última parada termina el viaje. */
  cierra: boolean;
  /** "AAAA-MM-DDTHH:mm" en hora local; vacío mientras no se escriba. */
  en: string;
  medidor: string;
}

export interface DescansoPorPoner {
  clave: number;
  motivo: string;
  /** El detalle que piden "Otro" y "Tráfico". */
  otro: string;
  /** «¿Dónde?» opcional del descanso. */
  donde?: string;
  desde: string;
  /** Vacío si el descanso sigue abierto: entonces no puede haber marcas después. */
  hasta: string;
}

export const claveDeMarca = (clase: ClaseMarca, orden: number) => `${clase}-${orden}`;

/** Las marcas que le faltan al recorrido, en el orden en que tuvieron que pasar. Es una llegada y
 *  una salida por parada: la primera parada ya salió (el viaje está en curso) y la última no sale. */
export function marcasQueFaltan(paradas: ParadaMia[] | null | undefined): MarcaPorPoner[] {
  const p = paradas ?? [];
  const faltan: MarcaPorPoner[] = [];
  for (let i = 1; i < p.length; i++) {
    const cierra = i === p.length - 1;
    if (!p[i].llegada_en) {
      faltan.push({
        clave: claveDeMarca("llegada", i),
        clase: "llegada",
        orden: i,
        texto: `Llegada a ${p[i].lugar}${cierra ? " (termina el viaje)" : ""}`,
        cierra,
        en: "",
        medidor: "",
      });
    }
    if (!cierra && !p[i].salida_en) {
      faltan.push({
        clave: claveDeMarca("salida", i),
        clase: "salida",
        orden: i,
        texto: `Salida de ${p[i].lugar} hacia ${p[i + 1].lugar}`,
        cierra: false,
        en: "",
        medidor: "",
      });
    }
  }
  return faltan;
}

/** La hora de la última marca ya puesta del recorrido (ms), o null si no hay ninguna. */
export function ultimaMarcaHecha(paradas: ParadaMia[] | null | undefined): number | null {
  let ultima: number | null = null;
  for (const x of paradas ?? []) {
    for (const iso of [x.llegada_en, x.salida_en]) {
      const t = iso ? Date.parse(iso) : NaN;
      if (Number.isFinite(t) && (ultima === null || t > ultima)) ultima = t;
    }
  }
  return ultima;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Una hora (ms) como la escribe un campo de fecha y hora: local y al minuto. */
export function aValorLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Lo que escribió el campo, en ms; null si está vacío o no es una fecha. */
export function deValorLocal(valor: string): number | null {
  if (!valor) return null;
  const t = new Date(valor).getTime();
  return Number.isFinite(t) ? t : null;
}

export type Atajo = "ahora" | "hace1h" | "hace6h" | "mas8h";

/** La hora que pone un atajo. «+8 h» cuenta desde la marca anterior y no pasa de ahora; sin marca
 *  anterior no hay de dónde contar y devuelve null. */
export function horaDeAtajo(atajo: Atajo, ahora: number, previa: number | null): string | null {
  if (atajo === "ahora") return aValorLocal(ahora);
  if (atajo === "hace1h") return aValorLocal(ahora - HORA_MS);
  if (atajo === "hace6h") return aValorLocal(ahora - 6 * HORA_MS);
  if (previa === null) return null;
  return aValorLocal(Math.min(previa + 8 * HORA_MS, ahora));
}

const fechaCorta = (ms: number) =>
  new Date(ms).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });

export interface EntradaDeEvaluar {
  marcas: MarcaPorPoner[];
  descansos: DescansoPorPoner[];
  /** La última marca ya puesta (ms): lo que se escriba tiene que ser posterior. */
  ultimaHecha: number | null;
  /** Cuándo salió el viaje (ms): un descanso es posterior a esa salida. */
  inicioViaje: number | null;
  /** Hay un medidor de salida: la llegada final lo necesita. */
  exigeMedidorFinal: boolean;
  ahora: number;
  motivo: string;
}

export interface Evaluacion {
  /** Un mensaje por marca (null: bien o todavía vacía), en el mismo orden que `marcas`. */
  errorMarca: (string | null)[];
  /** Cuáles se pueden enviar: llenas, en orden y sin error. */
  okMarca: boolean[];
  errorDescanso: (string | null)[];
  okDescanso: boolean[];
  marcasListas: number;
  descansosListos: number;
  /** Lo que impide guardar, dicho para el pie; null si ya se puede. */
  pie: string | null;
  /** Se guarda la llegada final: el viaje queda cerrado. */
  cierraElViaje: boolean;
}

/** El medidor escrito: undefined si está vacío; NaN si no es un número. */
function medidorEscrito(texto: string): number | undefined {
  const t = texto.trim().replace(",", ".");
  return t === "" ? undefined : Number(t);
}

export function evaluar(e: EntradaDeEvaluar): Evaluacion {
  let previa = e.ultimaHecha;
  let corte = false;
  const errorMarca: (string | null)[] = [];
  const okMarca: boolean[] = [];
  e.marcas.forEach((m) => {
    if (m.en === "") {
      corte = true;
      errorMarca.push(null);
      okMarca.push(false);
      return;
    }
    const t = deValorLocal(m.en);
    const med = medidorEscrito(m.medidor);
    let error: string | null = null;
    if (t === null) error = "Fecha y hora no válidas.";
    else if (corte) error = "Llena primero la marca anterior.";
    else if (previa !== null && t <= previa)
      error = `Tiene que ser después de ${fechaCorta(previa)}.`;
    else if (t > e.ahora) error = "No puede ser en el futuro.";
    else if (med !== undefined && (Number.isNaN(med) || med < 0)) {
      error = "El medidor tiene que ser un número.";
    } else if (m.cierra && e.exigeMedidorFinal && med === undefined) {
      error = "Este viaje salió con medidor: la llegada final lo necesita.";
    }
    errorMarca.push(error);
    okMarca.push(error === null);
    if (error === null && t !== null) previa = t;
    else corte = true;
  });

  // La hora de la última marca que se va a guardar: un descanso abierto no puede quedar antes.
  const ultimaListaMs = e.marcas.reduce<number | null>((max, m, i) => {
    const t = okMarca[i] ? deValorLocal(m.en) : null;
    return t !== null && (max === null || t > max) ? t : max;
  }, null);

  const errorDescanso: (string | null)[] = [];
  const okDescanso: boolean[] = [];
  e.descansos.forEach((d) => {
    const desde = deValorLocal(d.desde);
    const hasta = deValorLocal(d.hasta);
    let error: string | null = null;
    if (motivoGuardado(d.motivo, d.otro).length < 3) {
      error = pideDetalle(d.motivo) ? "Escribe el motivo." : "Elige el motivo.";
    } else if (desde === null) error = "Falta desde cuándo.";
    else if (e.inicioViaje !== null && desde <= e.inicioViaje) {
      error = "Tiene que ser después de la salida del viaje.";
    } else if (desde > e.ahora) error = "El inicio no puede ser en el futuro.";
    else if (d.hasta !== "" && hasta === null) error = "Fecha y hora no válidas.";
    else if (hasta !== null && hasta > e.ahora) error = "El fin no puede ser en el futuro.";
    else if (hasta !== null && hasta <= desde) error = "El fin tiene que ser después del inicio.";
    else if (hasta === null && ultimaListaMs !== null && ultimaListaMs > desde) {
      error = "Si el descanso sigue abierto no puede haber marcas después. Pon cuándo terminó.";
    }
    errorDescanso.push(error);
    okDescanso.push(error === null);
  });

  const marcasListas = okMarca.filter(Boolean).length;
  const descansosListos = okDescanso.filter(Boolean).length;
  const hayErrores = errorMarca.some((x) => x !== null) || errorDescanso.some((x) => x !== null);
  let pie: string | null = null;
  if (hayErrores) pie = "Corrige lo marcado en rojo.";
  else if (marcasListas + descansosListos === 0) pie = "Llena al menos una marca o un descanso.";
  else if (e.motivo.trim().length < 3) pie = "Falta el motivo (3 letras o más).";

  return {
    errorMarca,
    okMarca,
    errorDescanso,
    okDescanso,
    marcasListas,
    descansosListos,
    pie,
    cierraElViaje: e.marcas.some((m, i) => okMarca[i] && m.cierra),
  };
}

/** De dónde salió cada acción de la lista que se manda, para señalar la fila cuando el servidor
 *  rechaza una («Acción 3»: el índice es `indice`). */
export type OrigenDeAccion = { tipo: "marca"; clave: string } | { tipo: "descanso"; clave: number };

export interface AccionesArmadas {
  acciones: Record<string, unknown>[];
  origenes: OrigenDeAccion[];
}

/** La lista que se manda al servidor: las marcas listas y los descansos listos. El servidor las
 *  ordena por hora; aquí van primero las marcas, en su orden, y después los descansos. */
export function armarAcciones(
  marcas: MarcaPorPoner[],
  descansos: DescansoPorPoner[],
  ev: Evaluacion
): AccionesArmadas {
  const acciones: Record<string, unknown>[] = [];
  const origenes: OrigenDeAccion[] = [];
  marcas.forEach((m, i) => {
    if (!ev.okMarca[i]) return;
    const medidor = medidorEscrito(m.medidor);
    acciones.push({
      tipo: m.clase,
      en: new Date(deValorLocal(m.en) as number).toISOString(),
      orden: m.orden,
      ...(medidor !== undefined ? { medidor } : {}),
    });
    origenes.push({ tipo: "marca", clave: m.clave });
  });
  descansos.forEach((d, i) => {
    if (!ev.okDescanso[i]) return;
    const hasta = deValorLocal(d.hasta);
    acciones.push({
      tipo: "descanso",
      motivo: motivoGuardado(d.motivo, d.otro),
      ...(d.donde?.trim() ? { donde: d.donde.trim() } : {}),
      desde: new Date(deValorLocal(d.desde) as number).toISOString(),
      ...(hasta !== null ? { hasta: new Date(hasta).toISOString() } : {}),
    });
    origenes.push({ tipo: "descanso", clave: d.clave });
  });
  return { acciones, origenes };
}

/** El texto del botón de guardar: «Guardar 3 marcas y 1 descanso y cerrar el viaje». */
export function textoDeGuardar(ev: Evaluacion): string {
  const partes: string[] = [];
  if (ev.marcasListas > 0)
    partes.push(`${ev.marcasListas} ${ev.marcasListas === 1 ? "marca" : "marcas"}`);
  if (ev.descansosListos > 0) {
    partes.push(`${ev.descansosListos} ${ev.descansosListos === 1 ? "descanso" : "descansos"}`);
  }
  const base = partes.length > 0 ? `Guardar ${partes.join(" y ")}` : "Guardar";
  return ev.cierraElViaje ? `${base} y cerrar el viaje` : base;
}
