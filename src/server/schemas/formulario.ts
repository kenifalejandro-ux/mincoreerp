import { z } from "zod";

export const sanitizeSingleLine = (value: string) =>
  value
    // eslint-disable-next-line no-control-regex -- a propósito: despoja caracteres de control de un input de usuario, no es un typo.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const sanitizeMultiline = (value: string) =>
  value
    // eslint-disable-next-line no-control-regex -- a propósito: idem abajo, despoja caracteres de control de un input de usuario, no es un typo.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();

export const formularioSchema = z
  .object({
    Nombre: z
      .string()
      .transform(sanitizeSingleLine)
      .pipe(z.string().min(2, "El nombre es muy corto").max(120, "El nombre es muy largo")),
    Empresa: z
      .string()
      .transform(sanitizeSingleLine)
      .pipe(z.string().min(2, "La empresa es obligatoria").max(160, "La empresa es muy larga")),
    Correo: z
      .string()
      .transform((value) => sanitizeSingleLine(value).toLowerCase())
      .pipe(z.string().email("Correo inválido").max(160, "Correo demasiado largo")),
    Telefono: z
      .string()
      .transform(sanitizeSingleLine)
      .pipe(
        z
          .string()
          .min(7, "El telefono es muy corto")
          .max(30, "El telefono es muy largo")
          .regex(/^[0-9+()\-\s.]+$/, "Telefono inválido")
      ),
    Producto: z.string().transform(sanitizeSingleLine).optional(),
    Servicio: z.string().transform(sanitizeSingleLine).optional(),
    Mensaje: z
      .string()
      .transform(sanitizeMultiline)
      .pipe(z.string().min(10, "El mensaje es muy corto").max(3000, "El mensaje es muy largo")),
    recaptcha_token: z
      .string()
      .transform(sanitizeSingleLine)
      .pipe(
        z.string().min(10, "Token de reCAPTCHA faltante").max(4096, "Token de reCAPTCHA inválido")
      ),
    website: z
      .string()
      .optional()
      .transform((value) => sanitizeSingleLine(value ?? "")),
  })
  .superRefine((data, ctx) => {
    const selectedItem = (data.Producto || data.Servicio || "").trim();

    if (data.website) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["website"],
        message: "Actividad sospechosa detectada",
      });
    }

    if (selectedItem.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["Producto"],
        message: "El producto es obligatorio",
      });
    }
  })
  .transform((data) => ({
    ...data,
    Producto: (data.Producto || data.Servicio || "").trim(),
  }));

export type FormularioData = z.output<typeof formularioSchema>;
