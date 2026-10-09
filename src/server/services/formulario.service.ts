import type { Request } from "express";
import { emailConfigured, env } from "../config/env";
import { transporter } from "../config/mailer";
import type { FormularioData } from "../schemas/formulario";
import { escapeHtml, formatMultilineHtml, maskEmail } from "../shared/utils/html";
import { getClientIp } from "../shared/utils/request";

export class FormularioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormularioConfigError";
  }
}

function buildEmailContent(formData: FormularioData) {
  const safeData = {
    Nombre: escapeHtml(formData.Nombre),
    Empresa: escapeHtml(formData.Empresa),
    Correo: escapeHtml(formData.Correo),
    Telefono: escapeHtml(formData.Telefono),
    Producto: escapeHtml(formData.Producto),
    Mensaje: formatMultilineHtml(formData.Mensaje),
  };

  const text = [
    "Nueva consulta minera recibida",
    "",
    `Nombre: ${formData.Nombre}`,
    `Empresa: ${formData.Empresa}`,
    `Correo: ${formData.Correo}`,
    `Telefono: ${formData.Telefono}`,
    `Producto o servicio: ${formData.Producto}`,
    "",
    "Mensaje:",
    formData.Mensaje,
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">Nueva consulta minera recibida</h2>
      <table cellpadding="8" cellspacing="0" border="0" style="border-collapse: collapse;">
        <tr><td><strong>Nombre</strong></td><td>${safeData.Nombre}</td></tr>
        <tr><td><strong>Empresa</strong></td><td>${safeData.Empresa}</td></tr>
        <tr><td><strong>Correo</strong></td><td>${safeData.Correo}</td></tr>
        <tr><td><strong>Telefono</strong></td><td>${safeData.Telefono}</td></tr>
        <tr><td><strong>Producto o servicio</strong></td><td>${safeData.Producto}</td></tr>
      </table>
      <div style="margin-top: 20px;">
        <strong>Mensaje</strong>
        <p style="margin-top: 8px;">${safeData.Mensaje}</p>
      </div>
    </div>
  `;

  return { html, text };
}

export async function sendFormulario(req: Request, formData: FormularioData) {
  if (!transporter || !emailConfigured) {
    throw new FormularioConfigError("El servicio de correo no esta configurado correctamente.");
  }

  const { html, text } = buildEmailContent(formData);
  const requestHeaders: Record<string, string> = {};

  if (req.id) {
    requestHeaders["X-Request-Id"] = req.id;
  }

  if (req.log) {
    req.log.info(
      {
        requestId: req.id,
        ip: getClientIp(req),
        company: formData.Empresa,
        product: formData.Producto,
        email: maskEmail(formData.Correo),
      },
      "Formulario validado y listo para envio"
    );
  }

  await transporter.sendMail({
    from: `"Formulario Web" <${env.emailFrom}>`,
    to: "contacto@zincelideas.com",
    replyTo: formData.Correo,
    subject: `Nueva consulta minera - ${formData.Producto}`.slice(0, 180),
    text,
    html,
    ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
  });

  if (req.log) {
    req.log.info({ requestId: req.id }, "Formulario enviado correctamente");
  }
}
