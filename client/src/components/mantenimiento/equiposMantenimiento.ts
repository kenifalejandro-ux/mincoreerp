// client/src/components/mantenimiento/equiposMantenimiento.ts
//
// La lógica de la lista de Equipos, sin React: filtrar en el cliente (la lista de una empresa son decenas o
// pocos cientos) y dar nombre a lo que viene de la API. Filtrar acá, y no pedirle la lista filtrada al
// servidor, deja el filtro instantáneo y hace que los desplegables de tipo y área sigan ofreciendo todo.
import type { EquipoMantenimiento, EstadoDeUnidad } from "./mantenimientoApi";

export const TODOS_LOS_TIPOS = "Todos los tipos";
export const TODAS_LAS_AREAS = "Todas las áreas";
export const SIN_AREA = "Sin área";

export const ESTADOS: Record<EstadoDeUnidad, { texto: string; clase: string; peso: number }> = {
  detenida: { texto: "Detenida", clase: "bg-red-100 text-red-700", peso: 0 },
  en_mantenimiento: { texto: "En mantenimiento", clase: "bg-amber-100 text-amber-700", peso: 1 },
  operativa: { texto: "Operativa", clase: "bg-emerald-100 text-emerald-600", peso: 2 },
};

/** Los filtros rápidos. «Alquiladas» mira la propiedad; los demás, el estado. */
export const FILTROS_DE_ESTADO = [
  { id: "todas", texto: "Todas" },
  { id: "detenida", texto: "Detenidas" },
  { id: "en_mantenimiento", texto: "En mantenimiento" },
  { id: "operativa", texto: "Operativas" },
  { id: "alquiladas", texto: "Alquiladas" },
] as const;
export type FiltroDeEstado = (typeof FILTROS_DE_ESTADO)[number]["id"];

export const estadoDe = (e: Pick<EquipoMantenimiento, "estado">): EstadoDeUnidad =>
  e.estado ?? "operativa";

const pasaElEstado = (e: EquipoMantenimiento, filtro: FiltroDeEstado) =>
  filtro === "todas" ||
  (filtro === "alquiladas" ? e.propiedad === "alquilada" : estadoDe(e) === filtro);

export const contarPorEstado = (equipos: EquipoMantenimiento[], filtro: FiltroDeEstado) =>
  equipos.filter((e) => pasaElEstado(e, filtro)).length;

export interface FiltrosDeEquipos {
  estado: FiltroDeEstado;
  busqueda: string;
  tipo: string;
  area: string;
}

export const FILTROS_VACIOS: FiltrosDeEquipos = {
  estado: "todas",
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
  const visibles = equipos.filter((e) => {
    if (!pasaElEstado(e, filtros.estado)) return false;
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
  // Las detenidas primero; dentro de cada estado se conserva el orden por placa que manda el servidor.
  return visibles.sort((a, b) => ESTADOS[estadoDe(a)].peso - ESTADOS[estadoDe(b)].peso);
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
