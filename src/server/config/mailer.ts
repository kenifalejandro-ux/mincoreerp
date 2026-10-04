import nodemailer from "nodemailer";
import { emailConfigured, env } from "./env";
import { logger } from "./logger";

export const transporter = emailConfigured
  ? nodemailer.createTransport({
      host: env.emailHost,
      port: env.emailPort,
      secure: env.emailPort === 465,
      pool: true,
      maxConnections: env.emailMaxConnections,
      maxMessages: env.emailMaxMessages,
      requireTLS: true,
      // Sin esto nodemailer espera 2 min la conexión y 10 min el socket. Varios
      // correos de alerta se envían ANTES de responder el request (p. ej. al
      // registrar un despacho), así que un SMTP lento dejaba colgada la
      // pantalla del conductor y, con ella, la subida de la foto del
      // comprobante que va después de la respuesta. Un correo que no sale en
      // 15 s se da por fallido (los llamadores ya lo capturan y lo loguean).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      auth: {
        user: env.emailUser,
        pass: env.emailPass,
      },
      tls: {
        minVersion: "TLSv1.2",
      },
    })
  : null;

export async function verifyMailer() {
  if (!transporter) return;

  try {
    await transporter.verify();
    logger.info("SMTP verificado y listo para enviar formularios");
  } catch (error) {
    logger.error({ err: error }, "No se pudo verificar el transporte SMTP");
  }
}
