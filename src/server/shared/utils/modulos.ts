/** src/server/shared/utils/modulos.ts
 *
 * ¿Este usuario tiene el módulo? Es la pregunta que se hace antes de leer datos
 * de OTRO módulo para enriquecer una respuesta (ver `opcionales` en
 * src/modules/types.ts). Sin el módulo, la lectura NO se ejecuta: se omite esa
 * parte y se responde lo demás, nunca un 403 ni la consulta a la tabla ajena
 * para filtrar después.
 *
 * Mira `modulosPermitidos` del usuario (ya viaja en el JWT), no la empresa: si
 * la empresa tiene el módulo pero a este usuario no se lo dieron, tampoco ve esos
 * datos. Espejo en el cliente: client/src/modules/tieneModulo.ts. */
export function tieneModulo(
  usuario: { modulosPermitidos: string[] } | null | undefined,
  modulo: string
): boolean {
  return !!usuario && usuario.modulosPermitidos.includes(modulo);
}

/** Módulos que MANTIENEN unidades (el maestro `equipos`): Flota con su Registro de unidades y
 *  Mantenimiento con sus equipos. Quien tiene uno de los dos ve y elige unidades en los módulos que
 *  las usan para enriquecer (Checklists, Órdenes de trabajo, IPERC). Un módulo nuevo que también
 *  mantenga unidades se agrega aquí y en ningún otro sitio. */
export const MODULOS_DUENOS_DE_UNIDADES = ["flota", "mantenimiento"] as const;

/** ¿Este usuario tiene algún módulo que mantiene unidades? Es la pregunta de «¿ofrezco unidades?»;
 *  `tieneModulo(usuario, "flota")` ya no la responde sola, porque Mantenimiento también las tiene. */
export function tieneUnidades(
  usuario: { modulosPermitidos: string[] } | null | undefined
): boolean {
  return MODULOS_DUENOS_DE_UNIDADES.some((modulo) => tieneModulo(usuario, modulo));
}
