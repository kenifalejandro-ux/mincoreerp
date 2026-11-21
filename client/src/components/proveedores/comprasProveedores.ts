// client/src/components/proveedores/comprasProveedores.ts
//
// Lógica pura de «Compras y recepciones»: etiquetas, totales y la lectura de la diferencia. Sin React ni
// red. El estado de la compra y la diferencia contra el documento los resuelve el servidor (son los de
// Combustible → Cisternas); acá solo se presentan.
import type { CompraDeCisterna, EstadoCompra } from "./proveedoresApi";

export const ETIQUETA_ESTADO: Record<EstadoCompra, string> = {
  registrada: "Registrada",
  por_llegar: "Por llegar",
  recibida: "Recibida",
  anulada: "Anulada",
};

export const ETIQUETA_DOCUMENTO: Record<string, string> = {
  factura: "Factura",
  guia_remision: "Guía de remisión",
};

export interface TotalesCompras {
  porLlegar: number;
  recibidas: number;
  conDiferencia: number;
  anuladas: number;
}

export function totalesCompras(compras: CompraDeCisterna[]): TotalesCompras {
  return {
    porLlegar: compras.filter((c) => c.estado === "por_llegar").length,
    recibidas: compras.filter((c) => c.estado === "recibida").length,
    conDiferencia: compras.filter((c) => c.recepcion?.fueraDeTolerancia).length,
    anuladas: compras.filter((c) => c.estado === "anulada").length,
  };
}

export function formatoCantidad(cantidad: number, unidad: string): string {
  return `${cantidad.toLocaleString("es-PE", { maximumFractionDigits: 2 })} ${unidad}`;
}

export function formatoSoles(monto: number): string {
  return `S/ ${monto.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** «2026-11-12» → «12/11/2026». Las fechas de compra vienen sin hora: no se pasan por `Date`. */
export function formatoDia(dia: string): string {
  const [a, m, d] = dia.split("-");
  return `${d}/${m}/${a}`;
}

export type LecturaDeDiferencia = {
  texto: string;
  /** `neutra`: sin diferencia; `aviso`: hay diferencia pero dentro de la tolerancia; `alerta`: fuera. */
  tono: "neutra" | "aviso" | "alerta";
};

/** Lo que se dice de una recepción contra el documento. */
export function lecturaDeDiferencia(
  r: NonNullable<CompraDeCisterna["recepcion"]>
): LecturaDeDiferencia {
  const d = r.diferenciaGalones;
  if (Math.abs(d) < 0.005) return { texto: "Sin diferencia", tono: "neutra" };
  const signo = d > 0 ? "+" : "−";
  const base = `${signo}${Math.abs(d).toLocaleString("es-PE", { maximumFractionDigits: 2 })} gal`;
  return r.fueraDeTolerancia
    ? { texto: `${base} · fuera de tolerancia`, tono: "alerta" }
    : { texto: `${base} · dentro de tolerancia`, tono: "aviso" };
}
