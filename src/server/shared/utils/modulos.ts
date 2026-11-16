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
