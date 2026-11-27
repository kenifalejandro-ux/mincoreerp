// client/src/components/mantenimiento/planesFormulario.ts
//
// El formulario de un plan, sin React: con qué abre, qué le falta y qué se envía. Los límites son espejo de los
// del servidor (mantenimientoPlanes.schema.ts), que sigue siendo la barrera real.
import type { Medida, Nivel, PlanPreventivo } from "./planesPreventivo";

export const MAX_PASOS = 12;
export const MAX_INTERVALO = 1_000_000;
export const MAX_LINEAS = 40;
export const MAX_LARGO = 160;

export interface FormularioDePlan {
  tipo: string;
  medida: Medida;
  intervalo: string;
  /** Vacío al crear = el 10 % del intervalo. */
  aviso: string;
  ciclo: Nivel[];
  /** Una tarea o un repuesto por renglón. Se conservan aunque el nivel salga un momento del ciclo. */
  niveles: Record<Nivel, { tareas: string; repuestos: string }>;
}

export function formularioDelPlan(plan?: PlanPreventivo, tipo = ""): FormularioDePlan {
  const nivel = (n: Nivel) => ({
    tareas: plan?.niveles[`${n}`]?.tareas.join("\n") ?? "",
    repuestos: plan?.niveles[`${n}`]?.repuestos.join("\n") ?? "",
  });
  return {
    tipo: plan?.tipo_equipo ?? tipo,
    medida: plan?.medida ?? "horometro",
    intervalo: plan ? String(plan.intervalo) : "",
    aviso: plan ? String(plan.aviso_antes) : "",
    ciclo: plan ? [...plan.ciclo] : [1],
    niveles: { 1: nivel(1), 2: nivel(2), 3: nivel(3) },
  };
}

/** Los renglones escritos, sin los vacíos. */
export const renglones = (texto: string) =>
  texto
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r !== "");

/** Los niveles que usa el ciclo, de menor a mayor. */
export const nivelesDelCiclo = (ciclo: Nivel[]) =>
  ([1, 2, 3] as Nivel[]).filter((n) => ciclo.includes(n));

const entero = (texto: string) => (/^\d+$/.test(texto.trim()) ? Number(texto.trim()) : null);

/** El primer problema que impide guardar, o null. */
export function problemaDelPlan(f: FormularioDePlan, editando: boolean): string | null {
  if (!f.tipo.trim()) return "Escribe el tipo de equipo.";
  const intervalo = entero(f.intervalo);
  if (intervalo === null || intervalo < 1 || intervalo > MAX_INTERVALO) {
    return "El intervalo es un número entero entre 1 y 1,000,000.";
  }
  if (editando || f.aviso.trim() !== "") {
    const aviso = entero(f.aviso);
    if (aviso === null) return "El aviso es un número entero (0 si no quieres aviso).";
    if (aviso >= intervalo) return "El aviso tiene que ser menor que el intervalo.";
  }
  if (f.ciclo.length === 0) return "Agrega al menos un servicio al ciclo.";
  for (const n of nivelesDelCiclo(f.ciclo)) {
    const tareas = renglones(f.niveles[n].tareas);
    const repuestos = renglones(f.niveles[n].repuestos);
    if (tareas.length === 0) return `Escribe al menos una tarea del MP${n}.`;
    if (tareas.length > MAX_LINEAS || repuestos.length > MAX_LINEAS) {
      return `El MP${n} admite hasta ${MAX_LINEAS} renglones por lista.`;
    }
    if ([...tareas, ...repuestos].some((r) => r.length > MAX_LARGO)) {
      return `En el MP${n} hay un renglón de más de ${MAX_LARGO} caracteres.`;
    }
  }
  return null;
}

/** Lo que se envía: solo los niveles que usa el ciclo. Sin `aviso`, el servidor pone el 10 %. */
export function cuerpoDelPlan(f: FormularioDePlan) {
  return {
    tipo_equipo: f.tipo.trim(),
    medida: f.medida,
    intervalo: Number(f.intervalo),
    ...(f.aviso.trim() === "" ? {} : { aviso_antes: Number(f.aviso) }),
    ciclo: f.ciclo,
    niveles: Object.fromEntries(
      nivelesDelCiclo(f.ciclo).map((n) => [
        `${n}`,
        {
          tareas: renglones(f.niveles[n].tareas),
          repuestos: renglones(f.niveles[n].repuestos),
        },
      ])
    ),
  };
}
export type CuerpoDelPlan = ReturnType<typeof cuerpoDelPlan>;
