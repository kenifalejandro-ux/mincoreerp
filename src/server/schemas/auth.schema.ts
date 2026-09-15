import { z } from "zod";

// La empresa dejó de ser obligatoria para entrar (migración 0087): una persona
// administrativa tiene UNA cuenta con su correo, y sus perfiles en cada
// empresa cuelgan de ahí. Cuando el request llega por la dirección de una
// empresa (subdominio o dominio propio), resolveTenantSubdomain la inyecta en
// el body y el login se limita a esa empresa. Si no viene ninguna, el login
// resuelve solo: una empresa entra directo, varias las elige la persona
// DESPUÉS de validar la clave.
//
// Sigue siendo obligatoria en la práctica para el personal operativo, que
// entra con DNI: el DNI no es único entre empresas (ver el documento de
// arquitectura, sección 3), así que sin empresa no hay a quién buscar.
const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Ingresa el identificador de tu empresa")
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Identificador de empresa inválido");

/** El mismo formato, pero opcional: el login ya no lo exige. */
const tenantSlugOpcionalSchema = tenantSlugSchema.optional();

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
    tenantSlug: tenantSlugOpcionalSchema,
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
  tenantSlug: tenantSlugOpcionalSchema,
  credential: z.string({ required_error: "El credential de Google es obligatorio" }).min(1),
});

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export const forgotPasswordSchema = z.object({
  // Opcional desde 0087: la recuperación es de la CUENTA, no de una empresa.
  // Si viene (el request entró por la dirección de una empresa), se usa solo
  // para armar el enlace del correo con esa dirección.
  tenantSlug: tenantSlugOpcionalSchema,
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

/** Segundo paso del login cuando la persona tiene perfil en varias empresas.
 *  El `token` lo emitió el propio servidor al validar la clave y vive 2
 *  minutos: la clave no vuelve a viajar. */
export const elegirEmpresaSchema = z.object({
  token: z.string().min(20).max(4000),
  tenantId: z.string().uuid("Empresa inválida"),
});

export type ElegirEmpresaInput = z.infer<typeof elegirEmpresaSchema>;
