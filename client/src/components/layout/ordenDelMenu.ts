// client/src/components/layout/ordenDelMenu.ts
//
// El orden de los módulos en el menú del ERP. Los ecosistemas (ver ecosistemas/ecosistemas.ts) van justo debajo
// de «Bandeja»: la Bandeja se dibuja pegada al Dashboard (o primera, si la persona no tiene Dashboard), así que
// los ecosistemas son los primeros módulos después de ese lugar. El resto conserva el orden del registro. Sin
// React.

/** Mueve los módulos de ecosistema (`idsDeEcosistemas`) al lugar justo después del Dashboard (o al primero si no
 *  hay Dashboard), en el orden en que venían. Sin ninguno en la lista, la devuelve igual. No modifica la lista
 *  que recibe. */
export function conEcosistemasBajoBandeja<T extends { id: string }>(
  modulos: T[],
  idsDeEcosistemas: readonly string[]
): T[] {
  const deEcosistemas = modulos.filter((m) => idsDeEcosistemas.includes(m.id));
  if (deEcosistemas.length === 0) return modulos;
  const resto = modulos.filter((m) => !idsDeEcosistemas.includes(m.id));
  const dashboard = resto.findIndex((m) => m.id === "dashboard");
  return [...resto.slice(0, dashboard + 1), ...deEcosistemas, ...resto.slice(dashboard + 1)];
}
