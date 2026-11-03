/** src/modules/combustible/alertasPorModulo.ts
 *
 * A qué módulo "pertenece" cada alerta. Todas viven en `combustible_alertas`, pero no
 * todas son de Combustible: las de urea salen del almacén de Urea y las de viaje demorado
 * o detenido son de Gestión operacional de flota (módulo `viajes`).
 *
 * Las de viaje solo las ve quien tiene el módulo `viajes`: sin esto, un operador de una
 * empresa que no contrató Viajes recibiría avisos de un módulo que no tiene. Urea sigue
 * dentro de Combustible (su inventario y su permiso son los de Combustible).
 */

/** Los tipos de alerta de Gestión operacional de flota (migración 0156). */
export const TIPOS_DE_ALERTA_DE_FLOTA: readonly string[] = ["viaje_demorado", "viaje_detenido"];

export type GrupoDeAlerta = "combustible" | "urea" | "flota";

export function grupoDeAlerta(tipo: string): GrupoDeAlerta {
  if (TIPOS_DE_ALERTA_DE_FLOTA.includes(tipo)) return "flota";
  if (tipo.startsWith("urea_")) return "urea";
  return "combustible";
}

/** Los tipos de alerta que este usuario NO debe ver por no tener el módulo dueño. */
export function tiposSinModulo(modulosPermitidos: string[] | undefined): string[] | undefined {
  // Sin la lista de módulos (el resumen por correo no la trae) no se recorta nada.
  if (!modulosPermitidos) return undefined;
  return modulosPermitidos.includes("viajes") ? undefined : [...TIPOS_DE_ALERTA_DE_FLOTA];
}
