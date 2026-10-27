/** e2e/combustible-mi-viaje-paradas.spec.ts
 *
 * "Mi viaje" con un viaje de ida y vuelta (0148): el conductor sale, llega a la parada, sale de
 * nuevo y termina al volver al punto de salida. El preparativo va por API (ver el fixture).
 */
import { test, expect } from "@playwright/test";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  iniciarMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";

test("el conductor hace un viaje de ida y vuelta: llega, sale y termina", async ({ page }) => {
  test.setTimeout(120_000);
  const v = await prepararViajeDeConductor(page, { programadoHaceMin: 20 });
  await entrarAMiViaje(page, v);
  const odometro = page.getByLabel(/que marca el tablero/);
  const ahora = page.getByTestId("ahora-siguiente");
  await expect(ahora).toContainText("Revisar el viaje");
  await iniciarMiViaje(page, "100");
  // Debía salir hace 20 min y la tolerancia es de 10: sale en rojo, "tarde".
  await expect(page.getByText(/^Salió \d+ min tarde$/)).toBeVisible();
  await expect(ahora).toContainText(`Llegar a ${v.b}`);

  // En ruta hacia la parada: un solo botón; llegar a B no cierra el viaje.
  await expect(page.getByText(`En ruta a ${v.b}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true }).click();
  await odometro.fill("150");
  await page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true }).click();
  await expect(page.getByText("Llegada registrada.")).toBeVisible();

  // En la parada: sale hacia A; el odómetro viene con la lectura de la llegada.
  await expect(page.getByText(`En ${v.b} · sigue a ${v.a}`, { exact: true })).toBeVisible();
  await expect(ahora).toContainText(`Salir hacia ${v.a}`);
  await page.getByRole("button", { name: `Salir hacia ${v.a}`, exact: true }).click();
  await expect(odometro).toHaveValue("150");
  await page.getByRole("button", { name: `Salir hacia ${v.a}`, exact: true }).click();
  await expect(page.getByText(/Salida registrada/)).toBeVisible();

  // De vuelta al punto de salida se dice que retorna.
  await expect(page.getByText(`Retornando a ${v.a}`, { exact: true })).toBeVisible();
  await expect(ahora).toContainText(`Llegar a ${v.a} y terminar el viaje`);

  // Llegar a la última parada cierra el viaje.
  await page.getByRole("button", { name: `Llegué a ${v.a} · terminar viaje` }).click();
  await odometro.fill("250");
  await page.getByRole("button", { name: `Llegué a ${v.a} · terminar viaje` }).click();
  await expect(page.getByText("Viaje terminado.")).toBeVisible();
  // La línea de tiempo cuenta también la parada intermedia, y termina donde terminó el viaje.
  await expect(page.getByText(`Llegada a ${v.b}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Salida de ${v.b}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Llegada a ${v.a}`, { exact: true })).toBeVisible();

  const mios = await page.request.get("/api/erp/combustible/viajes/mios");
  const cerrado = ((await mios.json()).data as { id: string; estado: string }[]).find(
    (x) => x.id === v.viajeId
  );
  expect(cerrado?.estado).toBe("cerrado");

  await darDeBajaAlConductor(page, v);
});
