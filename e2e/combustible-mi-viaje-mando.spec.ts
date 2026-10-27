/** e2e/combustible-mi-viaje-mando.spec.ts
 *
 * La entrega del mando entre titular y relevo (0153): el titular entrega SIN señal (queda en la
 * cola y se ve como pendiente), el relevo la acepta desde su celular y pasa a manejar él.
 * El preparativo va por API (ver el fixture).
 */
import { test, expect } from "@playwright/test";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  iniciarMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";

test("el titular entrega el mando sin señal y el relevo lo acepta", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const v = await prepararViajeDeConductor(page, { conRelevo: true });
  await entrarAMiViaje(page, v);
  await iniciarMiViaje(page, "100");
  await expect(page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true })).toBeVisible();

  // ── El titular entrega sin señal ───────────────────────────────────────
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Entregar el mando" }).click();
  await page.getByLabel(/que marca el tablero al entregar/).fill("150");
  await page.getByRole("button", { name: "Entregar el mando" }).click();
  await expect(page.getByText(/Sin señal: quedó guardado en el celular/)).toBeVisible();
  await expect(page.getByText(/Esperando que .* acepte el mando/)).toBeVisible();
  await page.context().setOffline(false);

  const pendiente = async () => {
    const mios = await page.request.get("/api/erp/combustible/viajes/mios");
    const fila = ((await mios.json()).data as { id: string; entrega_pendiente: unknown }[]).find(
      (x) => x.id === v.viajeId
    );
    return Boolean(fila?.entrega_pendiente);
  };
  await expect
    .poll(pendiente, { message: "la cola tiene que enviar la entrega", timeout: 60_000 })
    .toBe(true);

  // ── El relevo la ve y la acepta desde su celular ───────────────────────
  const otro = await browser.newContext();
  try {
    const pagina = await otro.newPage();
    await entrarAMiViaje(pagina, v, v.relevo!);
    await expect(pagina.getByText(/te entrega el mando/)).toBeVisible();
    await pagina.getByRole("button", { name: "Aceptar el mando" }).click();
    await expect(pagina.getByText("Tienes el mando. ¡Buen viaje!")).toBeVisible();
    await expect(pagina.getByText(`Relevo ${v.marca} toma el mando`)).toBeVisible();
    // Ya maneja él: puede marcar la llegada.
    await expect(
      pagina.getByRole("button", { name: `Llegué a ${v.b}`, exact: true })
    ).toBeVisible();
  } finally {
    await otro.close();
  }

  // El titular ya no va al volante: su pantalla se entera sola (tiempo real).
  await expect(page.getByText(/Tú puedes descansar/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ahora-siguiente")).toContainText(`Va manejando Relevo ${v.marca}`);
  expect(await pendiente()).toBe(false);

  await darDeBajaAlConductor(page, v);

  // ── La oficina ve quién manejó cada tramo ──────────────────────────────
  await page.goto("/");
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Viajes" }).click();
  await page
    .getByRole("row")
    .filter({ hasText: `${v.a} → ${v.b} → ${v.a}` })
    .first()
    .click();
  const manejo = page.getByText("Quién manejó").locator("..");
  await expect(manejo).toBeVisible();
  await expect(manejo).toContainText(`Conductor ${v.marca}`);
  await expect(manejo).toContainText(v.relevo!.nombre);
  await expect(manejo).toContainText("50"); // el titular manejó de 100 a 150
});
