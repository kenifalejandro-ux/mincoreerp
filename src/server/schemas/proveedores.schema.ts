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

export type CrearProveedorInput = z.infer<typeof crearProveedorSchema>;
export type ActualizarProveedorInput = z.infer<typeof actualizarProveedorSchema>;
export type CrearPreciosProveedoresInput = z.infer<typeof crearPreciosProveedoresSchema>;
