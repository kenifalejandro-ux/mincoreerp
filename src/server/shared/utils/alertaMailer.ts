// src/server/shared/utils/alertaMailer.ts
//
// El formato de correo de aviso del ERP. Vivía adentro de
// combustibleAlertas.mailer.ts como helper privado, pero no tiene nada de
// específico de combustible: arma un título, una lista de líneas y las manda.
//
// Se movió acá cuando la tercera auditoría adversaria encontró que subir la
// capacidad del tanque de un EQUIPO anula el techo diario de combustible --
// un control de un módulo que se desarma desde otro. Equipos necesitaba
// avisar, y ADR-0002 no permite que un módulo importe de otro. La pieza
// genérica pasa a shared; los mensajes concretos siguen en cada módulo.

import { emailConfigured, env } from "../../config/env";
import { transporter } from "../../config/mailer";
import { logger } from "../../config/logger";
import { escapeHtml } from "./html";

export interface DestinatarioAlerta {
  email: string;
  nombre: string;
}

/** Nunca lanza: un correo que no sale no puede tumbar la operación que lo
 *  disparó. El cambio ya está guardado y auditado antes de llegar acá. */
export async function enviarCorreoAlerta(params: {
  destinatarios: DestinatarioAlerta[];
  asunto: string;
  titulo: string;
  lineas: string[];
}) {
  if (!transporter || !emailConfigured || params.destinatarios.length === 0) return;

  const text = [params.titulo, "", ...params.lineas].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">${escapeHtml(params.titulo)}</h2>
      ${params.lineas.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n")}
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"MinCore ERP" <${env.emailUser}>`,
      to: params.destinatarios.map((d) => d.email),
      subject: params.asunto,
      text,
      html,
    });
  } catch (err) {
    logger.warn({ err, asunto: params.asunto }, "No se pudo enviar el correo de alerta");
  }
}
