// La lógica de la vista "Recepciones" de Cisternas, aparte de la pantalla para probarla con datos
// sueltos: en qué estado está cada recepción y cómo se dice lo que llegó contra lo que decía el
// documento.

/** Una fila de GET /recepciones de combustible (solo lo que esta vista usa). */
export interface RecepcionDeLista {
  id: string;
  producto: string;
  cantidad: string;
  cantidad_derivada: string;
  recibido_en: string;
  tipo_documento: string | null;
  numero_documento: string | null;
  tanque_nombre: string | null;
  tanque_unidad?: string | null;
  grifo_nombre: string;
  anulada_en: string | null;
  motivo_anulacion: string | null;
  anulada_por_nombre: string | null;
  registrada_por_nombre: string | null;
  requiere_validacion: boolean;
  validada_en: string | null;
  compra_id: string | null;
  compra_documento: string | null;
  compra_cantidad: string | null;
  compra_unidad: string | null;
  diferencia_compra_galones: string | null;
  /** La tolerancia de la empresa, en galones, para pintar la diferencia. */
  tolerancia_galones?: number | string | null;
}

export type EstadoDeRecepcion = "anulada" | "validada" | "por_validar" | "registrada";

export const ETIQUETA_ESTADO_RECEPCION: Record<EstadoDeRecepcion, string> = {
  anulada: "Anulada",
  validada: "Validada",
  por_validar: "Por validar",
  registrada: "Registrada",
};

/** Anulada manda sobre todo: una recepción anulada ya no cuenta, aunque se hubiera validado. */
export function estadoDeRecepcion(r: RecepcionDeLista): EstadoDeRecepcion {
  if (r.anulada_en) return "anulada";
  if (r.validada_en) return "validada";
  if (r.requiere_validacion) return "por_validar";
  return "registrada";
}

/** Lo que entregó la cisterna en total: lo que entró al tanque más lo que se derivó. */
export function totalEntregadoDeLaRecepcion(r: RecepcionDeLista): number {
  return Number(r.cantidad) + Number(r.cantidad_derivada);
}

/** La diferencia contra el documento de la compra, en palabras; null sin compra. `fuera` cuando
 *  supera la tolerancia (en galones). */
export function diferenciaDeLaRecepcion(
  r: RecepcionDeLista
): { texto: string; fuera: boolean } | null {
  if (r.diferencia_compra_galones == null) return null;
  const dif = Number(r.diferencia_compra_galones);
  if (!Number.isFinite(dif)) return null;
  const tolerancia = Number(r.tolerancia_galones ?? 3);
  if (dif === 0) return { texto: "Sin diferencia", fuera: false };
  const n = Math.abs(dif).toLocaleString("es-PE", { maximumFractionDigits: 3 });
  return {
    texto: `${dif > 0 ? "+" : "−"}${n} gal`,
    fuera: Math.abs(dif) > tolerancia,
  };
}

export type FiltroDeEstadoRecepcion = "todas" | EstadoDeRecepcion;

export function filtrarRecepciones(
  lista: RecepcionDeLista[],
  filtro: FiltroDeEstadoRecepcion
): RecepcionDeLista[] {
  return filtro === "todas" ? lista : lista.filter((r) => estadoDeRecepcion(r) === filtro);
}
