/** src/server/schemas/proveedores.schema.ts
 *
 * Alta y edición de un proveedor desde el ecosistema «Gestión de proveedores». Las mismas reglas que
 * Combustible (nombre, RUC de 11 dígitos), más el RUC editable. Las banderas son las de siempre:
 * INTERNO es compra para despachar desde la planta y EXTERNO la que se hace en ruta.
 */
import { z } from "zod";

import { crearPreciosCombustibleMasivoSchema } from "./combustible.schema";

const nombre = z.string().trim().min(1, "El nombre del proveedor es obligatorio").max(150);

/** "" o ausente = sin RUC (null). */
const ruc = z
  .string()
  .trim()
  .refine((v) => v === "" || /^\d{11}$/.test(v), "El RUC debe tener 11 dígitos")
  .nullish()
  .transform((v) => (v ? v : null));

const banderas = {
  abastece_tanque: z.boolean(),
  abastece_ruta: z.boolean(),
  abastece_urea: z.boolean(),
  abastece_urea_ruta: z.boolean(),
};

export const crearProveedorSchema = z
  .object({ nombre, ruc, ...banderas })
  .refine((p) => p.abastece_tanque || p.abastece_ruta || p.abastece_urea || p.abastece_urea_ruta, {
    message: "Elige qué abastece el proveedor",
    path: ["abastece_tanque"],
  });

export const actualizarProveedorSchema = z.object({
  nombre,
  ruc,
  activo: z.boolean(),
  ...banderas,
});

/** Un mismo precio de combustible para varios proveedores de ruta, todo o nada. Es el cambio masivo de
 *  Combustible → Precios pero solo para PROVEEDORES: los precios de tanque (la venta interna) son de
 *  Combustible y no se cargan desde acá. */
export const crearPreciosProveedoresSchema = crearPreciosCombustibleMasivoSchema.refine(
  (d) => d.combustible_ids === undefined && d.grifo_ids !== undefined,
  { message: "El precio va a proveedores de ruta, no a tanques", path: ["grifo_ids"] }
);

// ── Ficha del proveedor (PR3a): datos de contacto, condiciones de pago y personas de contacto ───────

/** Texto libre opcional: recortado; vacío o ausente = sin dato (null). */
const textoOpcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `No puede pasar de ${max} caracteres`)
    .nullish()
    .transform((v) => (v ? v : null));

const telefono = z
  .string()
  .trim()
  .refine((v) => v === "" || /^[0-9+()\-\s.]{6,40}$/.test(v), "El teléfono no es válido")
  .nullish()
  .transform((v) => (v ? v : null));

const correo = z
  .string()
  .trim()
  .toLowerCase()
  .max(150, "El correo no puede pasar de 150 caracteres")
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "El correo no es válido")
  .nullish()
  .transform((v) => (v ? v : null));

/** Dirección, teléfono, correo y condiciones de pago: todo opcional. Contado no lleva plazo; crédito lo
 *  exige (1 a 365 días). Se guarda completo (lo que no se manda queda vacío). */
export const guardarDatosProveedorSchema = z
  .object({
    direccion: textoOpcional(250),
    telefono,
    correo,
    forma_pago: z
      .enum(["contado", "credito"])
      .nullish()
      .transform((v) => v ?? null),
    plazo_pago_dias: z
      .number()
      .int("El plazo es en días enteros")
      .min(1, "El plazo es de 1 a 365 días")
      .max(365, "El plazo es de 1 a 365 días")
      .nullish()
      .transform((v) => v ?? null),
    moneda: z
      .enum(["PEN", "USD"])
      .nullish()
      .transform((v) => v ?? null),
  })
  .superRefine((d, ctx) => {
    if (d.forma_pago === "credito" && d.plazo_pago_dias === null) {
      ctx.addIssue({
        code: "custom",
        message: "El crédito necesita su plazo en días",
        path: ["plazo_pago_dias"],
      });
    }
    if (d.forma_pago !== "credito" && d.plazo_pago_dias !== null) {
      ctx.addIssue({
        code: "custom",
        message: "El plazo solo va con crédito",
        path: ["plazo_pago_dias"],
      });
    }
  });

/** Una persona de contacto: nombre y al menos un teléfono o un correo. */
export const contactoProveedorSchema = z
  .object({
    nombre: z.string().trim().min(1, "El nombre del contacto es obligatorio").max(120),
    cargo: textoOpcional(80),
    telefono,
    correo,
    principal: z.boolean(),
    /** Lo manda la pantalla al abrir el formulario: un reintento no crea un segundo contacto. */
    cliente_uuid: z.string().uuid().optional(),
  })
  .refine((c) => c.telefono !== null || c.correo !== null, {
    message: "Escribe un teléfono o un correo del contacto",
    path: ["telefono"],
  });

export type GuardarDatosProveedorInput = z.infer<typeof guardarDatosProveedorSchema>;
export type ContactoProveedorInput = z.infer<typeof contactoProveedorSchema>;

export type CrearProveedorInput = z.infer<typeof crearProveedorSchema>;
export type ActualizarProveedorInput = z.infer<typeof actualizarProveedorSchema>;
export type CrearPreciosProveedoresInput = z.infer<typeof crearPreciosProveedoresSchema>;
