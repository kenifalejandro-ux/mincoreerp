/** e2e/combustible-viaje-corregir-mando.spec.ts
 *
 * La oficina corrige un cambio de mando que nadie marcó (0154): en un viaje ya hecho con titular y
 * relevo, parte el turno a esa hora y "Quién manejó" muestra los dos tramos, con el motivo.
 * Es de oficina (con señal): no lleva modo offline. El preparativo va por API (ver el fixture).
 */
import { test, expect } from "@playwright/test";
import { darDeBajaAlConductor, prepararViajeDeConductor } from "./fixtures/conductorConViaje";

/** "2026-10-26T11:30" en la hora local, como lo pide un campo datetime-local. */
const localDeHaceHoras = (h: number) => {
  const d = new Date(Date.now() - h * 3_600_000);
  const dos = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}`;
};

test("la oficina corrige un cambio de mando olvidado y se ven los dos tramos", async ({ page }) => {
  test.setTimeout(120_000);
  const v = await prepararViajeDeConductor(page, { conRelevo: true, retroactivo: true });

  await page.goto("/");
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Viajes" }).click();
  await page
    .getByRole("row")
    .filter({ hasText: `${v.a} → ${v.b}` })
    .first()
    .click();

  // Con un solo conductor al volante todavía no hay "Quién manejó".
  await expect(page.getByText("Quién manejó")).toHaveCount(0);

  await page.getByRole("button", { name: "Corregir cambio de mando" }).click();
  await page.getByLabel("Quién pasó a manejar").selectOption({ label: v.relevo!.nombre });
  await page.getByLabel("Fecha y hora real del cambio").fill(localDeHaceHoras(6));
  await page.getByLabel(/en el cambio$/).fill("250");
  await page.getByLabel("Lugar (opcional)").fill("Grifo del camino");

  const corregir = page.getByRole("button", { name: "Corregir", exact: true });
  await expect(corregir).toBeDisabled(); // falta el motivo
  await page.getByLabel("Motivo de la corrección").fill("no lo marcaron, avisó el titular");
  await corregir.click();

  const manejo = page.getByText("Quién manejó").locator("..");
  await expect(manejo).toBeVisible();
  await expect(manejo).toContainText(`Conductor ${v.marca}`);
  await expect(manejo).toContainText(v.relevo!.nombre);
  await expect(manejo).toContainText("Grifo del camino");
  await expect(manejo).toContainText("Cambio corregido por la oficina: no lo marcaron");
  await expect(manejo).toContainText("150"); // el titular manejó de 100 a 250; el relevo, de 250 a 400

  await darDeBajaAlConductor(page, v);
});
