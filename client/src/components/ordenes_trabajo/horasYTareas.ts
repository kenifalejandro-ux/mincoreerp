// client/src/components/ordenes_trabajo/horasYTareas.ts
//
// Las horas y las tareas de una orden de trabajo, sin React: cómo se muestra la duración, cuándo unas horas
// no sirven y qué se manda al guardar.
import { paraInputLocal } from "../../utils/fechaLocal";

export interface Tarea {
  id: number;
  descripcion: string;
  hecha: boolean;
}

export const TOPE_DE_TAREAS = 50;

export function textoDeDuracion(minutos: number | null | undefined): string | null {
  if (minutos === null || minutos === undefined) return null;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  if (horas === 0) return `${resto} min`;
  return resto === 0 ? `${horas} h` : `${horas} h ${resto} min`;
}

/** Lo que va en un <input type="datetime-local">; vacío si no hay hora. */
export const horaParaInput = (iso: string | null | undefined) => (iso ? paraInputLocal(iso) : "");

const MARGEN_RELOJ_MS = 5 * 60 * 1000;

/** Por qué no sirven unas horas escritas (valores de datetime-local), o null. */
export function problemaDeHoras(inicio: string, cierre: string, ahora = Date.now()): string | null {
  const valores = [inicio, cierre].filter(Boolean).map((v) => new Date(v).getTime());
  if (valores.some((v) => Number.isNaN(v))) return "Revisa la fecha y la hora.";
  if (valores.some((v) => v < Date.UTC(2000, 0, 1))) return "Revisa el año de la hora.";
  if (valores.some((v) => v > ahora + MARGEN_RELOJ_MS)) return "La hora no puede ser futura.";
  if (inicio && cierre && new Date(inicio) > new Date(cierre)) {
    return "La hora de inicio no puede ser posterior a la de cierre.";
  }
  return null;
}

/** Solo las horas que la persona cambió: reenviar una sin tocar le quitaría los segundos. */
export function horasCambiadas(
  guardadas: { inicio_en: string | null; fecha_cierre: string | null },
  inicio: string,
  cierre: string
): { inicio_en?: string | null; fecha_cierre?: string } {
  const cambios: { inicio_en?: string | null; fecha_cierre?: string } = {};
  if (inicio !== horaParaInput(guardadas.inicio_en)) {
    cambios.inicio_en = inicio ? new Date(inicio).toISOString() : null;
  }
  // La de cierre se corrige, no se quita.
  if (cierre && cierre !== horaParaInput(guardadas.fecha_cierre)) {
    cambios.fecha_cierre = new Date(cierre).toISOString();
  }
  return cambios;
}

/** La lista con lo que quedó escrito en la casilla y no se llegó a agregar. */
export function conPendiente(tareas: string[], escrita: string): string[] {
  const limpia = escrita.trim();
  return limpia && tareas.length < TOPE_DE_TAREAS ? [...tareas, limpia] : tareas;
}
