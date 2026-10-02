/** src/server/services/perfilesDefaults.ts
 *
 * Con qué arranca cada PERFIL. Es la traducción a código de la matriz
 * robusta de visibilidad (profile_user.xlsx, hojas "Matriz robusta" y
 * "Acciones por perfil"), y es un punto de PARTIDA, no un límite: el admin
 * del tenant lo ajusta después desde Administración → Configuración, y el
 * dueño de la plataforma puede hacer lo mismo desde el panel central.
 *
 * Vive aparte de permisosTenant/auth a propósito: los dos lo necesitan (uno
 * al dar de alta, el otro al cambiar de perfil) y tenerlo en cualquiera de
 * ellos cerraría un ciclo de imports entre ambos.
 *
 * El reparto de PESTAÑAS dentro de cada módulo vive en
 * permisosPestanas.service.ts (`defaultsDeRol`); acá está solo el nivel con
 * el que se entra a cada módulo.
 */
import type { UsuarioPayload } from "./auth.service";

export type NivelModulo = "operar" | "consultas";

/** - Admin y Operador operan todo lo que la empresa tenga contratado.
 *    Administración y Facturación no son módulos del registry y se cortan
 *    por rol en otro lado (ver App.tsx y facturacion.ts).
 *  - Lectura consulta todo y nunca opera: el nivel es lo que de verdad le
 *    bloquea el POST/PUT/DELETE en `requireNivelParaEscribir`.
 *  - Los tres perfiles de cancha (grifero, conductor de ruta y encargado de
 *    urea) solo entran a Combustible; el resto de módulos ni les aparece. */
export function moduloPorDefectoDeRol(
  rol: UsuarioPayload["rol"],
  modulo: string
): { asignado: boolean; nivel: NivelModulo } {
  if (rol === "lectura") return { asignado: true, nivel: "consultas" };
  if (rol === "admin" || rol === "operador") return { asignado: true, nivel: "operar" };
  return { asignado: modulo === "combustible", nivel: "operar" };
}
