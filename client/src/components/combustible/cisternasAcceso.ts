// client/src/components/combustible/cisternasAcceso.ts
//
// Quién ve la pestaña "Cisternas". Va aparte de la pantalla para que App.tsx, el menú y el aviso
// de Tanques puedan preguntarlo sin cargar el panel (que es perezoso).
//
// Es el espejo del servidor (permisosPestanas.service.ts): un permiso guardado por el admin manda;
// sin él, la ven admin, operador, grifero y Lectura. El conductor de ruta y el encargado de urea
// no. Esto solo evita dibujar lo que daría 403.

export interface UsuarioParaCisternas {
  rol: string;
  permisosPestanas?: Record<string, boolean>;
}

const ROLES_CON_PESTANA = ["admin", "operador", "grifero", "lectura"];

export function puedeVerCisternas(usuario: UsuarioParaCisternas | null | undefined): boolean {
  const override = usuario?.permisosPestanas?.["combustible:cisternas"];
  if (override !== undefined) return override;
  return !!usuario && ROLES_CON_PESTANA.includes(usuario.rol);
}

export interface UsuarioParaCompras extends UsuarioParaCisternas {
  rol: string;
}

/** Quién gestiona las compras de cisterna (registrar, habilitar, anular): el admin siempre; los
 *  demás, solo si el admin les dio el permiso. Espejo de `cisternas:registrar_compra` en el
 *  servidor, que no se concede por defecto a nadie más. */
export function puedeGestionarCompras(usuario: UsuarioParaCompras | null | undefined): boolean {
  if (!usuario) return false;
  if (usuario.rol === "admin") return true;
  return usuario.permisosPestanas?.["combustible:cisternas:registrar_compra"] === true;
}
