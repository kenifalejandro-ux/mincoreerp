// client/src/components/mantenimiento/ordenesMantenimiento.ts
//
// La lógica de Órdenes de trabajo dentro del ecosistema, sin React: filtros de la lista, textos y los pasos de
// cada orden. Los datos son del módulo Órdenes de trabajo.
import { cuandoFue } from "./actividadDelTurno";

export type EstadoDeOrden = "abierta" | "en_progreso" | "completada" | "cancelada";
export type PrioridadDeOrden = "baja" | "media" | "alta" | "urgente";
export type TipoDeOrden = "correctivo" | "preventivo";

export interface FilaDeOrden {
  id: number;
  equipo_id: number | null;
  placa_codigo: string | null;
  equipo_tipo: string | null;
  activo_texto: string | null;
  titulo: string;
  tipo: TipoDeOrden;
  prioridad: PrioridadDeOrden;
  estado: EstadoDeOrden;
  origen?: "manual" | "checklist";
  checklist_id?: number | null;
  iperc_id: number | null;
  iperc_estado: string | null;
  area: string | null;
  asignado_a: string | null;
  asignado_a_nombre: string | null;
  fecha_programada: string | null;
  creado_en: string;
  /** Se completó con la regla de conformidad encendida. */
  requiere_conformidad?: boolean;
  conformidad_en?: string | null;
  conformidad_por_nombre?: string | null;
}

export interface DetalleDeOrdenEnOficina extends Omit<
  FilaDeOrden,
  "equipo_tipo" | "iperc_estado" | "area"
> {
  descripcion: string | null;
  creado_por_nombre: string;
  inicio_en: string | null;
  fecha_cierre: string | null;
  observaciones_cierre: string | null;
  duracion_minutos: number | null;
  unidad_no_opera: boolean;
  tareas: { id: number; descripcion: string; hecha: boolean }[];
}

export interface CifrasDeOrdenes {
  abiertas: number;
  en_progreso: number;
  urgentes: number;
  sin_asignar: number;
  completadas_del_mes: number;
}

export interface MecanicoConCarga {
  id: string;
  nombre: string;
  ordenes: { id: number; titulo: string }[];
}

export const ESTADO_DE_ORDEN: Record<EstadoDeOrden, { texto: string; clase: string }> = {
  abierta: { texto: "Abierta", clase: "bg-blue-50 text-blue-700" },
  en_progreso: { texto: "En progreso", clase: "bg-amber-100 text-amber-700" },
  completada: { texto: "Completada", clase: "bg-emerald-100 text-emerald-700" },
  cancelada: { texto: "Cancelada", clase: "bg-slate-100 text-slate-600" },
};

export const PRIORIDAD: Record<PrioridadDeOrden, { texto: string; clase: string }> = {
  urgente: { texto: "Urgente", clase: "bg-red-100 text-red-700" },
  alta: { texto: "Alta", clase: "bg-amber-100 text-amber-700" },
  media: { texto: "Media", clase: "bg-blue-50 text-blue-700" },
  baja: { texto: "Baja", clase: "bg-slate-100 text-slate-600" },
};

export const TIPO: Record<TipoDeOrden, string> = {
  correctivo: "Correctivo",
  preventivo: "Preventivo",
};

/** El valor del filtro de mecánico que pide las órdenes sin nadie. */
export const SIN_ASIGNAR = "sin_asignar";

export interface FiltrosDeOrdenes {
  busqueda: string;
  estado: EstadoDeOrden | "";
  tipo: TipoDeOrden | "";
  /** "" = todos, SIN_ASIGNAR o el id de un mecánico. */
  mecanico: string;
  area: string;
  porConformar: boolean;
}

export const SIN_FILTROS_DE_ORDENES: FiltrosDeOrdenes = {
  busqueda: "",
  estado: "",
  tipo: "",
  mecanico: "",
  area: "",
  porConformar: false,
};

export const ORDENES_POR_PAGINA = 25;

export function consultaDeOrdenes(f: FiltrosDeOrdenes, pagina: number): string {
  const q = new URLSearchParams({ page: String(pagina), pageSize: String(ORDENES_POR_PAGINA) });
  if (f.busqueda.trim()) q.set("q", f.busqueda.trim());
  if (f.estado) q.set("estado", f.estado);
  if (f.tipo) q.set("tipo", f.tipo);
  if (f.mecanico === SIN_ASIGNAR) q.set("sin_asignar", "true");
  else if (f.mecanico) q.set("asignado_a", f.mecanico);
  if (f.area) q.set("area_id", f.area);
  if (f.porConformar) q.set("por_conformar", "true");
  return `?${q}`;
}

export const unidadDeLaOrden = (o: { placa_codigo: string | null; activo_texto: string | null }) =>
  [o.placa_codigo, o.activo_texto].filter(Boolean).join(" · ") || "—";

