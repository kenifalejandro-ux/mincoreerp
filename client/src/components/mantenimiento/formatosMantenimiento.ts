// client/src/components/mantenimiento/formatosMantenimiento.ts
//
// La lógica de Checklists → Formatos, sin React: lo que la lista sabe de cada formato y qué unidades lo usan.
import type { EquipoMantenimiento } from "./mantenimientoApi";

export interface FilaDeFormato {
  id: number;
  nombre: string;
  /** null o vacío: uso general. */
  tipo_equipo: string | null;
  creado_en: string;
  version: number;
  activa: boolean;
  preguntas: number;
  criticas: number;
  /** null sin un módulo de unidades. */
  unidades: number | null;
  editado_en: string;
  editado_por_nombre: string | null;
}

export const tipoDelFormato = (f: Pick<FilaDeFormato, "tipo_equipo">) =>
  f.tipo_equipo?.trim() || "Uso general";

export const usoDelFormato = (unidades: number | null) =>
  unidades === null ? null : unidades === 1 ? "1 unidad lo usa" : `${unidades} unidades lo usan`;

/** Las unidades a las que les toca: las de su tipo (sin mirar mayúsculas), o todas si es de uso general. El
 *  mismo criterio con que el servidor las cuenta. */
export function unidadesDelFormato(
  f: Pick<FilaDeFormato, "tipo_equipo">,
  equipos: EquipoMantenimiento[]
) {
  const tipo = f.tipo_equipo?.trim().toLowerCase();
  return tipo ? equipos.filter((e) => e.tipo.trim().toLowerCase() === tipo) : equipos;
}

export const fechaDeEdicion = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
