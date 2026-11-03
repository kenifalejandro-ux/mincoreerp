/** e2e/alertas-por-modulo.spec.ts
 *
 * La campanita y la Bandeja de alertas agrupan por módulo (Combustible, Urea, Flota).
 * Lo que se fija sin sembrar alertas: la campanita se llama "Alertas" y la Bandeja ofrece
 * el filtro "Módulo", que limita los tipos al módulo elegido y pide al servidor
 * `modulo=...`. (Que cada alerta caiga en su módulo y que cada persona vea solo las suyas
 * lo cubre tests/alertas-por-modulo.test.ts, que sí siembra alertas.)
 */
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("la campanita se llama Alertas", async ({ page }) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const campanita = page.getByTitle("Alertas", { exact: true });
  await expect(campanita).toBeVisible();
  await campanita.click();
  await expect(page.getByText("Alertas", { exact: true }).first()).toBeVisible();
  await expect(page.getByTitle("Alertas de combustible")).toHaveCount(0);
});

test("la Bandeja filtra por módulo: limita los tipos y se lo pide al servidor", async ({
  page,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await page.getByRole("button", { name: /^Bandeja/ }).click();
  await expect(page.getByRole("heading", { name: "Bandeja de alertas" })).toBeVisible();

  // Hay también una lista de pestañas llamada "Módulo": el filtro es el desplegable.
  const modulo = page.getByRole("combobox", { name: "Módulo" });
  const tipo = page.getByRole("combobox", { name: "Tipo de alerta" });
  // El filtro ofrece los tres módulos y todos los tipos.
  await expect(modulo.getByRole("option", { name: "Combustible" })).toHaveCount(1);
  await expect(modulo.getByRole("option", { name: "Urea" })).toHaveCount(1);
  await expect(modulo.getByRole("option", { name: "Flota" })).toHaveCount(1);
  await expect(tipo.getByRole("option", { name: "Hueco de talonario" })).toHaveCount(1);
  await expect(tipo.getByRole("option", { name: "Viaje demorado" })).toHaveCount(1);

  // Flota: solo sus tipos, y el servidor recibe el filtro.
  const pedida = page.waitForRequest(
    (r) => r.url().includes("/api/erp/combustible/alertas") && r.url().includes("modulo=flota")
  );
  await modulo.selectOption("flota");
  await pedida;
  await expect(tipo.getByRole("option", { name: "Viaje demorado" })).toHaveCount(1);
  await expect(tipo.getByRole("option", { name: "Unidad detenida" })).toHaveCount(1);
  await expect(tipo.getByRole("option", { name: "Hueco de talonario" })).toHaveCount(0);

  // Volver a todos los módulos devuelve todos los tipos.
  await modulo.selectOption("");
  await expect(tipo.getByRole("option", { name: "Hueco de talonario" })).toHaveCount(1);
});
