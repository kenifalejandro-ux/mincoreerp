// Transportador de nodemailer que envía por la API HTTPS de Brevo en vez de SMTP.
//
// Railway desactiva el SMTP saliente (465/587) en los planes que no son Pro
// (docs.railway.com/networking/outbound-networking); el 443 sí sale. Los
// llamadores no cambian: siguen haciendo `transporter.sendMail({...})`.
import type { Transport } from "nodemailer";
import { escapeHtml } from "../shared/utils/html";

const URL_BREVO = "https://api.brevo.com/v3/smtp/email";
// Igual que connectionTimeout/socketTimeout del camino SMTP: varios correos se
// mandan antes de responder el request, y un envío colgado no puede tumbar la pantalla.
const TIMEOUT_MS = 15_000;

export interface Persona {
  email: string;
  name?: string;
}

/** `"Nombre" <a@b.com>`, `a@b.com` o `{ name, address }` -> `{ email, name? }`.
 *  Lo que llega de nodemailer puede ser cualquiera de las tres (o listas de ellas). */
export function aPersona(d: unknown): Persona | null {
  if (typeof d === "string") {
    const m = d.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (!m) return d.trim() ? { email: d.trim() } : null;
    const name = m[1].trim();
    return name ? { email: m[2].trim(), name } : { email: m[2].trim() };
  }
  if (d && typeof d === "object" && "address" in d) {
    const { address, name } = d as { address?: string; name?: string };
    if (!address) return null;
    return name ? { email: address, name } : { email: address };
  }
  return null;
}

const aLista = (d: unknown): Persona[] =>
  d === undefined || d === null
    ? []
    : [d]
        .flat(Infinity)
        .map(aPersona)
        .filter((p): p is Persona => p !== null);

export function crearTransporteBrevo(apiKey: string, fetchImpl: typeof fetch = fetch): Transport {
  return {
    name: "brevo-api",
    version: "1",
    send(mail, callback) {
      const falla = (err: unknown) =>
        callback(err instanceof Error ? err : new Error(String(err)), undefined as never);

      const d = mail.data;
      const sender = aLista(d.from)[0];
      const to = aLista(d.to);
      if (!sender || to.length === 0) {
        falla(new Error("Correo sin remitente o sin destinatarios"));
        return;
      }
      if (
        (d.html !== undefined && typeof d.html !== "string") ||
        (d.text !== undefined && typeof d.text !== "string")
      ) {
        falla(new Error("Brevo: el contenido del correo debe ser texto"));
        return;
      }
      const text = d.text as string | undefined;
      const html =
        (d.html as string | undefined) ?? `<p>${escapeHtml(text ?? "").replace(/\n/g, "<br>")}</p>`;
      const replyTo = aLista(d.replyTo)[0];
      const headers =
        d.headers && !Array.isArray(d.headers) ? (d.headers as Record<string, string>) : undefined;

      fetchImpl(URL_BREVO, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sender,
          to,
          subject: d.subject ?? "",
          htmlContent: html,
          ...(text ? { textContent: text } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
        .then(async (res) => {
          if (!res.ok) {
            const detalle = (await res.text().catch(() => "")).slice(0, 300);
            throw new Error(`Brevo respondió ${res.status}: ${detalle}`);
          }
          const cuerpo = (await res.json().catch(() => ({}))) as { messageId?: string };
          return {
            messageId: cuerpo.messageId ?? "",
            accepted: to.map((p) => p.email),
            rejected: [],
          };
        })
        // Dos argumentos y no `.catch`: si el callback lanzara, no se vuelve a llamar.
        .then((info) => callback(null, info as never), falla);
    },
  };
}
