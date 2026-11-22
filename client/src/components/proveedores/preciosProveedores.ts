// client/src/components/proveedores/preciosProveedores.ts
//
// Lógica pura de «Gestión comercial»: variación, antigüedad, mejor precio y los totales. Sin React ni
// red. Las reglas del precio vigente (el más reciente no anulado cuya fecha ya llegó) las resuelve el
// servidor; acá solo se presentan.
import type { FilaPrecio, UsoDePrecio } from "./proveedoresApi";

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

/** Los días que faltan para una fecha (AAAA-MM-DD), contando desde hoy en Lima: negativo si ya pasó, 0 si es hoy. */
export function diasParaVencer(hasta: string, ahora: number): number {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(ahora);
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / MS_DIA);
}

/** Una fecha AAAA-MM-DD como DD/MM/AAAA, sin pasar por `Date` (no se corre un día por la zona horaria). */
export function formatoDia(dia: string): string {
  const [a, m, d] = dia.split("-");
  return `${d}/${m}/${a}`;
}

/** Días para avisar «vence pronto» (los mismos de «Vencen en 30 días»). */
export const DIAS_AVISO_VENCIMIENTO = 30;

export type TonoDeVigencia = "vencido" | "pronto" | "normal";

/** Qué decir de la «vigencia hasta» de un precio: la fecha, cuánto falta y de qué color. `null` = sin fecha.
 *  Es solo una alerta: un precio vencido sigue siendo el vigente hasta que se cargue otro. */
export function estadoDeVigencia(
  hasta: string | null,
  ahora: number
): { fecha: string; texto: string; tono: TonoDeVigencia } | null {
  if (!hasta) return null;
  const dias = diasParaVencer(hasta, ahora);
  if (dias < 0)
    return {
      fecha: formatoDia(hasta),
      texto: dias === -1 ? "venció ayer" : `venció hace ${-dias} días`,
      tono: "vencido",
    };
  if (dias === 0) return { fecha: formatoDia(hasta), texto: "vence hoy", tono: "pronto" };
  return {
    fecha: formatoDia(hasta),
    texto: dias === 1 ? "vence mañana" : `vence en ${dias} días`,
    tono: dias <= DIAS_AVISO_VENCIMIENTO ? "pronto" : "normal",
  };
}

/** «Contado», «Crédito 30 días» o «—». */
export function textoCondicionDePago(c: FilaPrecio["condicionDePago"]): string {
  if (!c) return "—";
  if (c.formaPago === "contado") return "Contado";
  return `Crédito ${c.plazoPagoDias ?? "?"} días`;
}

export const ETIQUETA_DE_USO: Record<UsoDePrecio, string> = {
  interno: "Interno",
  externo: "Externo",
  ambos: "Interno y externo",
};

export type FiltroDeUso = "todos" | "externo" | "interno";

/** ¿Esta fila entra en el filtro de uso? «Interno y externo» entra en los dos. */
export function coincideConUso(uso: UsoDePrecio, filtro: FiltroDeUso): boolean {
  return filtro === "todos" || uso === "ambos" || uso === filtro;
}

export interface TotalesPrecios {
  conPrecio: number;
  sinPrecio: number;
  programados: number;
  subieron: number;
  /** Productos distintos que tienen al menos un proveedor con precio vigente. */
  productos: number;
  /** Con «vigencia hasta» dentro de los próximos 30 días (los ya vencidos no entran: son otra alerta). */
  vencenPronto: number;
  /** Con «vigencia hasta» ya pasada: siguen siendo el vigente, pero conviene renovarlos. */
  vencidos: number;
}

export function totales(filas: FilaPrecio[], ahora: number = Date.now()): TotalesPrecios {
  const dias = (f: FilaPrecio) =>
    f.vigente?.hasta ? diasParaVencer(f.vigente.hasta, ahora) : null;
  return {
    conPrecio: filas.filter((f) => f.vigente).length,
    sinPrecio: filas.filter((f) => !f.vigente && f.proveedorActivo).length,
    programados: filas.filter((f) => f.programado).length,
    subieron: filas.filter((f) => (variacionPct(f) ?? 0) >= SUBIDA_RELEVANTE_PCT).length,
    productos: new Set(filas.filter((f) => f.vigente).map((f) => `${f.producto}|${f.codigo}`)).size,
    vencenPronto: filas.filter((f) => {
      const d = dias(f);
      return d !== null && d >= 0 && d <= DIAS_AVISO_VENCIMIENTO;
    }).length,
    vencidos: filas.filter((f) => {
      const d = dias(f);
      return d !== null && d < 0;
    }).length,
  };
}
