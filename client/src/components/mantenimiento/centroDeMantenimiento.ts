// client/src/components/mantenimiento/centroDeMantenimiento.ts
//
// La lógica del Centro de control, sin React: qué pide atención, cómo se resume cada área y cómo se reparten las
// órdenes del mes. Un bloque en `null` es un módulo que la persona no tiene: no aparece, no vale cero.
import { ESTADOS, SIN_AREA } from "./equiposMantenimiento";
import type { AreaDelCentro, Aviso, ResumenMantenimiento } from "./mantenimientoApi";

/** El saludo del Centro según la hora (0-23). */
export function saludoSegunHora(hora: number): string {
  if (hora < 12) return "Buenos días";
  if (hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

/** «24 de noviembre de 2026». */
export function fechaLarga(fecha: Date): string {
  return fecha.toLocaleDateString("es-PE", { day: "numeric", month: "long", year: "numeric" });
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Porcentaje entero; sin total es 0, nunca una división por cero. */
export const porcentaje = (parte: number, total: number) =>
  total > 0 ? Math.round((parte / total) * 100) : 0;

/** «1 detenida · 2 en mantenimiento», para la tarjeta y el panel de la flota. */
export function notaDeEstados({ detenidas, en_mantenimiento }: ResumenMantenimiento["estados"]) {
  const partes = [];
  if (detenidas > 0) partes.push(plural(detenidas, "detenida", "detenidas"));
  if (en_mantenimiento > 0) partes.push(`${en_mantenimiento} en mantenimiento`);
  return partes.join(" · ") || "Ninguna detenida ni en mantenimiento";
}

export const notaDeUrgentes = (urgentes: number) =>
  urgentes > 0 ? plural(urgentes, "urgente", "urgentes") : "Ninguna urgente";

export const notaDeSinChecklist = (faltan: number) =>
  faltan > 0
    ? plural(faltan, "unidad sin checklist", "unidades sin checklist")
    : "Ninguna pendiente";

/** A dónde lleva un aviso: a una sección del ecosistema o a un módulo del ERP. */
export type DestinoDelCentro =
  { seccion: "equipos" } | { modulo: "checklists" | "ordenes_trabajo" };

export interface AvisoDelCentro {
  id: string;
  /** El ícono que pinta el recuadro de color. */
  icono: "orden" | "checklist" | "reloj" | "operaciones" | "area";
  tono: "red" | "amber" | "blue";
  titulo: string;
  detalle: string;
  /** Texto del botón. */
  accion: string;
  destino: DestinoDelCentro;
}

/** Los casos nombrados y, si hay más de los que caben, cuántos faltan. */
function nombrar<T>(aviso: Aviso<T>, texto: (caso: T) => string, separador: string) {
  const nombrados = aviso.casos.map(texto).join(separador);
  const resto = aviso.total - aviso.casos.length;
  return resto > 0 ? `${nombrados} y ${resto} más` : nombrados;
}

const unidadYFallas = (c: { unidad: string | null; fallas: string | null }) =>
  [c.unidad, c.fallas].filter(Boolean).join(": ");

/** Lo que pide atención, de lo más urgente a lo administrativo. `puedeAsignar`: la persona puede cambiar
 *  órdenes; quien solo mira recibe «Ver órdenes». */
export function avisosDelCentro(
  resumen: Pick<ResumenMantenimiento, "sin_area" | "por_importar" | "ordenes" | "checklists">,
  puedeAsignar = false
): AvisoDelCentro[] {
  const avisos: AvisoDelCentro[] = [];
  const sinMecanico = resumen.ordenes?.sin_mecanico;
  if (sinMecanico && sinMecanico.total > 0) {
    const { total, urgentes } = sinMecanico;
    avisos.push({
      id: "sin-mecanico",
      icono: "orden",
      tono: urgentes > 0 ? "red" : "amber",
      titulo:
        `${plural(total, "orden", "órdenes")} sin mecánico asignado` +
        (urgentes > 0 ? ` (${notaDeUrgentes(urgentes)})` : ""),
      detalle: nombrar(
        sinMecanico,
        (o) =>
          [`OT #${o.id}`, o.unidad, o.titulo, o.urgente ? "urgente" : null]
            .filter(Boolean)
            .join(" · "),
        "; "
      ),
      accion: puedeAsignar ? "Asignar" : "Ver órdenes",
      destino: { modulo: "ordenes_trabajo" },
    });
  }
  const ck = resumen.checklists;
  if (ck && ck.no_aptos_hoy.total > 0) {
    avisos.push({
      id: "no-aptos",
      icono: "checklist",
      tono: "red",
      titulo: `${plural(ck.no_aptos_hoy.total, "checklist", "checklists")} «No apta» hoy`,
      detalle: nombrar(ck.no_aptos_hoy, unidadYFallas, "; "),
      accion: "Ver checklists",
      destino: { modulo: "checklists" },
    });
  }
  if (ck && ck.por_autorizar.total > 0) {
    avisos.push({
      id: "por-autorizar",
      icono: "checklist",
      tono: "amber",
      titulo: plural(ck.por_autorizar.total, "salida por autorizar", "salidas por autorizar"),
      detalle: nombrar(ck.por_autorizar, unidadYFallas, "; "),
      accion: "Ver checklists",
      destino: { modulo: "checklists" },
    });
  }
  if (ck && ck.sin_checklist_hoy.total > 0) {
    avisos.push({
      id: "sin-checklist",
      icono: "reloj",
      tono: "amber",
      titulo: `${notaDeSinChecklist(ck.sin_checklist_hoy.total)} hoy`,
      detalle: nombrar(ck.sin_checklist_hoy, (placa) => placa, ", "),
      accion: "Ver unidades",
      destino: { seccion: "equipos" },
    });
  }
  if (resumen.por_importar > 0) {
    avisos.push({
      id: "por-importar",
      icono: "operaciones",
      tono: "blue",
      titulo: `${plural(resumen.por_importar, "unidad de Operaciones", "unidades de Operaciones")} por completar`,
      detalle: "Ya están en Equipos; falta darles su área y su propiedad.",
      accion: "Revisar e importar",
      destino: { seccion: "equipos" },
    });
  }
  if (resumen.sin_area > 0) {
    avisos.push({
      id: "sin-area",
      icono: "area",
      tono: "amber",
      titulo: `${plural(resumen.sin_area, "equipo", "equipos")} sin área`,
      detalle: "Asígnales un área para ver dónde trabajan.",
      accion: "Ver equipos",
      destino: { seccion: "equipos" },
    });
  }
  return avisos;
}

export type Tono = "green" | "amber" | "red" | "blue";
/** El recuadro de color detrás de un ícono. */
export const TONOS: Record<Tono, string> = {
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  red: "bg-red-50 text-red-600",
  blue: "bg-blue-50 text-blue-600",
};

export type TonoDeArea = "green" | "amber" | "red";

/** Verde si cumple la meta, ámbar si le faltan hasta 15 puntos, rojo si le faltan más. */
export const tonoDeArea = (disponibilidad: number, meta: number): TonoDeArea =>
  disponibilidad >= meta ? "green" : disponibilidad >= meta - 15 ? "amber" : "red";

export type ColorDeBarra = "operativa" | "en_mantenimiento" | "detenida" | "alquilada";

export interface Barra {
  color: ColorDeBarra;
  /** Cuántas unidades representa (su ancho). */
  peso: number;
  titulo: string;
}

/** Hasta aquí cada unidad tiene su barra; con más, no caben y se juntan por color. */
export const MAXIMO_DE_BARRAS = 30;

const NOMBRE_DE_COLOR: Record<ColorDeBarra, string> = {
  operativa: "operativas",
  en_mantenimiento: "en mantenimiento",
  detenida: "detenidas",
  alquilada: "alquiladas",
};

/** Las alquiladas van en gris, como en la maqueta; las demás, del color de su estado. */
export function barrasDeArea(unidades: AreaDelCentro["unidades"]): Barra[] {
  const color = (u: AreaDelCentro["unidades"][number]): ColorDeBarra =>
    u.alquilada ? "alquilada" : u.estado;
  if (unidades.length <= MAXIMO_DE_BARRAS) {
    return unidades.map((u) => ({
      color: color(u),
      peso: 1,
      titulo: [u.placa, ESTADOS[u.estado].texto, u.alquilada ? "Alquilada" : null]
        .filter(Boolean)
        .join(" · "),
    }));
  }
  return (Object.keys(NOMBRE_DE_COLOR) as ColorDeBarra[])
    .map((c) => ({ color: c, peso: unidades.filter((u) => color(u) === c).length }))
    .filter((b) => b.peso > 0)
    .map((b) => ({ ...b, titulo: `${b.peso} ${NOMBRE_DE_COLOR[b.color]}` }));
}

export interface ResumenDeArea {
  clave: string;
  /** El nombre con que Equipos filtra por esa área. */
  nombre: string;
  disponibilidad: number;
  tono: TonoDeArea;
  /** «4 equipos». */
  equipos: string;
  /** «1 detenido», o null si ninguno. */
  detenidos: string | null;
  /** «2 en taller», o null si ninguno. */
  enTaller: string | null;
  barras: Barra[];
}

export function resumenDeArea(area: AreaDelCentro, meta: number): ResumenDeArea {
  const cuantas = (estado: string) => area.unidades.filter((u) => u.estado === estado).length;
  const total = area.unidades.length;
  const disponibilidad = porcentaje(cuantas("operativa"), total);
  const detenidas = cuantas("detenida");
  const enTaller = cuantas("en_mantenimiento");
  return {
    clave: String(area.area_id ?? "sin_area"),
    nombre: area.nombre ?? SIN_AREA,
    disponibilidad,
    tono: tonoDeArea(disponibilidad, meta),
    equipos: plural(total, "equipo", "equipos"),
    detenidos: detenidas > 0 ? plural(detenidas, "detenido", "detenidos") : null,
    enTaller: enTaller > 0 ? `${enTaller} en taller` : null,
    barras: barrasDeArea(area.unidades),
  };
}

export const COLOR_CORRECTIVO = "#84cc16";
export const COLOR_PREVENTIVO = "#1768e4";

/** El anillo de «Órdenes por tipo»: cuántas hay este mes y cómo se reparte el círculo. */
export function anilloDeOrdenes({
  correctivo,
  preventivo,
}: {
  correctivo: number;
  preventivo: number;
}) {
  const total = correctivo + preventivo;
  const corte = porcentaje(correctivo, total);
  return {
    total,
    fondo:
      total === 0
        ? "#e2e8f0"
        : `conic-gradient(${COLOR_CORRECTIVO} 0 ${corte}%, ${COLOR_PREVENTIVO} ${corte}% 100%)`,
  };
}
