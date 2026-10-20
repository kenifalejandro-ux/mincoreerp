// client/src/components/combustible/preciosAcceso.ts
//
// ¿Ve este usuario la pantalla Precios? Va aparte de PreciosPagina.tsx para que
// el menú (Sidebar) y el ruteo (App) pregunten lo mismo que el panel sin
// importar la pantalla.
//
// Los permisos por usuario de Precios viven en Administración como
// `tanques:precios` (combustible) y `urea:precios` (urea). Quien tiene uno de
// los dos ve la pantalla, con el producto que le toca; sin permiso explícito
// sigue el reparto de siempre: admin y operador. El servidor exige lo mismo
// ruta por ruta, así que esto solo decide si se dibuja la entrada.

export interface UsuarioParaPrecios {
  rol: string;
  modulosPermitidos: string[];
  permisosPestanas?: Record<string, boolean>;
}

export function puedeVerPrecios(usuario: UsuarioParaPrecios | null | undefined): boolean {
  if (!usuario || !usuario.modulosPermitidos.includes("combustible")) return false;
  const porDefecto = usuario.rol === "admin" || usuario.rol === "operador";
  const combustible = usuario.permisosPestanas?.["combustible:tanques:precios"] ?? porDefecto;
  const urea = usuario.permisosPestanas?.["combustible:urea:precios"] ?? porDefecto;
  return combustible || urea;
}
