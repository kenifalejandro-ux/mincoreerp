import { z } from "zod";

// La orden es sobre la unidad de Flota (`equipo_id`), sobre un texto libre (`activo_texto`,
// «Horno 4») o sobre las dos: hace falta al menos una (migración 0190). `equipo_id` es INMUTABLE
// después de crear (no aparece en actualizarOrdenTrabajoSchema) -- mismo criterio que IPERC, que
// no permite editar campos estructurales después de creado, solo cambiar estado.
export const crearOrdenTrabajoSchema = z
  .object({
    // Lo genera el dispositivo con crypto.randomUUID() al abrir el modal,
    // online u offline (ver client/src/offline/). Opcional a propósito: sin
    // él, la creación se comporta igual que siempre. Con él, un reintento del
    // mismo envío no duplica (ver idempotentInsert.ts).
    cliente_uuid: z.string().uuid().optional(),
    equipo_id: z.number().int().positive().optional(),
    activo_texto: z.string().trim().max(150).optional(),
    titulo: z.string().trim().min(1, "Título requerido").max(200),
    descripcion: z.string().trim().max(2000).optional(),
    tipo: z.enum(["correctivo", "preventivo"]).default("correctivo"),
    prioridad: z.enum(["baja", "media", "alta", "urgente"]).default("media"),
    iperc_id: z.number().int().positive().optional(),
    fecha_programada: z.string().min(1).optional(),
    // Dueño de la OT -- distinto de quién la abrió (ver migrations/0051).
    // Opcional: una OT puede crearse sin asignar todavía.
    asignado_a: z.string().uuid().optional(),
  })
  .refine((o) => o.equipo_id !== undefined || (o.activo_texto ?? "") !== "", {
    message: "Indica la unidad o escribe el activo o lugar de la orden",
    path: ["activo_texto"],
  });

export type CrearOrdenTrabajoInput = z.infer<typeof crearOrdenTrabajoSchema>;

// PUT de campos no-estado -- ni equipo_id (inmutable) ni estado (tiene su
// propio endpoint con la máquina de estados). Mismo criterio que
// actualizarDocumentoSchema: sin .strict(), y los campos ausentes quedan
// en NULL/default en el repository, no "sin cambios".
export const actualizarOrdenTrabajoSchema = z.object({
  // Texto libre del activo o lugar: sí se puede corregir (la unidad no). Una orden SIN unidad no
  // puede quedarse sin texto (el repository lo rechaza con 400; el CHECK de 0190 lo respalda).
  activo_texto: z.string().trim().max(150).optional(),
  titulo: z.string().trim().min(1, "Título requerido").max(200),
  descripcion: z.string().trim().max(2000).optional(),
  tipo: z.enum(["correctivo", "preventivo"]),
  prioridad: z.enum(["baja", "media", "alta", "urgente"]),
  iperc_id: z.number().int().positive().optional(),
  fecha_programada: z.string().min(1).optional(),
  // Omitirlo en un PUT lo deja en NULL (desasigna) -- mismo criterio que
  // iperc_id arriba.
  asignado_a: z.string().uuid().optional(),
});

export type ActualizarOrdenTrabajoInput = z.infer<typeof actualizarOrdenTrabajoSchema>;

// 'abierta' no es un destino válido -- es solo el default de creación, no
// una transición (ver la tabla de orígenes permitidos en
// OrdenesTrabajoRepository.cambiarEstado).
export const cambiarEstadoOrdenTrabajoSchema = z.object({
  estado: z.enum(["en_progreso", "completada", "cancelada"]),
  observaciones_cierre: z.string().trim().max(2000).optional(),
});

export type CambiarEstadoOrdenTrabajoInput = z.infer<typeof cambiarEstadoOrdenTrabajoSchema>;
