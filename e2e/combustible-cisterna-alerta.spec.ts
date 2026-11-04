/** e2e/combustible-cisterna-alerta.spec.ts
 *
 * El plazo de la alerta "cisterna con saldo" (0170) en "Configurar alertas":
 * bajarlo se guarda directo; subirlo afloja la vigilancia y pide el motivo antes
 * de guardar nada.
 *
 * Por qué en un navegador real: la regla del servidor la cubren los tests de
 * API. Lo que solo se ve acá es que el campo exista, que guarde, y que al subir
 * el plazo la pantalla pida el motivo en vez de fallar callada.
 */
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const config = async (page: Page) =>
  (await (await page.request.get("/api/erp/combustible/config")).json()) as Record<string, unknown>;

/** Deja el plazo en `dias` por API (con motivo, por si afloja). */
async function fijarPlazo(page: Page, dias: number) {
  const actual = await config(page);
  const r = await page.request.put("/api/erp/combustible/config", {
    data: { ...actual, dias_cisterna_con_saldo: dias, motivo_ajuste: "preparar la prueba e2e" },
  });
  expect(r.status(), "no se pudo fijar el plazo de partida").toBe(200);
}

test("Configurar alertas: el plazo de la cisterna baja directo y subirlo pide motivo", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await fijarPlazo(page, 10);
  try {
    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await page.getByRole("button", { name: "Tanques", exact: true }).click();
    await page.getByRole("button", { name: "Configurar alertas" }).click();

    const plazo = page.locator("#dias-cisterna");
    await expect(plazo).toBeVisible();
    await expect(plazo).toHaveValue("10");
    const guardar = page.getByRole("button", { name: "Guardar", exact: true });

    // Bajarlo endurece: se guarda sin pedir nada.
    await plazo.fill("5");
    await guardar.click();
    await expect(page.getByText(/^Guardado/)).toBeVisible();
    expect((await config(page)).dias_cisterna_con_saldo).toBe(5);

    // Subirlo afloja: la pantalla pide el motivo y no guarda todavía.
    await plazo.fill("20");
    await guardar.click();
    await expect(page.getByText(/reduce la vigilancia/)).toBeVisible();
    expect((await config(page)).dias_cisterna_con_saldo).toBe(5);

    // Con el motivo, se guarda.
    await page.getByPlaceholder(/motivo/i).fill("La cisterna se queda dos semanas en esta obra");
    await guardar.click();
    await expect(page.getByText(/^Guardado/)).toBeVisible();
    expect((await config(page)).dias_cisterna_con_saldo).toBe(20);
  } finally {
    await fijarPlazo(page, 10);
  }
});
