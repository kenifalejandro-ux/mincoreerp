/** tests/auditoria-offline-cola.test.ts
 *
 * Auditoría adversaria del drenaje de la cola frente a 502/503/504.
 * El test describe el comportamiento correcto y FALLA hoy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaCola } from "../client/src/offline/offlineQueue";

let cola: EntradaCola[] = [];

vi.mock("../client/src/offline/offlineQueue", () => ({
  listarPendientes: async () => cola.map((e) => ({ ...e })),
  quitarDeLaCola: async (uuid: string) => {
    cola = cola.filter((e) => e.clienteUuid !== uuid);
  },
  registrarIntentoFallido: async (entrada: EntradaCola, error: string) => {
    cola = cola.map((e) =>
      e.clienteUuid === entrada.clienteUuid
        ? { ...e, intentos: e.intentos + 1, ultimoError: error }
        : e
    );
  },
  suscribirseACola: () => () => {},
}));

const enviarSinCola = vi.fn();
vi.mock("../client/src/services/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client/src/services/apiClient")>()),
  enviarSinCola: (...a: unknown[]) => enviarSinCola(...a),
}));

import { drenar } from "../client/src/offline/offlineSync";
import { marcarSesionConfirmada } from "../client/src/offline/sesionOffline";

beforeEach(() => {
  enviarSinCola.mockReset();
  cola = [
    {
      clienteUuid: "u-1",
      usuarioId: null,
      moduloId: "combustible",
      url: "/api/erp/combustible/despachos",
      metodo: "POST",
      body: "{}",
      creadoEn: 1,
      intentos: 0,
    } as EntradaCola,
  ];
});

describe("C2 — apiFetch trata 502/503/504 como 'sin servidor', pero el drenaje los cuenta como intentos", () => {
  it("un servidor que responde 503 durante 10 pasadas (reintento cada 15 s = 2,5 min) NO debe hacer perder el despacho", async () => {
    enviarSinCola.mockImplementation(
      async () =>
        new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } })
    );
    for (let i = 0; i < 10; i++) await drenar();
    expect(cola.map((e) => e.clienteUuid)).toEqual(["u-1"]);
  });
});

describe("A1 — la cola no se drena con una sesión sin confirmar", () => {
  it("mientras se entró sin señal y el servidor no confirmó a la persona, no se envía nada", async () => {
    enviarSinCola.mockImplementation(async () => new Response("{}", { status: 200 }));
    marcarSesionConfirmada(false);
    await drenar();
    expect(enviarSinCola).not.toHaveBeenCalled();
    marcarSesionConfirmada(true);
    await drenar();
    expect(enviarSinCola).toHaveBeenCalledTimes(1);
  });

  it("un 503 DELIBERADO del backend (trae x-request-id) sí cuenta como intento", async () => {
    enviarSinCola.mockImplementation(
      async () => new Response("{}", { status: 503, headers: { "x-request-id": "abc" } })
    );
    await drenar();
    expect(cola[0]?.intentos).toBe(1);
  });
});
