// Cuánto se dibuja de la cisterna y de qué color. Aparte del componente para poder probarlo con
// números sueltos.
//
// El 100% de la cisterna es lo que quedó al recibir (la capacidad real del camión del proveedor
// no se conoce): el dibujo muestra cuánto queda de lo que sobró, no cuánto le cabe.

export { porcentajeDelNivel } from "./nivelTanqueta";

/** Cuánto del plazo pasó: a partir del 80% se avisa en ámbar, pasado el plazo en rojo. */
export type EstadoDelPlazo = "sin_plazo" | "en_plazo" | "por_vencer" | "vencido";

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Días enteros desde que la cisterna llegó. Una fecha ilegible o futura da 0. */
export function diasConSaldo(recibidoEn: string, ahora: number = Date.now()): number {
  const t = new Date(recibidoEn).getTime();
  if (!Number.isFinite(t) || t > ahora) return 0;
  return Math.floor((ahora - t) / MS_POR_DIA);
}

/** `plazoDias` ausente (el servidor no lo mandó) o inválido: no se pinta alerta. */
export function estadoDelPlazo(dias: number, plazoDias: number | null | undefined): EstadoDelPlazo {
  if (plazoDias == null || !Number.isFinite(plazoDias) || plazoDias <= 0) return "sin_plazo";
  if (dias > plazoDias) return "vencido";
  if (dias >= plazoDias * 0.8) return "por_vencer";
  return "en_plazo";
}

/** [base, claro (reflejo), oscuro (bordes), resplandor]. Cian mientras está en plazo; el color de
 *  alerta del plazo le gana al azul para que se note. */
export function coloresDeLaCisterna(
  plazo: EstadoDelPlazo
): [base: string, claro: string, oscuro: string, brillo: string] {
  if (plazo === "vencido") return ["#ef4444", "#fca5a5", "#7f1d1d", "rgba(239,68,68,0.4)"];
  if (plazo === "por_vencer") return ["#f59e0b", "#fde68a", "#78350f", "rgba(245,158,11,0.4)"];
  return ["#22d3ee", "#cffafe", "#155e75", "rgba(34,211,238,0.45)"];
}
