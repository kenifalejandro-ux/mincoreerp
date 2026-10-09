/** tests/brevo-transport.test.ts
 *
 * El envío por la API de Brevo (Railway Hobby no deja salir el SMTP). Se pasa
 * por `nodemailer.createTransport` de verdad, con `fetch` falso: lo que se
 * prueba es la forma completa, tal como la usan auth, formularios y alertas.
 */
import { describe, it, expect, vi } from "vitest";
import nodemailer from "nodemailer";

import { aPersona, crearTransporteBrevo } from "../src/server/config/brevoTransport";
import { elegirProveedorDeCorreo } from "../src/server/config/mailer";

type Llamada = { url: string; init: RequestInit };

function fetchQueResponde(status: number, cuerpo: unknown) {
  const llamadas: Llamada[] = [];
  const fetchFalso = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    return new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status });
  });
  return { fetchFalso: fetchFalso as unknown as typeof fetch, llamadas };
}

const cuerpoEnviado = (l: Llamada) => JSON.parse(String(l.init.body));

describe("brevoTransport: arma la petición a la API", () => {
  it("manda remitente, destinatarios, asunto y contenido con la clave en la cabecera", async () => {
    const { fetchFalso, llamadas } = fetchQueResponde(201, { messageId: "<abc@brevo>" });
    const t = nodemailer.createTransport(crearTransporteBrevo("clave-de-prueba", fetchFalso));

    const info = await t.sendMail({
      from: '"MinCore ERP" <alertas@mincoreerp.com.pe>',
      to: ["uno@cliente.pe", "dos@cliente.pe"],
      subject: "Asunto",
      text: "texto",
      html: "<p>html</p>",
    });

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(llamadas[0].init.method).toBe("POST");
    const cab = llamadas[0].init.headers as Record<string, string>;
    expect(cab["api-key"]).toBe("clave-de-prueba");
    expect(cuerpoEnviado(llamadas[0])).toMatchObject({
      sender: { email: "alertas@mincoreerp.com.pe", name: "MinCore ERP" },
      to: [{ email: "uno@cliente.pe" }, { email: "dos@cliente.pe" }],
      subject: "Asunto",
      htmlContent: "<p>html</p>",
      textContent: "texto",
    });
    expect(info.messageId).toBe("<abc@brevo>");
  });

  it("pasa replyTo y cabeceras personalizadas (el formulario web las usa)", async () => {
    const { fetchFalso, llamadas } = fetchQueResponde(201, { messageId: "x" });
    const t = nodemailer.createTransport(crearTransporteBrevo("k", fetchFalso));
    await t.sendMail({
      from: "alertas@mincoreerp.com.pe",
      to: "contacto@x.pe",
      replyTo: "cliente@y.pe",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      headers: { "X-Request-Id": "r1" },
    });
    expect(cuerpoEnviado(llamadas[0])).toMatchObject({
      replyTo: { email: "cliente@y.pe" },
      headers: { "X-Request-Id": "r1" },
    });
  });

  it("si solo hay texto, arma el HTML escapando lo que venga", async () => {
    const { fetchFalso, llamadas } = fetchQueResponde(201, {});
    const t = nodemailer.createTransport(crearTransporteBrevo("k", fetchFalso));
    await t.sendMail({
      from: "a@b.pe",
      to: "c@d.pe",
      subject: "s",
      text: "linea <b>1</b>\nlinea 2",
    });
    const html = cuerpoEnviado(llamadas[0]).htmlContent as string;
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("<br>");
    expect(html).not.toContain("<b>1</b>");
  });
});

describe("brevoTransport: los fallos llegan a quien llamó", () => {
  it("un 4xx rechaza con el código y el detalle, y NUNCA con la clave", async () => {
    const { fetchFalso } = fetchQueResponde(401, '{"message":"Key not found"}');
    const t = nodemailer.createTransport(crearTransporteBrevo("clave-secreta-123", fetchFalso));
    const error = await t
      .sendMail({ from: "a@b.pe", to: "c@d.pe", subject: "s", text: "t", html: "<p>t</p>" })
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).toContain("Key not found");
    expect((error as Error).message).not.toContain("clave-secreta-123");
  });

  it("un error de red también rechaza (los llamadores ya lo capturan y lo registran)", async () => {
    const fetchRoto = (async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    const t = nodemailer.createTransport(crearTransporteBrevo("k", fetchRoto));
    await expect(
      t.sendMail({ from: "a@b.pe", to: "c@d.pe", subject: "s", text: "t", html: "<p>t</p>" })
    ).rejects.toThrow("ETIMEDOUT");
  });

  it("sin destinatarios no llama a la API", async () => {
    const { fetchFalso, llamadas } = fetchQueResponde(201, {});
    const t = nodemailer.createTransport(crearTransporteBrevo("k", fetchFalso));
    await expect(
      t.sendMail({ from: "a@b.pe", to: [], subject: "s", text: "t", html: "<p>t</p>" })
    ).rejects.toThrow();
    expect(llamadas).toHaveLength(0);
  });
});

describe("aPersona", () => {
  it("entiende los tres formatos y descarta lo vacío", () => {
    expect(aPersona('"MinCore ERP" <a@b.pe>')).toEqual({ email: "a@b.pe", name: "MinCore ERP" });
    expect(aPersona("a@b.pe")).toEqual({ email: "a@b.pe" });
    expect(aPersona({ name: "N", address: "a@b.pe" })).toEqual({ email: "a@b.pe", name: "N" });
    expect(aPersona("   ")).toBeNull();
    expect(aPersona({ address: "" })).toBeNull();
  });
});

describe("elegirProveedorDeCorreo", () => {
  const base = { emailConfigured: true, emailApiKey: "", emailFrom: "" };

  it("con clave y remitente usa la API; sin ellos, el SMTP de siempre", () => {
    expect(elegirProveedorDeCorreo({ ...base, emailApiKey: "k", emailFrom: "a@b.pe" })).toBe("api");
    expect(elegirProveedorDeCorreo({ ...base, emailFrom: "a@b.pe" })).toBe("smtp");
    expect(elegirProveedorDeCorreo({ ...base, emailApiKey: "k" })).toBe("smtp");
  });

  it("sin configuración no hay proveedor, aunque haya clave", () => {
    expect(
      elegirProveedorDeCorreo({ emailConfigured: false, emailApiKey: "k", emailFrom: "a@b.pe" })
    ).toBeNull();
  });
});
