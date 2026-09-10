import { z } from "zod";

// El email es único por tenant, no global (ver migrations/0001_tenants_usuarios.sql),
// así que el login necesita saber a qué tenant pertenece el usuario antes de
// buscarlo por correo — de lo contrario, dos tenants con un usuario de mismo
// email serían indistinguibles.
const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Ingresa el identificador de tu empresa")
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Identificador de empresa inválido");

/** El campo se llama `identificador` porque puede ser un correo O un DNI
 *  (migración 0084): el grifero y los conductores de ruta no tienen correo
 *  corporativo.
 *
 *  `email` se sigue aceptando como alias para no romper a nadie que ya esté
 *  mandando ese nombre --la cola offline, un script, una pestaña abierta con
 *  el bundle viejo. Los dos caen en el mismo campo.
 *
 *  NO se valida como correo: un DNI no lo es. Lo que decide cómo se busca es
 *  la presencia de "@", en el servicio de login. */
export const loginSchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    identificador: z.string().trim().min(1).max(150).optional(),
    email: z.string().trim().min(1).max(150).optional(),
    password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
  })
  .transform((v) => ({
    tenantSlug: v.tenantSlug,
    password: v.password,
    identificador: (v.identificador ?? v.email ?? "").trim(),
  }))
  .refine((v) => v.identificador.length > 0, {
    message: "Indicá tu correo o tu DNI",
    path: ["identificador"],
  });

export type LoginInput = z.infer<typeof loginSchema>;

export const googleLoginSchema = z.object({
  tenantSlug: tenantSlugSchema,
  credential: z.string({ required_error: "El credential de Google es obligatorio" }).min(1),
});

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export const forgotPasswordSchema = z.object({
  tenantSlug: tenantSlugSchema,
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token requerido"),
  newPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const cambiarMiPasswordSchema = z.object({
  passwordActual: z.string().min(1, "Contraseña actual requerida").max(200),
  passwordNueva: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type CambiarMiPasswordInput = z.infer<typeof cambiarMiPasswordSchema>;
