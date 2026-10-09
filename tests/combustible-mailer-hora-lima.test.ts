/** tests/combustible-mailer-hora-lima.test.ts
 *
 * Las horas dentro del cuerpo de los correos se escriben en hora de Lima, sin
 * importar la zona del servidor. Railway corre en UTC: sin esto, un vale
 * cargado a las 9:50 p. m. en Lima salía en el correo como las 2:50 a. m. del
 * día siguiente. La máquina de desarrollo SÍ está en Lima, por eso no se veía.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

const enviados = vi.hoisted(() => [] as { lineas: string[] }[]);
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(async (a: { lineas: string[] }) => {
    enviados.push({ lineas: a.lineas });
  }),
}));

import { enviarCorreoValeRetroactivo } from "../src/modules/combustible/combustibleAlertas.mailer";

describe("correos de combustible: la hora se escribe en Lima", () => {
  beforeAll(() => {
    // Un servidor en UTC, como el de producción.
    process.env.TZ = "UTC";
  });

  it("el mismo instante sale como 9:50 p. m. del día 8, no 2:50 a. m. del 9", async () => {
    await enviarCorreoValeRetroactivo([{ email: "a@real.pe", nombre: "A" }], {
      serieTalonario: "A",
      nVale: 1,
      diasDeAtraso: 5,
      diasTolerados: 3,
      // 02:50 UTC = 21:50 en Lima (UTC-5).
      despachadoEn: "2026-10-09T02:50:14Z",
    });
    const texto = enviados[0].lineas.join(" ");
    expect(texto).toContain("8/10/2026");
    expect(texto).toMatch(/9:50:14\s*p\.\s*m\./);
    expect(texto).not.toContain("9/10/2026");
  });
});
