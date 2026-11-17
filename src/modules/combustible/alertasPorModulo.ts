/** src/modules/combustible/alertasPorModulo.ts
 *
 * A qué módulo "pertenece" cada alerta. Las de urea salen del almacén de Urea y viven en
 * `combustible_alertas`; las de viaje (demorado, detenido, creado por el conductor) son de
 * Gestión operacional de flota (módulo `viajes`) y desde la migración 0188 viven en su propia
 * tabla, `viaje_alertas`. Urea sigue dentro de Combustible (su inventario y su permiso son los de
 * Combustible).
 */

/** Los tipos de alerta de Gestión operacional de flota (migración 0156). */
export const TIPOS_DE_ALERTA_DE_FLOTA: readonly string[] = [
  "viaje_demorado",
  "viaje_detenido",
  // 0179: el conductor creó su propio viaje desde el celular.
  "viaje_creado_por_conductor",
];

export type GrupoDeAlerta = "combustible" | "urea" | "flota";

export function grupoDeAlerta(tipo: string): GrupoDeAlerta {
  if (TIPOS_DE_ALERTA_DE_FLOTA.includes(tipo)) return "flota";
  if (tipo.startsWith("urea_")) return "urea";
  return "combustible";
}

/** Los tipos de alerta que este usuario NO debe ver por no tener el módulo dueño: los de viaje, si no
 *  tiene `viajes`. Sirve para dos cosas: recortar lo que se lista y vaciar el contenido de los eventos de
 *  tiempo real (ver events.ts). Aparte de esto, la Bandeja de Combustible NUNCA lista los de viaje, tenga
 *  o no la persona `viajes` (tienen su propia tabla desde la 0188): eso lo hace `filtroModuloDeAlerta`. */
export function tiposSinModulo(modulosPermitidos: string[] | undefined): string[] | undefined {
  // Sin la lista de módulos (el resumen por correo no la trae) no se recorta nada.
  if (!modulosPermitidos) return undefined;
  return modulosPermitidos.includes("viajes") ? undefined : [...TIPOS_DE_ALERTA_DE_FLOTA];
}
