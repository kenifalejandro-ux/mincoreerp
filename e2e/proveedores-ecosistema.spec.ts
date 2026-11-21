/** e2e/proveedores-ecosistema.spec.ts
 *
 * Ecosistema «Gestión de proveedores» (PR1, solo lectura). Lo que se fija en la pantalla, con el
 * admin del tenant sembrado (que tiene todos los módulos):
 *
 * 1. En el menú del ERP está «Gestión de proveedores» y su submenú «Centro de administración».
 * 2. Al entrar aparece la pantalla de carga y después el ecosistema, FUERA del menú del ERP: ya no hay
 *    «Dashboard» ni «Combustible», hay el menú propio del ecosistema.
 * 3. El Directorio muestra un proveedor sembrado, con su uso Interno / Externo, y se puede abrir su ficha.
 * 4. «Volver al ERP» pasa otra vez por la pantalla de carga y devuelve al menú del ERP.
 */
import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("entrar al ecosistema, ver el directorio y volver al ERP", async ({ page }) => {
  const nombre = `PROVEEDOR E2E ${randomBytes(3).toString("hex").toUpperCase()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);

  // Un proveedor propio de este test: interno de combustible, no externo.
  const alta = await page.request.post("/api/erp/combustible/grifos", {
    data: { nombre, abastece_tanque: true, abastece_ruta: false },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();

  // 1. La puerta está en el menú del ERP: la entrada despliega, el submenú entra.
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();

  // 2. Pantalla de carga y después el ecosistema, con su propio menú.
  await expect(page.getByTestId("pantalla-de-carga")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Gestión de proveedores", level: 2 })
  ).toBeVisible();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pantalla-de-carga")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /^(Buenos días|Buenas tardes|Buenas noches)/ })
  ).toBeVisible();
  // Ya no está el menú del ERP.
  await expect(page.getByRole("button", { name: "Dashboard" })).toHaveCount(0);

  // Lo que todavía no existe se dice «Pronto», sin pantalla de ejemplo.
  await menu.getByRole("button", { name: /Compras y recepciones/ }).click();
  await expect(
    page.getByRole("heading", { name: "Compras y recepciones", level: 2 })
  ).toBeVisible();

  // 3. El directorio lista el proveedor sembrado y abre su ficha.
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible();
  await page.getByPlaceholder("Buscar por nombre, código o RUC").fill(nombre);
  const fila = page.getByRole("row", { name: new RegExp(nombre) });
  await expect(fila).toBeVisible({ timeout: 20_000 });
  await expect(fila.getByText("Interno", { exact: true })).toBeVisible();
  await expect(fila.getByText("Externo", { exact: true })).toHaveCount(0);
  await fila.getByRole("button", { name: new RegExp(nombre) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Volver al directorio" }).click();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible();

  // 4. Volver al ERP también pasa por la pantalla de carga.
  await page.getByRole("button", { name: "Volver al ERP" }).click();
  await expect(page.getByTestId("pantalla-de-carga")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pantalla-de-carga")).toHaveCount(0);
});
