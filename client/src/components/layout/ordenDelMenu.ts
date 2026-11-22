// client/src/components/layout/ordenDelMenu.ts
//
// El orden de los módulos en el menú del ERP. «Gestión de proveedores» va justo debajo de «Bandeja»: la Bandeja
// se dibuja pegada al Dashboard (o primera, si la persona no tiene Dashboard), así que el ecosistema es el
// primer módulo después de ese lugar. El resto conserva el orden del registro. Sin React.

/** Mueve `proveedores` al lugar justo después del Dashboard (o al primero si no hay Dashboard). Sin
 *  `proveedores` en la lista, la devuelve igual. No modifica la lista que recibe. */
export function conProveedoresBajoBandeja<T extends { id: string }>(modulos: T[]): T[] {
  const proveedores = modulos.find((m) => m.id === "proveedores");
  if (!proveedores) return modulos;
  const resto = modulos.filter((m) => m.id !== "proveedores");
  const dashboard = resto.findIndex((m) => m.id === "dashboard");
  return [...resto.slice(0, dashboard + 1), proveedores, ...resto.slice(dashboard + 1)];
}
