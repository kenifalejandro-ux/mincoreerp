/** src/server/shared/utils/eventosPorModulo.ts
 *
 * ¿Este usuario debe recibir este evento del stream de tiempo real? Cada evento es de UN módulo
 * (`repuestos.creado` es de Repuestos), y quien no tiene ese módulo no recibe su actividad: una empresa
 * que contrató solo algunos módulos (o una persona a la que solo le dieron algunos) no ve movimiento
 * de los demás. Mira `modulosPermitidos` del usuario, que ya viaja en el JWT (ver tieneModulo en
 * ./modulos.ts); se resuelve al conectar, así que un cambio de módulos rige desde la próxima conexión,
 * igual que el alcance de Combustible (0100).
 *
 * ── El prefijo NO siempre es el módulo dueño ─────────────────────────────
 * Por convención el tipo empieza con el módulo (`iperc.creado`), pero hay dos desvíos:
 *   · `equipos.*` es de Flota (el módulo se llamaba `equipos`; el id pasó a `flota`, migración 0165).
 *   · `combustible.viaje_actualizado` es de VIAJES aunque lleve prefijo `combustible.`: lo escuchan
 *     "Mi viaje", el panel y el detalle del viaje. Si se filtrara solo por prefijo, una empresa con
 *     Viajes y sin Combustible dejaría de recibir sus actualizaciones en vivo.
 *
 * Un tipo que no se conoce (un módulo nuevo, o uno que no vi) PASA: perder un evento en silencio es
 * peor que mostrarlo de más. El test guardián (tests/eventos-por-modulo.test.ts) falla si alguien
 * publica un tipo con un prefijo que no está en esta tabla, para que no quede sin dueño.
 */

/** El módulo dueño según el prefijo del tipo (lo que va antes del primer punto). */
export const MODULO_POR_PREFIJO: Record<string, string> = {
  combustible: "combustible",
  equipos: "flota",
  viajes: "viajes",
  iperc: "iperc",
  repuestos: "repuestos",
  documentos: "documentos",
  ordenes_trabajo: "ordenes_trabajo",
  checklists: "checklists",
};

/** Los tipos cuyo dueño NO es el de su prefijo. */
export const MODULO_POR_TIPO: Record<string, string> = {
  "combustible.viaje_actualizado": "viajes",
};

/** El módulo dueño del evento, o `undefined` si no se conoce. */
export function moduloDelEvento(tipo: string): string | undefined {
  return MODULO_POR_TIPO[tipo] ?? MODULO_POR_PREFIJO[tipo.split(".")[0]];
}

/** Sin la lista de módulos (no viaja en algunas conexiones) no se recorta nada. */
export function debeRecibirEvento(tipo: string, modulosPermitidos: string[] | undefined): boolean {
  if (!modulosPermitidos) return true;
  const modulo = moduloDelEvento(tipo);
  return modulo === undefined || modulosPermitidos.includes(modulo);
}
