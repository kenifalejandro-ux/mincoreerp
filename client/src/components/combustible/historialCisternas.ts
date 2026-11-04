// La lógica del Historial de cisternas, aparte de la pantalla para probarla con datos sueltos: qué
// proveedores se pueden filtrar, cómo se filtra y cuánto duró una cisterna que ya se vació.
import type { CisternaDeLista, SalidaDeCisterna } from "./cisternasTipos";

export const QUE_ES: Record<SalidaDeCisterna["tipo"], string> = {
  unidad: "Unidad",
  tanqueta: "Tanqueta",
  tanque: "Tanque",
};

export type FiltroEstado = "todas" | "vaciada" | "anulada";

/** El valor del filtro de proveedor para una cisterna sin proveedor; "" es "todos". */
export const SIN_PROVEEDOR = "sin";

const valorDeProveedor = (c: CisternaDeLista): string =>
  c.proveedor_id == null ? SIN_PROVEEDOR : String(c.proveedor_id);

/** Los proveedores que aparecen en la lista, sin repetir y por nombre. Salen de lo que ya se
 *  cargó: un proveedor sin cisternas en el historial no tiene nada que filtrar. */
export function proveedoresDe(lista: CisternaDeLista[]): { valor: string; nombre: string }[] {
  const vistos = new Map<string, string>();
  for (const c of lista) vistos.set(valorDeProveedor(c), c.proveedor ?? "Sin proveedor");
  return [...vistos]
    .map(([valor, nombre]) => ({ valor, nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/** Se filtra acá y no en el servidor: son pocas por empresa y así cambiar el filtro rápido no puede
 *  dejar pintada la respuesta de uno anterior. */
export function filtrarHistorial(
  lista: CisternaDeLista[],
  proveedor: string,
  estado: FiltroEstado
): CisternaDeLista[] {
  return lista.filter(
    (c) =>
      (proveedor === "" || valorDeProveedor(c) === proveedor) &&
      (estado === "todas" || c.estado === estado)
  );
}

/** La fecha de la última salida, o null si no salió nada. */
export function fechaDeLaUltimaSalida(c: CisternaDeLista): string | null {
  let ultima: string | null = null;
  for (const s of c.salidas ?? []) {
    if (!Number.isFinite(new Date(s.fecha).getTime())) continue;
    if (ultima === null || new Date(s.fecha) > new Date(ultima)) ultima = s.fecha;
  }
  return ultima;
}

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Cuántos días pasaron entre que llegó y que salió lo último. null si no salió nada o las fechas
 *  no sirven. Una salida anterior a la llegada (fechas cargadas a mano) da 0, no un negativo. */
export function diasQueDuro(c: CisternaDeLista): number | null {
  const ultima = fechaDeLaUltimaSalida(c);
  if (ultima === null) return null;
  const llego = new Date(c.recibido_en).getTime();
  if (!Number.isFinite(llego)) return null;
  return Math.max(0, Math.floor((new Date(ultima).getTime() - llego) / MS_POR_DIA));
}
