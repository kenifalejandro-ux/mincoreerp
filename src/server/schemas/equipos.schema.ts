import { z } from "zod";

// Qué instrumento mide este equipo en un despacho de combustible
// compra_externa -- ver migrations/0062 y el punto 2 de
// docs/architecture/control-de-combustible.md (hallazgo 9). Nullable: la
// mayoría de los equipos nunca cargan fuera del tanque propio.
const TIPOS_MEDIDOR = ["horometro", "odometro"] as const;

// Capacidad del tanque de combustible de ESTA unidad, para detectar
// sobredespacho (migrations/0069). Las dos van juntas o ninguna: un número
// sin unidad no se puede comparar contra la cantidad de un despacho, que
// puede venir en gal o en L. Omitir ambas = "sin configurar", y entonces
// la validación de sobredespacho no corre para esa unidad.
const UNIDADES_CAPACIDAD = ["gal", "L"] as const;

const camposCapacidadTanque = {
  capacidad_tanque: z.number().positive().max(99999999).optional(),
  capacidad_tanque_unidad: z.enum(UNIDADES_CAPACIDAD).optional(),
  // El conductor asignado (migración 0083). Nombre completo en un campo
  // porque así viene en el vale de papel ("CONDUCTOR"); partirlo obligaría a
  // decidir dónde termina el nombre en cada carga.
  conductor_nombre: z.string().trim().min(1).max(150).optional(),
  conductor_dni: z.string().trim().min(6).max(15).optional(),
};

/** Espejo en Zod del CHECK `equipos_capacidad_tanque_check` de la migración
 *  0069 -- sin esto, mandar solo uno de los dos campos moriría con un 500
 *  de constraint en vez de un 400 explicando qué falta. */
function validarCapacidadCompleta(
  data: { capacidad_tanque?: number; capacidad_tanque_unidad?: string },
  ctx: z.RefinementCtx
) {
  const tieneCapacidad = data.capacidad_tanque !== undefined;
  const tieneUnidad = data.capacidad_tanque_unidad !== undefined;
  if (tieneCapacidad !== tieneUnidad) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [tieneCapacidad ? "capacidad_tanque_unidad" : "capacidad_tanque"],
      message: "capacidad_tanque y capacidad_tanque_unidad van juntas: o las dos, o ninguna",
    });
  }
}

export const crearEquipoSchema = z
  .object({
    // Lo genera el dispositivo con crypto.randomUUID() al apretar "Registrar
    // Equipo", online u offline (ver client/src/offline/). Opcional a
    // propósito: sin él, la creación se comporta exactamente como siempre —
    // ningún cliente viejo se rompe. Con él, un reintento del mismo envío no
    // duplica (ver idempotentInsert.ts).
    cliente_uuid: z.string().uuid().optional(),
    placa_codigo: z.string().trim().min(1, "Placa/código requerido").max(50),
    tipo: z.string().trim().min(1, "Tipo requerido").max(100),
    marca: z.string().trim().max(100).optional(),
    modelo: z.string().trim().max(100).optional(),
    tipo_medidor: z.enum(TIPOS_MEDIDOR).optional(),
    ...camposCapacidadTanque,
  })
  .superRefine(validarCapacidadCompleta);

export type CrearEquipoInput = z.infer<typeof crearEquipoSchema>;

export const actualizarEquipoSchema = z
  .object({
    placa_codigo: z.string().trim().min(1, "Placa/código requerido").max(50),
    tipo: z.string().trim().min(1, "Tipo requerido").max(100),
    marca: z.string().trim().max(100).optional(),
    modelo: z.string().trim().max(100).optional(),
    tipo_medidor: z.enum(TIPOS_MEDIDOR).optional(),
    ...camposCapacidadTanque,
  })
  .superRefine(validarCapacidadCompleta);

export type ActualizarEquipoInput = z.infer<typeof actualizarEquipoSchema>;
