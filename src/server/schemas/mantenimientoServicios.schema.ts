/** src/server/schemas/mantenimientoServicios.schema.ts
 *
 * Validación de los servicios de preventivo realizados y de las lecturas que se anotan desde Mantenimiento (M9).
 */
import { z } from "zod";

import { registrarLecturaSchema } from "./equipos.schema";
import { sanitizeSingleLine } from "./formulario";

/** Antes de esto es un año mal escrito (y una fecha absurda rompe la restauración del respaldo). */
const DESDE = Date.UTC(2000, 0, 1);
/** Margen por un reloj desfasado. */
const MARGEN_MS = 5 * 60 * 1000;

const fechaPasada = z
  .string()
  .datetime({ offset: true, message: "La fecha no es válida" })
  .refine((v) => new Date(v).getTime() >= DESDE, "Revisa el año de la fecha")
  .refine((v) => new Date(v).getTime() <= Date.now() + MARGEN_MS, "La fecha es futura");

const entero = z.number().int().positive().max(2_147_483_647);

export const registrarServicioSchema = z.strictObject({
  /** Lo manda la pantalla al abrir el formulario: un reintento no registra el servicio dos veces. */
  cliente_uuid: z.string().uuid(),
  equipo_id: entero,
  nivel: z.number().int().min(1).max(3),
  /** Posición en el ciclo (empieza en 0). Si no viene, la que tocaba. */
  paso: z.number().int().min(0).max(11).optional(),
  // La columna guarda 2 decimales: se redondea al entrar para que el mismo dato no parezca otro.
  lectura: z
    .number()
    .min(0, "La lectura no puede ser negativa")
    .max(9_999_999)
    .transform((n) => Math.round(n * 100) / 100),
  hecho_en: fechaPasada,
  observacion: z
    .string()
    .transform(sanitizeSingleLine)
    .pipe(z.string().max(300))
    .optional()
    .transform((v) => (v ? v : null)),
});
export type RegistrarServicioInput = z.infer<typeof registrarServicioSchema>;

/** El motivo para anular un servicio o una lectura, sin caracteres invisibles. */
export const anularServicioSchema = z.strictObject({
  motivo: z
    .string()
    .transform(sanitizeSingleLine)
    .pipe(z.string().min(3, "Escribe el motivo (al menos 3 letras)").max(300)),
});
export type AnularServicioInput = z.infer<typeof anularServicioSchema>;

/** La lectura del medidor, con las mismas reglas que en Flota y además sin años absurdos. */
export const lecturaDeMantenimientoSchema = registrarLecturaSchema.extend({
  leido_en: fechaPasada.optional(),
});
