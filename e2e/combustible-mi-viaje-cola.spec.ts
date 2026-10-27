/** e2e/combustible-mi-viaje-cola.spec.ts
 *
 * Mi viaje con varios viajes programados: el conductor ve su cola en orden por hora programada y
 * solo el primero se puede iniciar (el servidor rechaza el resto, ver tests/combustible-viajes).
 * El preparativo va por API (ver el fixture).
 */
import { test, expect } from "@playwright/test";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";

test("el conductor ve su cola de viajes y solo puede iniciar el primero", async ({ page }) => {
  test.setTimeout(120_000);
  const v = await prepararViajeDeConductor(page, { enCola: 2 });
  await entrarAMiViaje(page, v);

  const cola = page.getByTestId("cola-viajes");
  await expect(cola).toBeVisible();
  const items = cola.getByRole("listitem");
  await expect(items).toHaveCount(3);
  // El primero es el de la hora más cercana (el que se ofrece arriba); los otros esperan a ese.
  await expect(items.nth(0)).toContainText(`V-${v.numero}`);
  await expect(items.nth(0)).toContainText("Primero");
  await expect(items.nth(1)).toContainText(`Espera al V-${v.numero}`);
  await expect(items.nth(2)).toContainText(`Espera al V-${v.numero}`);
  await expect(page.getByRole("button", { name: "Revisar mi viaje" })).toHaveCount(1);

  await darDeBajaAlConductor(page, v);
});

test("con un solo viaje no hay cola que mostrar", async ({ page }) => {
  test.setTimeout(120_000);
  const v = await prepararViajeDeConductor(page);
  await entrarAMiViaje(page, v);
  await expect(page.getByRole("button", { name: "Revisar mi viaje" })).toBeVisible();
  await expect(page.getByTestId("cola-viajes")).toHaveCount(0);
  await darDeBajaAlConductor(page, v);
});
