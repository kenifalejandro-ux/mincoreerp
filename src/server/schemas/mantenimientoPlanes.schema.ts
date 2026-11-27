/** src/server/schemas/mantenimientoPlanes.schema.ts
 *
 * Validación de los planes de mantenimiento preventivo (M9). Un plan se guarda ENTERO: tipo de equipo, medida,
 * intervalo, aviso, ciclo y las tareas y repuestos de cada nivel del ciclo.
 */
import { z } from "zod";

import { sanitizeSingleLine } from "./formulario";

export const MAX_INTERVALO = 1_000_000;
export const MAX_PASOS_DEL_CICLO = 12;
export const MAX_LINEAS_POR_NIVEL = 40;

/** Una línea limpia: sin caracteres invisibles de control (la base no admite el nulo) y con un solo espacio
 *  entre palabras, así «Volquete  8x4» y «volquete 8x4» son el mismo tipo. */
const unaLinea = z.string().transform(sanitizeSingleLine);

const tipoDeEquipo = unaLinea.pipe(z.string().min(1, "Escribe el tipo de equipo").max(60));

const lineas = z
  .array(unaLinea.pipe(z.string().min(1, "Hay una línea vacía").max(160)))
  .max(MAX_LINEAS_POR_NIVEL, `Máximo ${MAX_LINEAS_POR_NIVEL} líneas por nivel`);

const nivel = z.strictObject({
  tareas: lineas.min(1, "Cada nivel del ciclo necesita al menos una tarea"),
  repuestos: lineas.default([]),
});

const campos = {
  tipo_equipo: tipoDeEquipo,
  medida: z.enum(["horometro", "odometro"]),
  intervalo: z
    .number()
    .int("El intervalo es un número entero")
    .min(1, "El intervalo tiene que ser de al menos 1")
    .max(MAX_INTERVALO, `El intervalo no puede pasar de ${MAX_INTERVALO}`),
  aviso_antes: z
    .number()
    .int("El aviso es un número entero")
    .min(0, "El aviso no puede ser negativo"),
  ciclo: z
    .array(z.number().int().min(1).max(3))
    .min(1, "El ciclo necesita al menos un nivel")
    .max(MAX_PASOS_DEL_CICLO, `El ciclo admite hasta ${MAX_PASOS_DEL_CICLO} pasos`),
  niveles: z.strictObject({
    "1": nivel.optional(),
    "2": nivel.optional(),
    "3": nivel.optional(),
  }),
};

/** El aviso es menor que el intervalo, y los niveles definidos son exactamente los que usa el ciclo. */
function coherente(
  plan: {
    intervalo: number;
    aviso_antes?: number;
    ciclo: number[];
    niveles: Partial<Record<"1" | "2" | "3", unknown>>;
  },
  ctx: z.RefinementCtx
) {
  if (plan.aviso_antes !== undefined && plan.aviso_antes >= plan.intervalo) {
    ctx.addIssue({
      code: "custom",
      path: ["aviso_antes"],
      message: "El aviso tiene que ser menor que el intervalo",
    });
  }
  for (const n of [1, 2, 3] as const) {
    const enCiclo = plan.ciclo.includes(n);
    const definido = plan.niveles[`${n}`] !== undefined;
    if (enCiclo === definido) continue;
    ctx.addIssue({
      code: "custom",
      path: ["niveles", `${n}`],
      message: enCiclo ? `Faltan las tareas del MP${n}` : `El MP${n} no está en el ciclo`,
    });
  }
}

/** Al crear, el aviso puede no venir: se propone el 10 % del intervalo. */
export const crearPlanSchema = z
  .strictObject({ ...campos, aviso_antes: campos.aviso_antes.optional() })
  .superRefine(coherente);
export type CrearPlanInput = z.infer<typeof crearPlanSchema>;

/** El mayor número que cabe en la columna `version`. */
const MAX_VERSION = 2_147_483_647;

/** Al editar viaja todo (el aviso también: si no, guardar borraría el que se había elegido) y la versión sobre la
 *  que se editó. */
export const actualizarPlanSchema = z
  .strictObject({ ...campos, version: z.number().int().positive().max(MAX_VERSION) })
  .superRefine(coherente);
export type ActualizarPlanInput = z.infer<typeof actualizarPlanSchema>;
