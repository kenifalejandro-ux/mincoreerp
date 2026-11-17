import { z } from "zod";

export const crearPlantillaSchema = z.object({
  nombre: z.string().trim().min(1, "Nombre requerido").max(150),
  tipo_equipo: z.string().trim().max(100).optional(),
  items: z
    .array(
      z.object({
        descripcion: z.string().trim().min(1, "Descripción requerida").max(300),
        orden: z.number().int().optional(),
      })
    )
    .min(1, "La plantilla necesita al menos un ítem"),
});

export type CrearPlantillaInput = z.infer<typeof crearPlantillaSchema>;

export const crearChecklistSchema = z
  .object({
    // Lo genera el dispositivo con crypto.randomUUID() al apretar
    // "Registrar", online u offline (ver client/src/offline/). Opcional a
    // propósito: sin él, la creación se comporta exactamente como siempre —
    // ningún cliente viejo se rompe. Con él, un reintento del mismo envío no
    // duplica (ver idempotentInsert.ts).
    cliente_uuid: z.string().uuid().optional(),
    // De qué es el checklist: la unidad de Flota, un texto libre («Horno 4»), o las dos. Hace
    // falta al menos una (ver el refine de abajo y el CHECK de la migración 0189).
    equipo_id: z.number().int().positive().optional(),
    activo_texto: z.string().trim().max(150).optional(),
    plantilla_id: z.number().int().positive(),
    turno: z.string().trim().max(20).optional(),
    observaciones_generales: z.string().trim().max(2000).optional(),
    items: z
      .array(
        z.object({
          descripcion: z.string().trim().min(1).max(300),
          estado: z.enum(["bien", "malo", "na"]),
          observacion: z.string().trim().max(500).optional(),
        })
      )
      .min(1, "El checklist necesita al menos un ítem"),
  })
  .refine((c) => c.equipo_id !== undefined || (c.activo_texto ?? "") !== "", {
    message: "Indica la unidad o escribe el activo o lugar del checklist",
    path: ["activo_texto"],
  });

export type CrearChecklistInput = z.infer<typeof crearChecklistSchema>;
