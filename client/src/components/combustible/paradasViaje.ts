// Las paradas de un viaje vistas desde el celular del conductor (0148): en qué punto va,
// cuál es su próxima marca y cómo queda el viaje mientras esa marca espera señal. Lógica
// sin pantalla; el servidor valida lo mismo (viajes.service.ts).

export interface ParadaMia {
  orden: number;
  lugar_id: number;
  lugar: string;
  llegada_en: string | null;
  llegada_medidor: string | number | null;
  salida_en: string | null;
  salida_medidor: string | number | null;
}

export type Posicion =
  | { tipo: "sin_salir" }
  | { tipo: "en_marcha"; hacia: number }
  | { tipo: "en_parada"; en: number }
  | { tipo: "terminado" };

/** En qué punto del recorrido va el viaje, según las marcas de sus paradas. */
export function posicion(p: ParadaMia[]): Posicion {
  for (let i = 0; i < p.length - 1; i++) {
    if (!p[i].salida_en) return i === 0 ? { tipo: "sin_salir" } : { tipo: "en_parada", en: i };
    if (!p[i + 1].llegada_en) return { tipo: "en_marcha", hacia: i + 1 };
  }
  return { tipo: "terminado" };
}

/** Dónde va el viaje, dicho como lo lee el encargado: "En ruta a B", "Retornando a A" (la última
 *  parada vuelve al punto de salida) o "En B · sigue a A". Null si no ha salido o ya terminó. */
export function estadoDelTramo(p: ParadaMia[]): { texto: string; retorno: boolean } | null {
  const pos = posicion(p);
  if (pos.tipo === "en_marcha") {
    const destino = p[pos.hacia];
    const retorno =
      pos.hacia > 1 && pos.hacia === p.length - 1 && destino.lugar_id === p[0].lugar_id;
    return { texto: `${retorno ? "Retornando" : "En ruta"} a ${destino.lugar}`, retorno };
  }
  if (pos.tipo === "en_parada") {
    return { texto: `En ${p[pos.en].lugar} · sigue a ${p[pos.en + 1].lugar}`, retorno: false };
  }
  return null;
}

export interface AhoraSiguiente {
  ahora: string;
  luego: string | null;
}

/** Lo que le toca al conductor ahora y lo que sigue, en una línea. Antes de salir sigue los pasos
 *  de la pantalla (revisar, confirmar, iniciar); en ruta, las paradas y el mando. */
export function ahoraYSiguiente(
  p: ParadaMia[],
  c: {
    estado: "programado" | "en_curso";
    paso: "ver" | "revisar" | "iniciar";
    alVolante: boolean;
    manejaNombre: string | null | undefined;
    descansando: boolean;
    recibeMando: boolean;
    esperaMando: boolean;
  }
): AhoraSiguiente {
  if (c.estado === "programado") {
    if (!c.alVolante) {
      return {
        ahora: `Esperar: sale manejando ${c.manejaNombre ?? "el otro conductor"}`,
        luego: "recibir el mando cuando te lo entregue",
      };
    }
    if (c.paso === "ver") return { ahora: "Revisar el viaje", luego: "confirmarlo e iniciar" };
    if (c.paso === "revisar") return { ahora: "Confirmar los datos", luego: "iniciar el viaje" };
    return {
      ahora: "Iniciar el viaje",
      luego: p[1] ? `llegar a ${p[1].lugar}` : null,
    };
  }
  // El descanso va primero: con uno abierto la pantalla no ofrece aceptar el mando.
  if (c.descansando) {
    return {
      ahora: "Terminar tu descanso",
      luego: c.recibeMando ? "recibir el mando" : "seguir el viaje",
    };
  }
  if (c.recibeMando) return { ahora: "Recibir el mando", luego: null };
  if (!c.alVolante) {
    return {
      ahora: `Va manejando ${c.manejaNombre ?? "el otro conductor"}`,
      luego: c.esperaMando ? "esperar que reciban el mando" : "puedes descansar o esperar el mando",
    };
  }
  const pos = posicion(p);
  // Quien entregó sigue al volante hasta que el otro acepte: conserva su paso, con el aviso.
  const pendiente = c.esperaMando ? "el mando sigue sin aceptar" : null;
  const conAviso = (r: AhoraSiguiente): AhoraSiguiente =>
    pendiente ? { ...r, luego: r.luego ? `${r.luego} (${pendiente})` : pendiente } : r;
  const ultima = p.length - 1;
  // Un viaje en curso sin la salida marcada en la primera parada se trata como rumbo a la segunda.
  const hacia = pos.tipo === "en_marcha" ? pos.hacia : pos.tipo === "sin_salir" ? 1 : null;
  if (hacia !== null) {
    const fin = hacia === ultima;
    return conAviso({
      ahora: fin ? `Llegar a ${p[hacia].lugar} y terminar el viaje` : `Llegar a ${p[hacia].lugar}`,
      luego: fin ? null : `salir hacia ${p[hacia + 1].lugar}`,
    });
  }
  if (pos.tipo === "en_parada") {
    return conAviso({
      ahora: `Salir hacia ${p[pos.en + 1].lugar}`,
      luego: pos.en + 1 === ultima ? "llegada final" : `llegar a ${p[pos.en + 1].lugar}`,
    });
  }
  return { ahora: "Viaje terminado", luego: null };
}

