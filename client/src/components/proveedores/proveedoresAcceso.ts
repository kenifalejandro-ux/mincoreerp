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
