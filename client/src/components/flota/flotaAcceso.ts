// client/src/components/flota/flotaAcceso.ts
//
// Quién ve qué dentro de "Gestión operacional de flota". Lo usan el menú
// (Sidebar), la pantalla activa (App) y los avisos que llevan a un viaje: así
// los tres coinciden con lo que el servidor deja pasar.
//
// Los permisos de pestaña de Viajes siguen bajo el módulo `combustible`
// (`combustible:viajes`, `combustible:mi_viaje`, ...): no se migran a `viajes:*`.
// El servidor los lee con esas mismas claves.

type UsuarioDeFlota = {
  rol: string;
  modulosPermitidos: string[];
  permisosPestanas?: Record<string, boolean>;
} | null;

/** Los perfiles de cancha trabajan solo en Combustible; Flota no es para ellos
 *  (el conductor tiene "Mi viaje", que sigue en su menú). */
const PERFILES_DE_CANCHA = ["conductor_ruta", "grifero", "encargado_urea"];

/** Registro de unidades (lo que antes se llamaba Equipos). */
export function puedeVerUnidades(usuario: UsuarioDeFlota | undefined): boolean {
  return !!usuario && usuario.modulosPermitidos.includes("flota");
}

/** Las acciones que cuelgan de Viajes: darle UNA a un perfil que no ve Viajes le
 *  abre el submenú (el servidor lo hace igual, ver `pestanaPermitida`). */
const ACCIONES_DE_VIAJES = ["nuevo", "editar", "lugares", "consumo"];

/** La lista de viajes de la oficina: hace falta el módulo `viajes` Y el módulo
 *  Combustible (el servidor exige los dos: la lista trae las cargas de cada
 *  viaje, que son datos de Combustible), y que el perfil no la tenga apagada.
 *  Sin permiso puesto a mano, la ven todos menos los perfiles de cancha, salvo que
 *  a alguno se le haya dado a mano una acción de Viajes (p. ej. "Consumo por viaje"). */
export function puedeVerViajes(usuario: UsuarioDeFlota | undefined): boolean {
  if (
    !usuario ||
    !usuario.modulosPermitidos.includes("viajes") ||
    !usuario.modulosPermitidos.includes("combustible")
  ) {
    return false;
  }
  const override = usuario.permisosPestanas?.["combustible:viajes"];
  if (override !== undefined) return override;
  if (
    ACCIONES_DE_VIAJES.some((a) => usuario.permisosPestanas?.[`combustible:viajes:${a}`] === true)
  )
    return true;
  return !PERFILES_DE_CANCHA.includes(usuario.rol);
}

/** La pestaña "Consumo por viaje" dentro de Viajes: lo mismo que la lista y,
 *  además, su permiso propio (`viajes:consumo`). Sin permiso puesto a mano, la ven
 *  todos los que ven la lista (admin, operador y Lectura). */
export function puedeVerConsumoDeViajes(usuario: UsuarioDeFlota | undefined): boolean {
  if (!usuario || !puedeVerViajes(usuario)) return false;
  const override = usuario.permisosPestanas?.["combustible:viajes:consumo"];
  if (override !== undefined) return override;
  return !PERFILES_DE_CANCHA.includes(usuario.rol);
}

/** "Mi viaje" del conductor: la pantalla llama al módulo Viajes (y lee las
 *  cargas de Combustible), así que sin esos dos módulos el servidor da 403 y el
 *  conductor vería una pantalla rota. Sin permiso puesto a mano, es del conductor. */
export function puedeVerMiViaje(usuario: UsuarioDeFlota | undefined): boolean {
  if (
    !usuario ||
    !usuario.modulosPermitidos.includes("viajes") ||
    !usuario.modulosPermitidos.includes("combustible")
  ) {
    return false;
  }
  const override = usuario.permisosPestanas?.["combustible:mi_viaje"];
  if (override !== undefined) return override;
  return usuario.rol === "conductor_ruta";
}

/** El grupo del menú existe si hay algo adentro. */
export function puedeVerFlota(usuario: UsuarioDeFlota | undefined): boolean {
  return puedeVerUnidades(usuario) || puedeVerViajes(usuario);
}

/** A dónde lleva el grupo al tocarlo: a su primer ítem disponible. */
export function destinoDeFlota(usuario: UsuarioDeFlota | undefined): "flota" | "flota:viajes" {
  return puedeVerUnidades(usuario) ? "flota" : "flota:viajes";
}
