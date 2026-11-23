// client/src/components/proveedores/accionesDeProveedor.ts
//
// Qué acciones tiene cada persona sobre un proveedor y cómo se dicen. Sin React ni red. El servidor exige lo
// mismo (editar y desactivar: admin y operador; eliminar: solo el admin); esto decide qué se dibuja.

export type IdDeAccion = "editar" | "desactivar" | "reactivar" | "eliminar";

export const ETIQUETA_DE_ACCION: Record<IdDeAccion, string> = {
  editar: "Editar proveedor",
  desactivar: "Desactivar proveedor",
  reactivar: "Reactivar proveedor",
  eliminar: "Eliminar proveedor",
};

/** Las acciones disponibles, en el orden del menú. Desactivar y reactivar son la misma acción según cómo está el
 *  proveedor. Eliminar: solo el admin. */
export function accionesDelProveedor(opciones: {
  activo: boolean;
  /** Puede editar proveedores (admin u operador con permiso de escritura). */
  puedeEditar: boolean;
  esAdmin: boolean;
}): IdDeAccion[] {
  if (!opciones.puedeEditar) return [];
  return [
    "editar",
    opciones.activo ? "desactivar" : "reactivar",
    ...(opciones.esAdmin ? (["eliminar"] as const) : []),
  ];
}

export const MOTIVO_MINIMO = 3;
export const MOTIVO_MAXIMO = 300;

/** El problema del motivo, o `null` si está bien. Desactivar lo exige; reactivar lo admite pero no lo pide. */
export function problemaDelMotivo(motivo: string, desactivando: boolean): string | null {
  const m = motivo.trim();
  if (m.length > MOTIVO_MAXIMO) return `El motivo no puede pasar de ${MOTIVO_MAXIMO} letras.`;
  if (desactivando && m.length < MOTIVO_MINIMO) return "Escribe el motivo (al menos 3 letras).";
  return null;
}
