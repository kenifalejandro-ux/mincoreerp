// client/src/components/proveedores/proveedoresAcceso.ts
//
// Quién ve el ecosistema «Gestión de proveedores». Lo usan el menú (Sidebar) y la pantalla activa
// (App). Alcanza con tener el módulo `proveedores`: lo asigna el administrador por persona y los
// perfiles de cancha no lo reciben por su rol (el servidor lo corta igual, ver MODULOS_POR_ROL).
// No hay permiso de pestaña propio: ver proveedores.routes.ts.

type UsuarioDeProveedores = { modulosPermitidos: string[] } | null;

export function puedeVerProveedores(usuario: UsuarioDeProveedores | undefined): boolean {
  return !!usuario && usuario.modulosPermitidos.includes("proveedores");
}

/** «Gestión comercial» (precios de proveedores) reutiliza los permisos de Precios de Combustible: quien
 *  tiene `tanques:precios` o `urea:precios` ve ese producto. Sin permiso puesto a mano, admin y operador;
 *  Lectura no. Hace falta el módulo `proveedores` (no el de Combustible: los precios se leen igual).
 *  El servidor exige lo mismo, esto solo decide si se dibuja la entrada. */
export function puedeVerPreciosDeProveedores(
  usuario:
    | {
        rol: string;
        modulosPermitidos: string[];
        permisosPestanas?: Record<string, boolean>;
      }
    | null
    | undefined
): boolean {
  if (!usuario || !usuario.modulosPermitidos.includes("proveedores")) return false;
  const porDefecto = usuario.rol === "admin" || usuario.rol === "operador";
  const combustible = usuario.permisosPestanas?.["combustible:tanques:precios"] ?? porDefecto;
  const urea = usuario.permisosPestanas?.["combustible:urea:precios"] ?? porDefecto;
  return combustible || urea;
}
