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