/** Lo que manejó una persona en un viaje con relevo: sus kilómetros y el tiempo de sus turnos.
 *  Null si no tuvo turnos. Un turno abierto cuenta hasta `ahora` y hasta la última lectura. */
export function parteDelConductor(
  turnos: TurnoViaje[] | null | undefined,
  dni: string | null | undefined,
  ahora: number
): { km: number; minutos: number } | null {
  const mios = (turnos ?? []).filter((t) => t.conductor_dni.trim() === (dni ?? "").trim());
  if (!dni || mios.length === 0) return null;
  let km = 0;
  let ms = 0;
  for (const t of mios) {
    const ini = t.medidor_inicio === null ? null : Number(t.medidor_inicio);
    const fin = t.medidor_fin === null ? null : Number(t.medidor_fin);
    if (ini !== null && fin !== null && fin >= ini) km += fin - ini;
    ms += Math.max(0, (t.fin_en ? Date.parse(t.fin_en) : ahora) - Date.parse(t.inicio_en));
  }
  return { km, minutos: ms / 60_000 };
}

export interface TramoConEstimacion {
  salida_en: string | null;
  llegada_en: string | null;
  /** Lo que suele tardar el tramo en marcha, sin descansos (mediana del historial). */
  esperado_min?: number | null;
  esperado_viajes?: number;
  esperado_base?: "tipo" | "todas" | null;
}

/** Dónde va el camión en la barra, estimado. Cada tramo ocupa el mismo ancho; el que está en
 *  marcha avanza con el tiempo en marcha (sin descansos) sobre lo que suele tardar, y sin la marca
 *  de llegada no pasa del 95 %. Sin historial del tramo, el camión espera en su inicio. */
export function avanceEstimado(
  tramos: TramoConEstimacion[],
  descansos: { inicio_en: string; fin_en: string | null; detiene?: boolean }[] | null | undefined,
  ahora: number
) {
  let suma = 0;
  let actual: {
    tramo: TramoConEstimacion;
    esperado: number | null;
    llegada: number | null;
    demora: number;
  } | null = null;
  for (const t of tramos) {
    if (t.llegada_en) {
      suma += 1;
      continue;
    }
    if (!t.salida_en || actual) continue;
    const salida = Date.parse(t.salida_en);
    if (Number.isNaN(salida)) continue;
    const parado = (descansos ?? [])
      .filter((d) => d.detiene !== false && Date.parse(d.inicio_en) >= salida)
      .reduce((s, d) => s + (d.fin_en ? Date.parse(d.fin_en) : ahora) - Date.parse(d.inicio_en), 0);
    const marcha = Math.max(0, (ahora - salida - parado) / 60_000);
    const esperado = t.esperado_min ?? null;
    if (esperado) suma += Math.min(0.95, marcha / esperado);
    actual = {
      tramo: t,
      esperado,
      llegada: esperado ? salida + parado + esperado * 60_000 : null,
      demora: esperado && marcha > esperado ? marcha - esperado : 0,
    };
  }
  return { progreso: tramos.length ? (suma / tramos.length) * 100 : 0, actual };
}

export interface ProximaMarca {
  accion: "llegada-mia" | "salida-mia";
  /** La parada a la que llega o de la que sale: el servidor rechaza la marca si ya no vale. */
  orden: number;
  texto: string;
  /** Llegar a la última parada cierra el viaje. */
  cierra: boolean;
  /** La última lectura del viaje: la nueva no puede ser menor. */
  minimo: number | null;
}

const numeroONull = (x: string | number | null): number | null => (x == null ? null : Number(x));

/** Lo que sigue en el recorrido, o null si el viaje todavía no salió o ya terminó. */
export function proximaMarca(p: ParadaMia[]): ProximaMarca | null {
  const pos = posicion(p);
  if (pos.tipo === "en_marcha") {
    const cierra = pos.hacia === p.length - 1;
    const lugar = p[pos.hacia].lugar;
    return {
      accion: "llegada-mia",
      orden: pos.hacia,
      texto: cierra ? `Llegué a ${lugar} · terminar viaje` : `Llegué a ${lugar}`,
      cierra,
      minimo: numeroONull(p[pos.hacia - 1].salida_medidor),
    };
  }
  if (pos.tipo === "en_parada") {
    return {
      accion: "salida-mia",
      orden: pos.en,
      texto: `Salir hacia ${p[pos.en + 1].lugar}`,
      cierra: false,
      minimo: numeroONull(p[pos.en].llegada_medidor),
    };
  }
  return null;
}

