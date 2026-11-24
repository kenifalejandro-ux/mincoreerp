// client/src/components/mantenimiento/equiposMantenimiento.ts
//
// La lógica de la lista de Equipos, sin React: filtrar en el cliente (la lista de una empresa son decenas o
// pocos cientos) y dar nombre a lo que viene de la API. Filtrar acá, y no pedirle la lista filtrada al
// servidor, deja el filtro instantáneo y hace que los desplegables de tipo y área sigan ofreciendo todo.
import type { EquipoMantenimiento } from "./mantenimientoApi";

export const TODOS_LOS_TIPOS = "Todos los tipos";
export const TODAS_LAS_AREAS = "Todas las áreas";
export const SIN_AREA = "Sin área";

export interface FiltrosDeEquipos {
  busqueda: string;
  tipo: string;
  area: string;
}

export const FILTROS_VACIOS: FiltrosDeEquipos = {
  busqueda: "",
  tipo: TODOS_LOS_TIPOS,
  area: TODAS_LAS_AREAS,
};

const sinTildes = (texto: string) => texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function filtrarEquipos(
  equipos: EquipoMantenimiento[],
  filtros: FiltrosDeEquipos
): EquipoMantenimiento[] {
  const q = sinTildes(filtros.busqueda.trim());
  return equipos.filter((e) => {
    // «VOLQUETE» (Flota) y «Volquete» son el mismo tipo.
    if (filtros.tipo !== TODOS_LOS_TIPOS && sinTildes(e.tipo) !== sinTildes(filtros.tipo))
      return false;
    if (filtros.area === SIN_AREA && e.area_id !== null) return false;
    if (filtros.area !== TODAS_LAS_AREAS && filtros.area !== SIN_AREA && e.area !== filtros.area)
      return false;
    if (!q) return true;
    return sinTildes(
      [e.placa_codigo, e.tipo, e.marca, e.modelo, e.area].filter(Boolean).join(" ")
    ).includes(q);
  });
}

/** Las áreas que tienen algún equipo, en orden alfabético, más «Sin área» si hay equipos sin ella. */
export function areasDeLosEquipos(equipos: EquipoMantenimiento[]): string[] {
  const areas = [...new Set(equipos.map((e) => e.area).filter((a): a is string => !!a))].sort(
    (a, b) => a.localeCompare(b, "es")
  );
  return equipos.some((e) => e.area_id === null) ? [...areas, SIN_AREA] : areas;
}

/** «3,260 h» o «48,300 km», según con qué se mida el equipo. */
export function lecturaConUnidad(e: Pick<EquipoMantenimiento, "lectura" | "medidor">): string {
  const numero = e.lectura.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `${numero} ${e.medidor === "horometro" ? "h" : "km"}`;
}
