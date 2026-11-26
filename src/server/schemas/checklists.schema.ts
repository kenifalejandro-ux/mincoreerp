import { z } from "zod";

import { registrarLecturaSchema } from "./equipos.schema";

const itemDeFormato = z.object({
  descripcion: z.string().trim().min(1, "Descripción requerida").max(300),
  orden: z.number().int().optional(),
  /** Punto crítico: si falla, la unidad no debe salir. */
  critica: z.boolean().default(false),
});

const itemsDeFormato = z
  .array(itemDeFormato)
  .min(1, "La plantilla necesita al menos un ítem")
  .max(200, "La plantilla admite hasta 200 ítems");

export const crearPlantillaSchema = z.object({
  nombre: z.string().trim().min(1, "Nombre requerido").max(150),
  tipo_equipo: z.string().trim().max(100).optional(),
  items: itemsDeFormato,
});

/** La versión sobre la que trabajó quien guarda: si ya no es la vigente, 409. */
const versionBase = z.number().int().positive().max(2_000_000_000);

export const editarPlantillaSchema = z.object({
  version_base: versionBase,
  cambio: z.string().trim().min(3, "Escribe qué cambió (al menos 3 letras)").max(300),
  nombre: z.string().trim().min(1, "Nombre requerido").max(150),
  tipo_equipo: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || null),
  items: itemsDeFormato,
});
export type EditarPlantillaInput = z.infer<typeof editarPlantillaSchema>;

export const restaurarPlantillaSchema = z.object({ version_base: versionBase });
export const estadoPlantillaSchema = z.object({ activa: z.boolean() });

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
    // Con qué versión del formato se llenó. La manda el dispositivo (puede haber llenado sin señal con una
    // anterior); si no viene, se anota la vigente.
    plantilla_version: z.number().int().positive().max(2_000_000_000).optional(),
    turno: z.string().trim().max(20).optional(),
    // El horómetro u odómetro de la unidad al llenarlo (queda en sus lecturas). `leido_en` lo manda el
    // dispositivo cuando llenó sin señal; sin él vale la hora en que se guarda.
    // Una hora inválida o futura (reloj del celular adelantado) se descarta y vale la del servidor:
    // rechazarla haría perder el checklist entero.
    lectura: z
      .object({
        valor: registrarLecturaSchema.shape.valor,
        leido_en: registrarLecturaSchema.shape.leido_en.catch(undefined),
      })
      .optional(),
    observaciones_generales: z.string().trim().max(2000).optional(),
    items: z
      .array(
        z.object({
          descripcion: z.string().trim().min(1).max(300),
          estado: z.enum(["bien", "malo", "na"]),
          observacion: z.string().trim().max(500).optional(),
        })
      )
      // Puede llegar vacía si quien puede omitir las críticas no respondió ninguna: el servicio exige que
      // al final quede al menos un ítem.
      .max(200, "El checklist admite hasta 200 ítems"),
  })
  .refine((c) => c.equipo_id !== undefined || (c.activo_texto ?? "") !== "", {
    message: "Indica la unidad o escribe el activo o lugar del checklist",
    path: ["activo_texto"],
  })
  .refine((c) => c.lectura === undefined || c.equipo_id !== undefined, {
    message: "La lectura del medidor necesita una unidad",
    path: ["lectura"],
  });

export type CrearChecklistInput = z.infer<typeof crearChecklistSchema>;

/** Decidir la salida de una unidad con fallas menores: siempre con motivo. */
export const decidirSalidaSchema = z.object({
  autoriza: z.boolean(),
  motivo: z.string().trim().min(3, "Escribe el motivo: queda en el historial").max(300),
  /** Solo cuando autoriza: dejar una orden para atender la falla después. */
  crear_orden: z.boolean().default(false),
});
export type DecidirSalidaInput = z.infer<typeof decidirSalidaSchema>;

/** Filtros de la lista de checklists llenados (la paginación y «salida» se leen aparte). */
export const filtrosDeListaSchema = z.object({
  q: z.string().trim().max(80).optional(),
  resultado: z.enum(["bien", "observado", "no_apta"]).optional(),
});
export type FiltrosDeListaInput = z.infer<typeof filtrosDeListaSchema>;
