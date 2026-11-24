// client/src/components/mantenimiento/mantenimientoAcceso.ts
//
// Quién ve el ecosistema «Gestión de mantenimiento». Lo usan el menú (Sidebar) y la pantalla activa (App) a
// través de la declaración de ecosistemas. Alcanza con tener el módulo `mantenimiento`: lo asigna el
// administrador por persona y los perfiles de cancha, Mecánico y Operario no lo reciben por su rol (el
// servidor lo corta igual, ver MODULOS_POR_ROL). Tener Checklists u Órdenes de trabajo NO alcanza: son
// módulos aparte y el ecosistema es autónomo. No hay permiso de pestaña propio: ver mantenimiento.routes.ts.

type UsuarioDeMantenimiento = { modulosPermitidos: string[] } | null;

export function puedeVerMantenimiento(usuario: UsuarioDeMantenimiento | undefined): boolean {
  return !!usuario && usuario.modulosPermitidos.includes("mantenimiento");
}
