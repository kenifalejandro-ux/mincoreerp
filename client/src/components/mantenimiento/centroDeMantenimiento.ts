// client/src/components/mantenimiento/centroDeMantenimiento.ts
//
// La lógica del Centro de control, sin React: cómo se reparten los equipos por área.
import { SIN_AREA } from "./equiposMantenimiento";
import type { ResumenMantenimiento } from "./mantenimientoApi";

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
