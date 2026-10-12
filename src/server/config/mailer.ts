import nodemailer from "nodemailer";
import { crearTransporteBrevo } from "./brevoTransport";
import { emailConfigured, env } from "./env";
import { logger } from "./logger";

/** Quién manda: la API de Brevo si hay clave y remitente, si no el SMTP de
 *  siempre, si no nadie. En Railway (plan sin SMTP saliente) solo sirve la API. */
export function elegirProveedorDeCorreo(c: {
  emailConfigured: boolean;
  emailApiKey: string;
  emailFrom: string;
}): "api" | "smtp" | null {
  if (!c.emailConfigured) return null;
  return c.emailApiKey && c.emailFrom ? "api" : "smtp";
}

const proveedor = elegirProveedorDeCorreo({ emailConfigured, ...env });
logger.info({ proveedor }, "Correo: proveedor de envío activo");

export const transporter =
  proveedor === "api"
    ? nodemailer.createTransport(crearTransporteBrevo(env.emailApiKey))
    : proveedor === "smtp"
      ? crearTransporteSmtp()
      : null;

function crearTransporteSmtp() {
  return nodemailer.createTransport({
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
  });
}

export async function verifyMailer() {
  if (!transporter) return;

  try {
    await transporter.verify();
    logger.info("Transporte de correo verificado y listo para enviar");
  } catch (error) {
    logger.error({ err: error }, "No se pudo verificar el transporte de correo");
  }
}
