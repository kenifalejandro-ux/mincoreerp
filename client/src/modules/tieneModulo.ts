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

// Módulos que MANTIENEN unidades (el maestro `equipos`): Flota y Mantenimiento. Espejo de
// MODULOS_DUENOS_DE_UNIDADES en src/server/shared/utils/modulos.ts: un módulo nuevo que también
// mantenga unidades se agrega en los dos archivos y en ningún otro sitio.
const MODULOS_DUENOS_DE_UNIDADES = ["flota", "mantenimiento"];

// ¿Este usuario tiene algún módulo que mantiene unidades? Decide si Checklists, Órdenes de trabajo
// e IPERC piden y ofrecen unidades para elegir; sin ninguno se identifica el activo por texto.
export function tieneUnidades(
  usuario: { modulosPermitidos: string[] } | null | undefined
): boolean {
  return MODULOS_DUENOS_DE_UNIDADES.some((modulo) => tieneModulo(usuario, modulo));
}
