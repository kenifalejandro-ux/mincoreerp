/** tests/alerta-mailer-dominio-de-prueba.test.ts
 *
 * Un servidor de desarrollo con SMTP real no debe escribirle a las empresas
 * de prueba (`@test.local`): cada correo rebota a la bandeja del remitente.
 * Con su gemelo: una dirección real SÍ sale, o el filtro podría estar
 * tragándose todo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMail = vi.hoisted(() => vi.fn(async (_opciones: { to: string[] }) => ({})));

vi.mock("../src/server/config/mailer", () => ({ transporter: { sendMail } }));
vi.mock("../src/server/config/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/config/env")>();
  return { ...real, emailConfigured: true, env: { ...real.env, emailUser: "remitente@real.test" } };
});

import { enviarCorreoAlerta, esCorreoDePrueba } from "../src/server/shared/utils/alertaMailer";

const aviso = { asunto: "a", titulo: "t", lineas: ["l"] };

describe("alertaMailer: no escribe a @test.local", () => {
  beforeEach(() => sendMail.mockClear());

  it("reconoce el dominio de prueba, sin importar mayúsculas", () => {
    expect(esCorreoDePrueba("jefe-abc@test.local")).toBe(true);
    expect(esCorreoDePrueba("Jefe@TEST.LOCAL")).toBe(true);
    expect(esCorreoDePrueba("jefe@cushuro.mincoreerp.com.pe")).toBe(false);
    // Termina en el dominio, no lo contiene.
    expect(esCorreoDePrueba("test.local@gmail.com")).toBe(false);
  });

  it("si todos son de prueba, no manda nada", async () => {
    await enviarCorreoAlerta({
      ...aviso,
      destinatarios: [{ email: "a@test.local", nombre: "A" }],
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("en una lista mezclada, manda solo a las direcciones reales", async () => {
    await enviarCorreoAlerta({
      ...aviso,
      destinatarios: [
        { email: "a@test.local", nombre: "A" },
        { email: "real@cliente.pe", nombre: "R" },
      ],
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0].to).toEqual(["real@cliente.pe"]);
  });
});
