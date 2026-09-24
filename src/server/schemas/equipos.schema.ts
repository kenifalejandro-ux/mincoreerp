import { z } from "zod";

import { grifoNoEditable } from "./sedes.schema";

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
  // Consumo máximo tolerado (migración 0088): litros por hora de motor si el
  // equipo se mide por horómetro, litros por km si es por odómetro. Sin
  // configurar = no alerta, igual que la capacidad: el número lo sabe la
  // operación, y el sistema lo sugiere desde el historial del propio equipo.
  //
  // Es el ÚNICO control que ve el combustible que sale CON vale pero no llega
  // a la máquina: el tanque cuadra, lo que no cuadra es el trabajo hecho con
  // ese combustible.
  consumo_maximo_l: z.number().positive().max(9999).nullable().optional(),
  // El conductor asignado (migración 0083). Nombre completo en un campo
  // porque así viene en el vale de papel ("CONDUCTOR"); partirlo obligaría a
  // decidir dónde termina el nombre en cada carga.
  conductor_nombre: z.string().trim().min(1).max(150).optional(),
  conductor_dni: z.string().trim().min(6).max(15).optional(),
  // Si esta unidad usa urea automotriz (migración 0092). Default TRUE: la
  // mayoría de la flota (Euro V/SCR) sí consume -- el cliente confirmó que
  // camionetas y maquinaria amarilla NO (respuesta 15). Marcarlo en false es
  // lo que habilita el control `urea_equipo_no_habilitado`: un vale de urea
  // a un equipo marcado así es sospechoso por definición.
  usa_urea: z.boolean().optional(),
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
    // Código interno de la empresa (ej. "CU-14"), distinto de la placa --
    // migración 0103. Opcional: no toda la flota lo trae.
    codigo_interno: z.string().trim().max(50).optional(),
    tipo: z.string().trim().min(1, "Tipo requerido").max(100),
    marca: z.string().trim().max(100).optional(),
    modelo: z.string().trim().max(100).optional(),
    tipo_medidor: z.enum(TIPOS_MEDIDOR).optional(),
    ...camposCapacidadTanque,
    // El grifo interno al que pertenece (0097). Opcional: con un solo grifo en
    // la empresa lo asigna la base; con más de uno el servicio lo exige.
    grifo_interno_id: z.number().int().positive().optional(),
  })
  .superRefine(validarCapacidadCompleta);

export type CrearEquipoInput = z.infer<typeof crearEquipoSchema>;

export const actualizarEquipoSchema = z
  .object({
    placa_codigo: z.string().trim().min(1, "Placa/código requerido").max(50),
    codigo_interno: z.string().trim().max(50).optional(),
    tipo: z.string().trim().min(1, "Tipo requerido").max(100),
    marca: z.string().trim().max(100).optional(),
    modelo: z.string().trim().max(100).optional(),
    tipo_medidor: z.enum(TIPOS_MEDIDOR).optional(),
    ...camposCapacidadTanque,
    // Cambiar de grifo tiene su propio endpoint, con motivo (0097).
    grifo_interno_id: grifoNoEditable,
  })
  .superRefine(validarCapacidadCompleta);

export type ActualizarEquipoInput = z.infer<typeof actualizarEquipoSchema>;

// ── Carga masiva (importar Excel) ───────────────────────────────────────
//
// Solo los cuatro campos que trae la planilla del cliente (placa, tipo,
// marca, modelo): el resto (capacidad de tanque, medidor, conductor, grifo)
// es configuración operativa que no vive en un inventario de flota y se
// carga a mano, equipo por equipo, igual que hoy. Mismo criterio que
// repuestos.schema.ts: no se reusa crearEquipoSchema completo porque acá NO
// hace falta ni tiene sentido pedir cliente_uuid ni grifo_interno_id.
export const filaCargaMasivaEquipoSchema = z.object({
  placa_codigo: z.string().trim().min(1, "Placa/código requerido").max(50),
  codigo_interno: z.string().trim().max(50).optional(),
  tipo: z.string().trim().min(1, "Tipo requerido").max(100),
  marca: z.string().trim().max(100).optional(),
  modelo: z.string().trim().max(100).optional(),
});

/** Mismo tope y mismo motivo que MAX_FILAS_CARGA_MASIVA en
 *  repuestos.schema.ts: acota el trabajo que un solo request le impone a la
 *  base compartida por todos los tenants. */
export const MAX_FILAS_CARGA_MASIVA_EQUIPOS = 5000;

export const cargaMasivaEquiposSchema = z
  .array(filaCargaMasivaEquipoSchema)
  .min(1, "La importación no puede estar vacía")
  .max(
    MAX_FILAS_CARGA_MASIVA_EQUIPOS,
    `No se pueden importar más de ${MAX_FILAS_CARGA_MASIVA_EQUIPOS} filas de una vez`
  );

export type CargaMasivaEquiposInput = z.infer<typeof cargaMasivaEquiposSchema>;

// ── Eliminación masiva (checkbox "seleccionar todo") ────────────────────
export const MAX_IDS_ELIMINACION_MASIVA = 500;

export const eliminarMasivoEquiposSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1, "Elegí al menos un equipo")
    .max(
      MAX_IDS_ELIMINACION_MASIVA,
      `No se pueden eliminar más de ${MAX_IDS_ELIMINACION_MASIVA} equipos de una vez`
    ),
});

export type EliminarMasivoEquiposInput = z.infer<typeof eliminarMasivoEquiposSchema>;
