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

/** Los tipos de alerta que la Bandeja de COMBUSTIBLE no muestra: las de viaje tienen su propia tabla y
 *  su propia Bandeja (`viaje_alertas`, migración 0188), y se leen por `/viajes/alertas`. Se excluyen
 *  siempre, tenga o no la persona el módulo Viajes: las filas viejas de esos tipos que quedan en
 *  `combustible_alertas` (la migración las copia, no las borra) no deben aparecer duplicadas.
 *  El parámetro se conserva por compatibilidad con quien lo llama. */
export function tiposSinModulo(_modulosPermitidos: string[] | undefined): string[] {
  return [...TIPOS_DE_ALERTA_DE_FLOTA];
}
