/** tests/auditoria-offline-red.test.ts
 *
 * Auditoría adversaria: apiFetch (502/503/504 -> TypeError), la cola y el
 * cierre de sesión sin red. Cada test describe el comportamiento correcto y
 * FALLA hoy. No modifica código de producción.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { googleLoginApi, loginApi } from "../client/src/services/authApi";

// El backend marca TODAS sus respuestas con x-request-id (app.ts): así se
// distingue un 5xx suyo del que pone el proxy cuando el servidor está caído.
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "x-request-id": "test" },
  });

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("C1 — 502/503/504 deliberados del backend dejan de llegar como respuesta", () => {
  it("Google no configurado (503 con mensaje) debe llegar con su mensaje, no como 'Servidor no disponible'", async () => {
    vi.stubGlobal("fetch", async () =>
      json(503, { message: "Login con Google no está configurado" })
    );
    await expect(googleLoginApi(null, "cred")).rejects.toThrow(
      "Login con Google no está configurado"
    );
  });

  it("un 502 de reCAPTCHA en /login NO debe convertirse en TypeError (LoginPage lo toma como 'sin conexión' e intenta la huella local)", async () => {
    vi.stubGlobal("fetch", async () =>
      json(502, { message: "No se pudo validar la proteccion anti-spam." })
    );
    const err = await loginApi(null, "45259374", "clave", null).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
  });
});

describe("C1 — un 5xx sin x-request-id (lo pone el proxy) sí es 'sin servidor'", () => {
  it("un 502 del proxy en /login llega como TypeError", async () => {
    vi.stubGlobal("fetch", async () => new Response("Bad Gateway", { status: 502 }));
    const err = await loginApi(null, "45259374", "clave", null).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
  });
});
