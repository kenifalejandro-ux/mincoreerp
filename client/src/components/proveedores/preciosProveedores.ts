// client/src/components/proveedores/preciosProveedores.ts
//
// Lógica pura de «Gestión comercial»: variación, antigüedad, mejor precio y los totales. Sin React ni
// red. Las reglas del precio vigente (el más reciente no anulado cuya fecha ya llegó) las resuelve el
// servidor; acá solo se presentan.
import type { FilaPrecio } from "./proveedoresApi";

/** Pasados estos días sin cambios, la antigüedad del precio se marca (igual que la pantalla Precios). */
export const DIAS_PRECIO_VIEJO = 7;
/** Una subida de este porcentaje o más se cuenta aparte. */
export const SUBIDA_RELEVANTE_PCT = 5;

const MS_DIA = 86_400_000;

/** Variación del vigente frente al anterior, en %; `null` si no hay con qué comparar. */
export function variacionPct(fila: FilaPrecio): number | null {
  if (!fila.vigente || !fila.anterior || fila.anterior.precio === 0) return null;
  return ((fila.vigente.precio - fila.anterior.precio) / fila.anterior.precio) * 100;
}

/** Días completos desde que rige el precio (0 si rige desde hoy). */
export function diasDesde(iso: string, ahora: number): number {
  return Math.max(0, Math.floor((ahora - new Date(iso).getTime()) / MS_DIA));
}

export function textoAntiguedad(dias: number): string {
  return dias === 0 ? "desde hoy" : dias === 1 ? "hace 1 día" : `hace ${dias} días`;
}

export function formatoPrecio(precio: number): string {
  return `S/ ${precio.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

export function formatoFecha(iso: string): string {
  return new Date(iso).toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Lima",
  });
}

/** Las claves de las filas con el precio más bajo de su producto, cuando hay dos o más proveedores con
 *  precio vigente para él. Solo compara proveedores activos. */
export function clavesConMejorPrecio(filas: FilaPrecio[]): Set<string> {
  const grupos = new Map<string, FilaPrecio[]>();
  for (const f of filas) {
    if (!f.vigente || !f.proveedorActivo) continue;
    const grupo = `${f.producto}|${f.codigo}`;
    grupos.set(grupo, [...(grupos.get(grupo) ?? []), f]);
  }
  const mejores = new Set<string>();
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    const minimo = Math.min(...grupo.map((f) => f.vigente!.precio));
    for (const f of grupo) if (f.vigente!.precio === minimo) mejores.add(f.clave);
  }
  return mejores;
}

export interface TotalesPrecios {
  conPrecio: number;
  sinPrecio: number;
  programados: number;
  subieron: number;
}

export function totales(filas: FilaPrecio[]): TotalesPrecios {
  return {
    conPrecio: filas.filter((f) => f.vigente).length,
    sinPrecio: filas.filter((f) => !f.vigente && f.proveedorActivo).length,
    programados: filas.filter((f) => f.programado).length,
    subieron: filas.filter((f) => (variacionPct(f) ?? 0) >= SUBIDA_RELEVANTE_PCT).length,
  };
}
