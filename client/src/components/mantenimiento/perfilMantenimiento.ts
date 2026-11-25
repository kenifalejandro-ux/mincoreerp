// client/src/components/mantenimiento/perfilMantenimiento.ts
//
// Cómo se nombra a la persona en la barra superior del ecosistema, sin React.

/** El perfil en palabras (la línea de abajo del nombre). */
export function etiquetaDelPerfil(rol: string | undefined): string {
  switch (rol) {
    case "admin":
      return "Administrador";
    case "operador":
      return "Operador";
    case "lectura":
      return "Lectura";
    case "mecanico":
      return "Mecánico";
    case "operario":
      return "Operario";
    case "grifero":
      return "Grifero";
    case "conductor_ruta":
      return "Conductor";
    case "encargado_urea":
      return "Encargado de urea";
    default:
      return "";
  }
}

/** Las iniciales para el círculo del usuario: dos letras del nombre. */
export function inicialesDe(nombre: string | undefined): string {
  const partes = (nombre ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[1][0]).toUpperCase();
}
