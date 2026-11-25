/** src/server/schemas/mantenimiento.schema.ts
 *
 * Validación del ecosistema «Gestión de mantenimiento»: el alta y la edición de equipos, quitarlos y las áreas.
 */
import { z } from "zod";

const texto = (max: number) => z.string().trim().max(max);
/** Un texto opcional: vacío es lo mismo que no mandarlo (se guarda NULL). */
const opcional = (max: number) =>
  texto(max)
    .optional()
    .transform((v) => (v ? v : null));

const camposDelEquipo = {
  placa_codigo: texto(40).min(1, "Escribe la placa o el código"),
  tipo: texto(60).min(1, "Escribe el tipo de equipo"),
  marca: opcional(60),
  modelo: opcional(60),
  medidor: z.enum(["horometro", "odometro"]).default("horometro"),
  lectura: z.number().min(0, "La lectura no puede ser negativa").max(9_999_999.9).default(0),
  propiedad: z.enum(["propia", "alquilada"]).default("propia"),
  area_id: z.number().int().positive().nullable().optional(),
};

export const crearEquipoMantenimientoSchema = z.object({
  /** Lo manda la pantalla al abrir el formulario: un reintento no crea otro equipo. */
  cliente_uuid: z.string().uuid().optional(),
  ...camposDelEquipo,
});
export type CrearEquipoMantenimientoInput = z.infer<typeof crearEquipoMantenimientoSchema>;

// La lectura NO se edita aquí: se registra con las reglas de las lecturas (no retroceder, corregir es anular).
const { lectura: _lectura, ...camposEditables } = camposDelEquipo;
export const actualizarEquipoMantenimientoSchema = z.object(camposEditables);
export type ActualizarEquipoMantenimientoInput = z.infer<
  typeof actualizarEquipoMantenimientoSchema
>;

export const quitarEquipoMantenimientoSchema = z.object({
  motivo: texto(300).min(3, "Escribe el motivo (al menos 3 letras)"),
});
export type QuitarEquipoMantenimientoInput = z.infer<typeof quitarEquipoMantenimientoSchema>;

export const crearAreaMantenimientoSchema = z.object({
  nombre: texto(80).min(1, "Escribe el nombre del área"),
});
export type CrearAreaMantenimientoInput = z.infer<typeof crearAreaMantenimientoSchema>;

/** Tope de equipos por archivo de Excel. Espejo del que usa el cliente (MAX_FILAS_IMPORTACION). */
export const MAX_FILAS_IMPORTACION_EQUIPOS = 1000;

/** Una fila del Excel. El área viaja por su NOMBRE (no por id): si no existe, se crea. */
const filaDeImportacion = z.object({
  placa_codigo: camposDelEquipo.placa_codigo,
  tipo: camposDelEquipo.tipo,
  marca: camposDelEquipo.marca,
  modelo: camposDelEquipo.modelo,
  medidor: camposDelEquipo.medidor,
  lectura: camposDelEquipo.lectura,
  propiedad: camposDelEquipo.propiedad,
  area: opcional(80),
});

export const importarEquiposMantenimientoSchema = z
  .array(filaDeImportacion)
  .min(1, "El archivo no trae equipos")
  .max(
    MAX_FILAS_IMPORTACION_EQUIPOS,
    `El archivo supera el máximo de ${MAX_FILAS_IMPORTACION_EQUIPOS} equipos`
  );
export type ImportarEquiposMantenimientoInput = z.infer<typeof importarEquiposMantenimientoSchema>;

/** Tope de unidades que se completan en una sola vez desde «Desde Operaciones». */
export const MAX_UNIDADES_A_COMPLETAR = 500;

/** Completar unidades que registró otro módulo (Flota): se les da el área y la propiedad con que
 *  Mantenimiento las lleva. Lo demás (placa, tipo, marca, lectura) ya está en el maestro y no se copia. */
export const completarEquiposMantenimientoSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1, "Elige al menos una unidad")
    .max(MAX_UNIDADES_A_COMPLETAR, `Máximo ${MAX_UNIDADES_A_COMPLETAR} unidades por vez`),
  propiedad: camposDelEquipo.propiedad,
  area_id: camposDelEquipo.area_id,
});
export type CompletarEquiposMantenimientoInput = z.infer<
  typeof completarEquiposMantenimientoSchema
>;
