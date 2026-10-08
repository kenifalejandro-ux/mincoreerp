// client/src/components/equipos/equiposVista.ts
//
// Lo que la pantalla de Equipos sabe DECIR de una unidad (estado, faltantes,
// tanque, icono, orden). Sin React: son reglas, no dibujo.

export interface Equipo {
  id: number;
  placa_codigo: string;
  // Código interno de la empresa (ej. "CU-14"), distinto de la placa --
  // columna CODIGO de la planilla de flota real (migración 0103).
  codigo_interno: string | null;
  tipo: string;
  marca: string | null;
  modelo: string | null;
  // Fase B de combustible (migrations/0062): qué instrumento mide este
  // equipo en un despacho de compra externa -- horómetro (horas de motor)
  // u odómetro (kilometraje), nunca los dos. null = no configurado, y un
  // despacho compra_externa a este equipo se rechaza hasta que se cargue.
  tipo_medidor: "horometro" | "odometro" | null;
  // Fase D de combustible (migrations/0069): capacidad del tanque de ESTA
  // unidad, para detectar sobredespacho. null = sin configurar, y entonces
  // no se valida nada para este equipo -- que es el estado inicial de todos
  // a propósito: un dato inventado sería peor que ninguno.
  capacidad_tanque: string | null;
  capacidad_tanque_unidad: "gal" | "L" | null;
  /** Litros por hora de motor (horómetro) o por km (odómetro) que se toleran.
   *  null = sin configurar, no alerta (migración 0088). */
  consumo_maximo_l: string | null;
  conductor_nombre: string | null;
  conductor_dni: string | null;
  /** Rutas habituales vigentes (0126): cero, una o varias. */
  rutas: { origen_id: number; destino_id: number; origen: string; destino: string }[];
  activo: boolean;
  creado_en: string;
  // El grifo interno al que pertenece (0097). Se cambia con "Mover de grifo".
  grifo_interno_id: number | null;
}

export type EstadoUnidad = "Activo" | "Sin asignar" | "Inactivo";
export type VistaEquipos = "tabla" | "tarjetas";
export type TamTarjeta = "amplia" | "normal" | "compacta";
export type FocoFlota = "todos" | "sinConductor" | "sinRuta";

export const normalizarTexto = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Espejo de src/modules/equipos/equipos.estado.ts: bombonas y carretas no se
 *  manejan solas, así que no piden conductor ni ruta. */
export function tipoLlevaConductor(tipo: string): boolean {
  const t = normalizarTexto(tipo);
  return !(t.startsWith("bombona") || t.startsWith("carreta"));
}

export const tieneConductor = (e: Equipo) => !!(e.conductor_nombre || e.conductor_dni);

/** "Activo" = la unidad tiene conductor vigente (o no lo necesita). */
export function estadoDeUnidad(e: Equipo): EstadoUnidad {
  if (!e.activo) return "Inactivo";
  if (!tipoLlevaConductor(e.tipo)) return "Activo";
  return tieneConductor(e) ? "Activo" : "Sin asignar";
}

export const sinConductor = (e: Equipo) =>
  e.activo && tipoLlevaConductor(e.tipo) && !tieneConductor(e);

export const sinRuta = (e: Equipo) =>
  e.activo && tipoLlevaConductor(e.tipo) && (e.rutas ?? []).length === 0;

export function textoTanque(e: Equipo): string | null {
  if (e.capacidad_tanque === null || e.capacidad_tanque === "") return null;
  const n = Number(e.capacidad_tanque);
  if (!Number.isFinite(n)) return null;
  return `${n.toLocaleString("es-PE", { maximumFractionDigits: 2 })} ${e.capacidad_tanque_unidad ?? ""}`.trim();
}

export function textoMedidor(e: Equipo): string | null {
  return e.tipo_medidor === "horometro"
    ? "Horómetro"
    : e.tipo_medidor === "odometro"
      ? "Odómetro"
      : null;
}

export type ClaveIcono =
  | "volquete"
  | "excavadora"
  | "retroexcavadora"
  | "cargador"
  | "camioneta"
  | "trailer"
  | "bombona"
  | "carreta"
  | "generico";

/** Qué dibujo le toca a cada tipo. Los tipos se escriben a mano o vienen de una
 *  planilla ("EXCAVADORA", "Tracto remolcadores"): se compara sin mayúsculas ni
 *  tildes y por el comienzo. Lo que no se reconoce usa el icono genérico. */
export function claveIcono(tipo: string): ClaveIcono {
  const t = normalizarTexto(tipo);
  if (t.startsWith("volquete")) return "volquete";
  if (t.startsWith("retroexcavadora")) return "retroexcavadora";
  if (t.startsWith("excavadora")) return "excavadora";
  if (t.startsWith("cargador")) return "cargador";
  if (t.startsWith("camioneta")) return "camioneta";
  if (t.startsWith("trailer") || t.startsWith("tracto") || t.startsWith("camion")) return "trailer";
  if (t.startsWith("bombona")) return "bombona";
  if (t.startsWith("carreta")) return "carreta";
  return "generico";
}

export type ColumnaOrden =
  "placa" | "codigo" | "tipo" | "marca" | "modelo" | "medidor" | "tanque" | "conductor";

const VALOR_ORDEN: Record<ColumnaOrden, (e: Equipo) => string | number | null> = {
  placa: (e) => e.placa_codigo,
  codigo: (e) => e.codigo_interno || null,
  tipo: (e) => e.tipo,
  marca: (e) => e.marca || null,
  modelo: (e) => e.modelo || null,
  medidor: (e) => textoMedidor(e),
  tanque: (e) => {
    const n = Number(e.capacidad_tanque);
    return e.capacidad_tanque === null || !Number.isFinite(n) ? null : n;
  },
  conductor: (e) => e.conductor_nombre || null,
};

/** Ordena sin mover los vacíos: lo que no tiene dato va siempre al final, suba
 *  o baje el orden (si no, "sin conductor" taparía a los que sí lo tienen). */
export function ordenarEquipos(lista: Equipo[], col: ColumnaOrden | null, dir: 1 | -1): Equipo[] {
  if (col === null) return lista;
  const valor = VALOR_ORDEN[col];
  return [...lista].sort((a, b) => {
    const x = valor(a);
    const y = valor(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    const cmp =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), "es", { numeric: true });
    return cmp * dir;
  });
}

/** Texto en el que busca el cuadro de búsqueda: todo lo que se ve de la unidad. */
export function textoBuscable(e: Equipo): string {
  return [
    e.placa_codigo,
    e.codigo_interno,
    e.tipo,
    e.marca,
    e.modelo,
    e.conductor_nombre,
    e.conductor_dni,
    textoTanque(e),
    ...(e.rutas ?? []).map((r) => `${r.origen} ${r.destino}`),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
