import { z } from "zod";

// Sedes y grifos internos (migración 0097). Compartido por Combustible y
// Equipos: los dos mueven lo suyo de grifo con la misma regla.

/** Mover un tanque o un equipo a otro grifo interno. El motivo es
 *  obligatorio: la base rechaza el cambio sin él. */
export const moverDeGrifoSchema = z.object({
  grifo_interno_id: z.number().int().positive(),
  motivo: z.string().trim().min(1, "El motivo es obligatorio").max(500),
});

export type MoverDeGrifoInput = z.infer<typeof moverDeGrifoSchema>;

/** En el PUT de un tanque o un equipo: cambiar de grifo NO es editar, tiene
 *  su propio endpoint con motivo y rastro. Mandarlo es un error, no algo que
 *  se ignora en silencio. */
export const grifoNoEditable = z
  .unknown()
  .refine((v) => v === undefined, {
    message: "Para cambiar el grifo interno usá 'Mover de grifo', que pide motivo",
  })
  .optional();
