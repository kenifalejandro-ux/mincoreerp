/** e2e/combustible-mi-viaje-relevo.spec.ts
 *
 * Un viaje con relevo (0152): sale manejando el titular, así que el relevo ve quién maneja y
 * no puede iniciar el viaje; lo suyo es descansar. El preparativo va por API (ver el fixture).
 */
import { test, expect } from "@playwright/test";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";

test("el relevo ve quién sale manejando y no inicia el viaje", async ({ page }) => {
  test.setTimeout(120_000);
  const v = await prepararViajeDeConductor(page, { conRelevo: true });
  await entrarAMiViaje(page, v, v.relevo!);

  await expect(page.getByText(/Sale manejando Conductor/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Revisar mi viaje" })).toHaveCount(0);

  const mios = await page.request.get("/api/erp/combustible/viajes/mios");
  const fila = ((await mios.json()).data as { id: string; mi_rol: string }[]).find(
    (x) => x.id === v.viajeId
  );
  expect(fila?.mi_rol).toBe("relevo");

  await darDeBajaAlConductor(page, v);
});
