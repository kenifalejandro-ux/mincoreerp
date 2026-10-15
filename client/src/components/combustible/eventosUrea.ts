// client/src/components/combustible/eventosUrea.ts
//
// Del stream de eventos al panel de Control de Urea, SIN abrir otra conexión.
//
// CombustiblePanel ya tiene su EventSource y UreaPanel vive dentro de él, así
// que acá solo se decide qué eventos le importan a urea y qué hay que volver a
// pedir con cada uno. CombustiblePanel los reenvía como un evento de window
// (mismo patrón que "combustible:actualizado") y UreaPanel lo escucha.
//
// El evento trae solo ids y, desde esta entrega, el producto: el cliente nunca
// recibe litros ni montos por acá, vuelve a pedir los datos por los endpoints
// que sí validan permiso.
//
// Vive en su propio archivo, sin React ni apiClient, para poder probarlo con
// el vitest de la raíz (tests/eventos-urea-cliente.test.ts).

/** Nombre del evento de window que UreaPanel escucha. */
export const EVENTO_UREA_EN_WINDOW = "urea:cambio";

export const EVENTOS_UREA = [
  "combustible.despacho_creado",
  "combustible.despacho_anulado",
  "combustible.comprobante_adjuntado",
  "combustible.recepcion_creada",
  "combustible.recepcion_anulada",
  "combustible.recepcion_validada",
  "combustible.urea_conteo_creado",
  "combustible.urea_conteo_anulado",
  "combustible.urea_presentaciones_cambiaron",
  "combustible.urea_precios_cambiaron",
  "combustible.config_actualizada",
  "combustible.alerta_creada",
  "combustible.alerta_resuelta",
  "combustible.alertas_actualizadas",
] as const;

export interface PlanDeRefresco {
  presentaciones: boolean;
  precios: boolean;
  estado: boolean;
  hallazgos: boolean;
  /** La vista activa, los movimientos recientes y el kardex abierto. */
  vista: boolean;
}

/** Un evento de otro producto no le toca a urea. Sin `producto` (los eventos
 *  que no lo llevan, o el payload vaciado de quien ve solo algunas plantas) NO
 *  se puede saber, y se refresca igual: pedir de más es barato, perderse un
 *  cambio no. */
export function esDeOtroProducto(dataCruda: unknown): boolean {
  if (typeof dataCruda !== "string" || dataCruda === "") return false;
  try {
    const data: unknown = JSON.parse(dataCruda);
    if (typeof data !== "object" || data === null) return false;
    const producto = (data as { producto?: unknown }).producto;
    return typeof producto === "string" && producto !== "urea";
  } catch {
    return false;
  }
}

/** Qué hay que volver a pedir según los tipos de evento que llegaron. */
export function planDeRefresco(tipos: Iterable<string>): PlanDeRefresco {
  const plan: PlanDeRefresco = {
    presentaciones: false,
    precios: false,
    estado: false,
    hallazgos: false,
    vista: false,
  };
  for (const tipo of tipos) {
    switch (tipo) {
      case "combustible.urea_precios_cambiaron":
        plan.precios = true;
        break;
      case "combustible.urea_presentaciones_cambiaron":
        // Corregir los litros de un envase mueve el stock teórico.
        plan.presentaciones = true;
        plan.estado = true;
        plan.vista = true;
        break;
      case "combustible.config_actualizada":
        plan.estado = true;
        break;
      case "combustible.alerta_creada":
      case "combustible.alerta_resuelta":
      case "combustible.alertas_actualizadas":
        plan.hallazgos = true;
        break;
      default:
        plan.estado = true;
        plan.vista = true;
    }
  }
  return plan;
}

/** CombustiblePanel la llama por cada evento del stream. Descarta el de otro
 *  producto y reenvía el resto a UreaPanel. */
export function avisarCambioDeUrea(tipo: string, dataCruda: unknown): void {
  if (esDeOtroProducto(dataCruda)) return;
  window.dispatchEvent(new CustomEvent(EVENTO_UREA_EN_WINDOW, { detail: { tipo } }));
}
