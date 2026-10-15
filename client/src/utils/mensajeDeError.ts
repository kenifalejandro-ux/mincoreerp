/** El motivo de un rechazo del servidor, para mostrárselo al usuario.
 *
 *  El servidor responde en tres formas: la validación de esquema manda
 *  `errors: [{ field, message }]`, el manejador de errores (AppError) manda
 *  `message`, y algunos controladores responden `{ error }` a mano. Leer solo
 *  una de ellas escondía el motivo real detrás del texto por defecto. */
export function mensajeDeError(body: unknown, porDefecto: string): string {
  const b = (body ?? {}) as {
    errors?: { message?: unknown }[];
    message?: unknown;
    error?: unknown;
  };
  const candidatos = [b.errors?.[0]?.message, b.message, b.error];
  const motivo = candidatos.find((c): c is string => typeof c === "string" && c.trim() !== "");
  return motivo ?? porDefecto;
}
