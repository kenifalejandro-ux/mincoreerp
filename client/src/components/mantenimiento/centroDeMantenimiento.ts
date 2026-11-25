// client/src/components/mantenimiento/centroDeMantenimiento.ts
//
// La lógica del Centro de control, sin React: cómo se reparten los equipos por área.
import { SIN_AREA } from "./equiposMantenimiento";
import type { ResumenMantenimiento } from "./mantenimientoApi";
import type { SeccionDeRuta } from "./rutaMantenimiento";

export interface FilaDeReparto {
  nombre: string;
  equipos: number;
  /** Ancho de la barra: 100 para el área con más equipos, el resto en proporción. */
  porcentaje: number;
}

/** Las áreas que tienen equipos, de más a menos (y por nombre si empatan), más «Sin área» si hay. Un área vacía
 *  no se dibuja: no reparte nada. */
export function repartoPorArea(
  resumen: Pick<ResumenMantenimiento, "areas" | "sin_area">
): FilaDeReparto[] {
  const filas = resumen.areas
    .filter((a) => a.equipos > 0)
    .map((a) => ({ nombre: a.nombre, equipos: a.equipos }));
  if (resumen.sin_area > 0) filas.push({ nombre: SIN_AREA, equipos: resumen.sin_area });
  filas.sort((a, b) => b.equipos - a.equipos || a.nombre.localeCompare(b.nombre, "es"));
  const mayor = Math.max(1, ...filas.map((f) => f.equipos));
  return filas.map((f) => ({ ...f, porcentaje: Math.round((f.equipos / mayor) * 100) }));
}

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

export interface AvisoDelCentro {
  id: string;
  /** El ícono que pinta el recuadro de color. */
  icono: "area" | "operaciones";
  tono: "amber" | "blue";
  titulo: string;
  detalle: string;
  /** Texto del botón y a qué sección lleva. */
  accion: string;
  destino: SeccionDeRuta;
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Lo que el Centro sabe hoy y pide atender: equipos sin área y unidades de Operaciones por completar. El resto
 *  (órdenes, checklists, preventivos) se suma cuando existan esos datos. */
export function avisosDelCentro(
  resumen: Pick<ResumenMantenimiento, "sin_area" | "por_importar" | "total">
): AvisoDelCentro[] {
  const avisos: AvisoDelCentro[] = [];
  if (resumen.por_importar > 0) {
    avisos.push({
      id: "por-importar",
      icono: "operaciones",
      tono: "blue",
      titulo: `${plural(resumen.por_importar, "unidad de Operaciones", "unidades de Operaciones")} por completar`,
      detalle: "Ya están en Equipos; falta darles su área y su propiedad.",
      accion: "Revisar e importar",
      destino: "equipos",
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
      destino: "equipos",
    });
  }
  return avisos;
}

/** «3 propios · 1 alquilado»: cómo se reparten los equipos entre propios y alquilados. */
export function propiosYAlquilados(propios: number, alquilados: number): string {
  return `${plural(propios, "propio", "propios")} · ${plural(alquilados, "alquilado", "alquilados")}`;
}