/** Las paradas con la marca ya puesta, para mostrarla aunque todavía no haya señal. */
export function conMarcaLocal(
  p: ParadaMia[],
  m: ProximaMarca,
  marcadoEn: string,
  lectura: number | null
): ParadaMia[] {
  const medidor = lectura === null ? null : String(lectura);
  return p.map((x) => {
    if (x.orden !== m.orden) return x;
    return m.accion === "llegada-mia"
      ? { ...x, llegada_en: marcadoEn, llegada_medidor: medidor }
      : { ...x, salida_en: marcadoEn, salida_medidor: medidor };
  });
}

/** Un descanso del conductor: desde que lo empieza hasta que lo termina. */
export interface DescansoMio {
  inicio_en: string;
  fin_en: string | null;
  motivo: string | null;
  donde?: string;
  /** Si frena la unidad: el descanso del que no maneja no la detiene. */
  detiene?: boolean;
  /** Quién lo marcó: el conductor desde su celular o la oficina por él. */
  inicio_por?: string;
  fin_por?: string | null;
  conductor_nombre?: string | null;
}

/** El descanso que sigue abierto: mientras dure, el viaje no avanza. */
export const descansoAbierto = (d: DescansoMio[] | null | undefined): DescansoMio | null =>
  (d ?? []).find((x) => !x.fin_en) ?? null;

/** Los minutos descansados hasta ahora (el abierto cuenta hasta este momento). */
export const minutosDescansados = (d: DescansoMio[] | null | undefined, ahora: number): number =>
  (d ?? []).reduce(
    (n, x) => n + ((x.fin_en ? Date.parse(x.fin_en) : ahora) - Date.parse(x.inicio_en)) / 60_000,
    0
  );

/** Los descansos con la marca ya puesta, para mostrarla aunque todavía no haya señal. */
export function conDescansoLocal(
  d: DescansoMio[] | null | undefined,
  accion: "empezar" | "terminar",
  marcadoEn: string,
  motivo: string | null
): DescansoMio[] {
  const actuales = d ?? [];
  if (accion === "empezar") return [...actuales, { inicio_en: marcadoEn, fin_en: null, motivo }];
  return actuales.map((x) => (x.fin_en ? x : { ...x, fin_en: marcadoEn }));
}

/** Un turno de conducción: quién estuvo al volante, de qué lectura a cuál (0152). */
export interface TurnoViaje {
  conductor_dni: string;
  conductor_nombre: string | null;
  inicio_en: string;
  fin_en: string | null;
  medidor_inicio: string | number | null;
  medidor_fin: string | number | null;
  lugar?: string | null;
  /** La oficina partió este turno a posteriori (0154), con motivo. */
  corregido?: boolean;
  corregido_motivo?: string | null;
}

/** La entrega del mando que espera que el otro conductor acepte (0153). */
export interface EntregaPendiente {
  de_dni: string;
  de_nombre: string | null;
  a_dni: string;
  a_nombre: string | null;
  entrega_en: string;
  medidor: string | number | null;
  lugar: string | null;
}

/** Cuánto ha avanzado el mando: cada turno cuenta 2 y la entrega pendiente 1. */
export const avanceDelMando = (
  turnos: TurnoViaje[] | null | undefined,
  entrega: EntregaPendiente | null | undefined
): number => (turnos?.length ?? 0) * 2 + (entrega ? 1 : 0);

/** Cuántas marcas tiene el viaje: sirve para saber qué versión va más adelantada. */
export const marcasHechas = (p: ParadaMia[]): number =>
  p.reduce((n, x) => n + (x.llegada_en ? 1 : 0) + (x.salida_en ? 1 : 0), 0);

/** Las marcas de las paradas y de los descansos juntas. */
export const avanceDelViaje = (p: ParadaMia[], d: DescansoMio[] | null | undefined): number =>
  marcasHechas(p) + (d ?? []).reduce((n, x) => n + 1 + (x.fin_en ? 1 : 0), 0);

interface ViajeConRuta {
  paradas?: ParadaMia[] | null;
  origen_id: string;
  origen: string;
  destino_id: string;
  destino: string;
  inicio_en: string | null;
  fin_en: string | null;
  medidor_inicio: string | null;
  medidor_fin: string | null;
}

/** Las paradas del viaje; si la lista guardada en el celular es de antes de las paradas
 *  (origen → destino), se arman las dos de la ida. */
export function paradasDelViaje(v: ViajeConRuta): ParadaMia[] {
  if (v.paradas && v.paradas.length >= 2) return v.paradas;
  return [
    {
      orden: 0,
      lugar_id: Number(v.origen_id),
      lugar: v.origen,
      llegada_en: null,
      llegada_medidor: null,
      salida_en: v.inicio_en,
      salida_medidor: v.medidor_inicio,
    },
    {
      orden: 1,
      lugar_id: Number(v.destino_id),
      lugar: v.destino,
      llegada_en: v.fin_en,
      llegada_medidor: v.medidor_fin,
      salida_en: null,
      salida_medidor: null,
    },
  ];
}
