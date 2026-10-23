/** tests/app-arranca.test.ts
 *
 * La app se puede importar y arrancar. Es además la "línea base" de
 * `npm run mapa-tests`: lo que este test ejecuta (el arranque de todos los
 * módulos) se resta de lo que ejecuta cada otro test, para saber qué usa de
 * verdad cada uno. No le agregues nada que no sea arrancar la app.
 */
import { describe, it, expect } from "vitest";
import { app } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("arranque de la app", () => {
  it("se importa y queda lista sin errores", async () => {
    expect(app).toBeTruthy();
    await closeDatabase();
  });
});
