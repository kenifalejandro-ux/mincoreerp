/** src/modules/equipos/equipos.estado.ts
 *
 *  Qué significa "Activo" en Equipos: la unidad tiene un conductor vigente.
 *  Bombonas y carretas no se manejan solas, así que no piden conductor y
 *  siempre figuran activas. Una unidad dada de baja (activo = false) es
 *  "Inactivo". El cliente tiene su espejo en client/src/components/equipos/
 *  equiposVista.ts: si cambia una regla, cambian las dos. */

export type EstadoUnidad = "Activo" | "Sin asignar" | "Inactivo";

export function tipoLlevaConductor(tipo: string): boolean {
  const t = tipo.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  return !(t.startsWith("bombona") || t.startsWith("carreta"));
}

export function estadoDeUnidad(e: {
  activo: boolean;
  tipo: string;
  conductor_nombre: string | null;
  conductor_dni: string | null;
}): EstadoUnidad {
  if (!e.activo) return "Inactivo";
  if (!tipoLlevaConductor(e.tipo)) return "Activo";
  return e.conductor_nombre || e.conductor_dni ? "Activo" : "Sin asignar";
}