export const origenDeLaOrden = (o: { origen?: string; checklist_id?: number | null }) =>
  o.origen === "checklist" ? `Checklist${o.checklist_id ? ` #${o.checklist_id}` : ""}` : "Manual";

/** «15/01/2026» desde una fecha sin hora: no se pasa por la zona horaria. */
export const fechaProgramada = (f: string | null) =>
  f ? f.slice(0, 10).split("-").reverse().join("/") : null;

export const estaAbierta = (estado: EstadoDeOrden) =>
  estado === "abierta" || estado === "en_progreso";

export type ClaveDePaso = "origen" | "mecanico" | "iperc" | "trabajo" | "cierre" | "liberacion";

/** Completada y todavía sin la conformidad. `exigida` es false con la regla apagada: la unidad ya está libre. */
export const faltaConformidad = (
  o: { estado: EstadoDeOrden; requiere_conformidad?: boolean; conformidad_en?: string | null },
  exigida = true
) => exigida && o.estado === "completada" && !!o.requiere_conformidad && !o.conformidad_en;

export interface Paso {
  clave: ClaveDePaso;
  titulo: string;
  detalle: string;
  estado: "hecho" | "pendiente" | "opcional";
  /** El primero que falta. */
  actual: boolean;
}

/** El recorrido de una orden, como la maqueta. `iperc` es null sin ese módulo (no hay paso). */
export function pasosDeLaOrden(
  o: DetalleDeOrdenEnOficina,
  iperc: { estado: string | null } | null,
  ahora = new Date()
): Paso[] {
  const paso = (clave: ClaveDePaso, titulo: string, detalle: string, estado: Paso["estado"]) => ({
    clave,
    titulo,
    detalle,
    estado,
    actual: false,
  });
  const cerrada = !estaAbierta(o.estado);
  const pasos: Paso[] = [
    paso(
      "origen",
      o.origen === "checklist" ? "Falla reportada" : "Orden creada",
      `${origenDeLaOrden(o)} · ${cuandoFue(o.creado_en, ahora)}`,
      "hecho"
    ),
    paso(
      "mecanico",
      "Mecánico asignado",
      o.asignado_a_nombre ?? "Falta asignar",
      o.asignado_a ? "hecho" : "pendiente"
    ),
  ];
  if (iperc) {
    const autorizado = iperc.estado === "aprobado";
    pasos.push(
      paso(
        "iperc",
        autorizado ? "IPERC autorizado" : "IPERC recomendado",
        autorizado ? "Autorizado" : "No bloquea el inicio",
        autorizado ? "hecho" : "opcional"
      )
    );
  }
  const iniciada = o.estado === "en_progreso" || o.estado === "completada" || !!o.inicio_en;
  pasos.push(
    paso(
      "trabajo",
      "Trabajo iniciado",
      o.inicio_en ? cuandoFue(o.inicio_en, ahora) : iniciada ? "En curso" : "Pendiente",
      iniciada ? "hecho" : "pendiente"
    ),
    paso(
      "cierre",
      o.estado === "cancelada" ? "Orden cancelada" : "Orden completada",
      o.fecha_cierre ? cuandoFue(o.fecha_cierre, ahora) : "Pendiente",
      cerrada ? "hecho" : "pendiente"
    )
  );
  if (o.estado === "completada" && o.requiere_conformidad) {
    pasos.push(
      paso(
        "liberacion",
        "Prueba y liberación",
        o.conformidad_en
          ? [o.conformidad_por_nombre, cuandoFue(o.conformidad_en, ahora)]
              .filter(Boolean)
              .join(" · ")
          : "Pendiente de conformidad",
        o.conformidad_en ? "hecho" : "pendiente"
      )
    );
  }
  // En una orden cerrada solo puede faltar la conformidad: lo que no se hizo queda como estaba.
  const actual = cerrada
    ? pasos.find((p) => p.clave === "liberacion" && p.estado === "pendiente")
    : pasos.find((p) => p.estado === "pendiente");
  if (actual) actual.actual = true;
  return pasos;
}

/** Los mecánicos que coinciden, de menor a mayor carga, sin contar la orden que se está asignando. */
export function mecanicosParaAsignar(lista: MecanicoConCarga[], orden: number, texto: string) {
  const t = texto.trim().toLowerCase();
  return lista
    .map((m) => ({ ...m, ordenes: m.ordenes.filter((o) => o.id !== orden) }))
    .filter((m) => m.nombre.toLowerCase().includes(t))
    .sort((a, b) => a.ordenes.length - b.ordenes.length || a.nombre.localeCompare(b.nombre));
}

export const cargaDelMecanico = (n: number) =>
  n === 0 ? "Libre" : `${n} ${n === 1 ? "orden abierta" : "órdenes abiertas"}`;
