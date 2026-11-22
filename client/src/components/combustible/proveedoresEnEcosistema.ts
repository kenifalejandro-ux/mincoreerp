// client/src/components/combustible/proveedoresEnEcosistema.ts
//
// ¿Los proveedores de esta persona se editan en «Gestión de proveedores» y no en la pestaña «Proveedores» de
// Combustible? Desde el PR6 el catálogo de proveedores (`combustible_grifos`) es del módulo Proveedores. Para no
// tener dos pantallas que editan la misma tabla —la de Combustible no ve la ficha, los contactos ni las
// cuentas bancarias—, cuando la persona TIENE ese módulo y puede escribir en él, la pestaña de Combustible
// pasa a solo lectura y manda a la otra. En cualquier otro caso queda como siempre: una empresa solo con
// Combustible, o una persona sin el módulo asignado o en «Consultas», sigue registrando proveedores acá (si
// no, no tendría dónde). El servidor no cambia: `/grifos` sigue aceptando altas y ediciones.
//
// Pura, sin React. Espejo de lo que exige el ecosistema para escribir: módulo asignado, nivel «Operar» y rol
// admin u operador (ver usePuedeEditarProveedor).
type UsuarioParaProveedores = {
  rol: string;
  modulosPermitidos: string[];
  modulosConsulta?: string[];
};

export function edicionDeProveedoresEnElEcosistema(
  usuario: UsuarioParaProveedores | null | undefined
): boolean {
  if (!usuario) return false;
  if (!usuario.modulosPermitidos.includes("proveedores")) return false;
  if ((usuario.modulosConsulta ?? []).includes("proveedores")) return false;
  return usuario.rol === "admin" || usuario.rol === "operador";
}

/** Pide al App que abra la pantalla de Gestión de proveedores (mismo mecanismo que los demás avisos que
 *  llevan de un panel a otra pestaña). */
export function irAGestionDeProveedores(): void {
  window.dispatchEvent(new CustomEvent("mincore:ir-a-pestana", { detail: "proveedores:centro" }));
}
