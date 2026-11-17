/** e2e/alertas-por-modulo.spec.ts
 *
 * La Bandeja de alertas tiene una pestaña por módulo: Combustible (con Urea, filtrable por módulo) y
 * Viajes (0188, otra tabla y otro endpoint). Lo que se fija sin sembrar alertas: la campanita se
 * llama "Alertas", la pestaña de Combustible limita los tipos al módulo elegido y pide al servidor
 * `modulo=...`, y la de Viajes lee `/api/erp/viajes/alertas` con sus propios tipos. (Que cada alerta
 * caiga en su módulo y que cada persona vea solo las suyas lo cubre tests/alertas-por-modulo.test.ts,
 * que sí siembra alertas.)
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

test("la Bandeja tiene una pestaña por módulo: Combustible filtra por módulo y Viajes tiene sus propios tipos", async ({
  page,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await page.getByRole("button", { name: /^Bandeja/ }).click();
  await expect(page.getByRole("heading", { name: "Bandeja de alertas" })).toBeVisible();

  // Una pestaña por módulo que la persona tiene (hay también pestañas de estado: se busca por nombre).
  await expect(page.getByRole("tab", { name: "Combustible", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Viajes", exact: true })).toBeVisible();

  // Combustible: el filtro de módulo ofrece Combustible y Urea (Flota ya no: tiene su propia pestaña),
  // y los tipos son los suyos, sin los de viaje.
  const modulo = page.getByRole("combobox", { name: "Módulo" });
  const tipo = page.getByRole("combobox", { name: "Tipo de alerta" });
  await expect(modulo.getByRole("option", { name: "Combustible" })).toHaveCount(1);
  await expect(modulo.getByRole("option", { name: "Urea" })).toHaveCount(1);
  await expect(modulo.getByRole("option", { name: "Flota" })).toHaveCount(0);
  await expect(tipo.getByRole("option", { name: "Hueco de talonario" })).toHaveCount(1);
  await expect(tipo.getByRole("option", { name: "Viaje demorado" })).toHaveCount(0);

  // El filtro le pide al servidor `modulo=urea`, y los tipos se limitan a Urea.
  const pedida = page.waitForRequest(
    (r) => r.url().includes("/api/erp/combustible/alertas") && r.url().includes("modulo=urea")
  );
  await modulo.selectOption("urea");
  await pedida;
  await expect(tipo.getByRole("option", { name: "Hueco de talonario" })).toHaveCount(0);
  await modulo.selectOption("");
  await expect(tipo.getByRole("option", { name: "Hueco de talonario" })).toHaveCount(1);

  // Viajes: otra fuente (/api/erp/viajes/alertas), sin filtro de módulo y solo con sus tipos.
  const deViajes = page.waitForRequest((r) => r.url().includes("/api/erp/viajes/alertas"));
  await page.getByRole("tab", { name: "Viajes", exact: true }).click();
  await deViajes;
  await expect(page.getByRole("combobox", { name: "Módulo" })).toHaveCount(0);
  await expect(tipo.getByRole("option", { name: "Viaje demorado" })).toHaveCount(1);
  await expect(tipo.getByRole("option", { name: "Unidad detenida" })).toHaveCount(1);
  await expect(tipo.getByRole("option", { name: "Hueco de talonario" })).toHaveCount(0);
});
