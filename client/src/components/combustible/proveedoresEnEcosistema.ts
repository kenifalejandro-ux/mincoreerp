// client/src/components/combustible/proveedoresEnEcosistema.ts
//
// ¿Los proveedores y sus precios de esta persona se manejan en «Gestión de proveedores» y no en Combustible?
// Desde el PR6 el catálogo de proveedores (`combustible_grifos`) es del módulo Proveedores. Para no tener dos
// pantallas que editan lo mismo, cuando la persona TIENE ese módulo y puede escribir en él:
//   · la pestaña «Proveedores» de Combustible se oculta, y
//   · «Precios» de Combustible queda solo con la venta interna del tanque (los precios de proveedor de ruta y
//     de urea se cargan en Gestión comercial).
// En cualquier otro caso queda todo como siempre: una empresa solo con Combustible, o una persona sin el
// módulo asignado o en «Consultas», sigue registrando proveedores y sus precios acá (si no, no tendría dónde).
// El servidor no cambia: `/grifos` y los precios siguen aceptando altas y ediciones, y los despachos, las
// compras en ruta y los viajes leen los mismos precios (`combustible_precios`) pasen por donde pasen.
//
// Pura, sin React. Espejo de lo que exige el ecosistema para escribir: módulo asignado, nivel «Operar» y rol
// admin u operador (ver usePuedeEditarProveedor).
import { rutaDe, type SeccionDeRuta } from "../proveedores/rutaProveedores";

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

/** Pide al App que abra Gestión de proveedores, en la sección que se indique (por defecto, el Centro). Escribe
 *  primero la dirección de esa sección para que el ecosistema abra directo ahí (lee la dirección al montar);
 *  el aviso interno de cambio de pestaña es el mismo de los demás enlaces entre paneles. */
export function irAGestionDeProveedores(seccion?: SeccionDeRuta): void {
  if (seccion) window.history.pushState(null, "", rutaDe({ seccion }));
  window.dispatchEvent(new CustomEvent("mincore:ir-a-pestana", { detail: "proveedores:centro" }));
}
