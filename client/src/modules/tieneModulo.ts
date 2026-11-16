// client/src/modules/tieneModulo.ts
//
// ¿Este usuario tiene el módulo? Para mostrar u ocultar la parte de una pantalla
// que viene de OTRO módulo (ver `opcionales` en src/modules/types.ts): sin el
// módulo, esa parte no se pide ni se muestra, y el resto funciona igual.
//
// Espejo de src/server/shared/utils/modulos.ts: mismo criterio (los
// `modulosPermitidos` del usuario), para que menú, pantalla y servidor coincidan.
export function tieneModulo(
  usuario: { modulosPermitidos: string[] } | null | undefined,
  modulo: string
): boolean {
  return !!usuario && usuario.modulosPermitidos.includes(modulo);
}
