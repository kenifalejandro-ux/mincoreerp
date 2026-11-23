/** e2e/proveedores-exportar.spec.ts
 *
 * Exportar el Directorio a Excel: «Exportar a Excel» baja un .xlsx con lo que se ve en la tabla (con la búsqueda
 * aplicada) y la exportación queda en el Historial. Sin filas que exportar, el botón no hace nada.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { test, expect } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const BUSCADOR = "Buscar por razón social, RUC, código o ciudad...";

test("exportar el directorio a Excel baja el archivo y queda en el Historial", async ({ page }) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  for (const n of ["UNO", "DOS"]) {
    const r = await page.request.post("/api/erp/proveedores", {
      data: {
        nombre: `GRIFO EXPORTA ${n} ${marca}`,
        ruc: "",
        abastece_tanque: false,
        abastece_ruta: true,
        abastece_urea: false,
        abastece_urea_ruta: false,
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }

  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await page.getByPlaceholder(BUSCADOR).fill(`EXPORTA UNO ${marca}`);
  await expect(page.getByRole("row", { name: new RegExp(`EXPORTA UNO ${marca}`) })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("row", { name: new RegExp(`EXPORTA DOS ${marca}`) })).toHaveCount(0);

  // Baja el archivo con lo que se ve en la tabla (un solo proveedor).
  const descarga = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar a Excel" }).click();
  const archivo = await descarga;
  expect(archivo.suggestedFilename()).toMatch(/^proveedores-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const ruta = await archivo.path();
  const bytes = readFileSync(ruta);
  // Un .xlsx es un zip («PK»).
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.length).toBeGreaterThan(1000);
  // Dentro, la hoja trae al proveedor filtrado y no al otro (el texto está en el zip comprimido: se
  // comprueba en el Historial cuántos se exportaron).
  await expect(page.getByRole("button", { name: "Exportar a Excel" })).toBeEnabled();

  // El Historial lo cuenta: quién exportó y cuántos (uno, filtrado).
  await menu.getByRole("button", { name: "Historial y auditoría" }).click();
  await page.getByLabel("Tipo").selectOption("proveedor");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByText("Exportó el directorio a Excel").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("1 proveedor", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Solo lo filtrado en pantalla").first()).toBeVisible();

  // Sin filas que exportar, el botón se apaga.
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await page.getByPlaceholder(BUSCADOR).fill(`NADA COINCIDE ${marca}`);
  await expect(page.getByRole("button", { name: "Exportar a Excel" })).toBeDisabled();
});
