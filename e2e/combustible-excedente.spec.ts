/** e2e/combustible-excedente.spec.ts
 *
 * El excedente de una recepción que no cabe se reparte (0110): popup con las
 * tres opciones, división entre destinos y registro por lo que sí cabe.
 *
 * Por qué en un navegador real: la API ya está cubierta por tests de
 * servidor. Lo que solo se ve acá es que el botón NO se bloquee en un tanque
 * "flexible" (antes la pantalla nunca llegaba al 409), que el popup aparezca,
 * que no deje guardar si el reparto no cuadra y que la recepción quede
 * guardada por lo que cabe.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("nuevo tanque: sin tolerancia, capacidad 10000 por defecto, y el excedente se reparte", async ({
  page,
}) => {
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `EX-${marca}`,
      tanque_nombre: `Tanque excedente ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 9000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
    },
  });
  expect(tanque.status(), "no se pudo crear el tanque de prueba").toBe(201);
  const tanqueId = (await tanque.json()).id as number;
  const grifo = await page.request.post("/api/erp/combustible/grifos", {
    data: { nombre: `CISTERNA ${marca}` },
  });
  expect(grifo.status()).toBe(201);

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();

  // ── El formulario de "Nuevo tanque" ────────────────────────────────────
  await page
    .getByRole("button", { name: /Nuevo Tanque/ })
    .first()
    .click();
  await expect(page.locator("#tanque-tolerancia")).toHaveCount(0);
  await expect(page.getByText("Tolerancia de capacidad")).toHaveCount(0);
  await expect(page.locator("#tanque-capacidad")).toHaveValue("10000");
  await page.getByLabel(/dejar decidir en vez de rechazar/).check();
  await expect(page.getByText("Pasar el excedente a tanquetas o cubetas")).toBeVisible();
  await expect(page.getByText("Cargarlo directamente de la cisterna")).toBeVisible();
  await expect(page.getByText("Devolverlo al proveedor")).toBeVisible();
  await expect(page.getByText("Tope adicional del excedente")).toHaveCount(0);
  await page.reload();

  // ── La recepción que no cabe: 9000 + 1200 = 10200, sobran 200 ──────────
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Registrar recepción" }).first().click();
  await page.locator("#recepcion-tanque").selectOption(String(tanqueId));
  await page.locator("#recepcion-grifo").selectOption({ label: `CISTERNA ${marca}` });
  await page.locator("#recepcion-cantidad").fill("1200");
  await page.locator("#recepcion-costo").fill("17.5");

  const registrar = page.locator("form").getByRole("button", { name: "Registrar recepción" });
  await expect(registrar, "en un tanque flexible el botón no se bloquea").toBeEnabled();
  await registrar.click();

  await expect(page.getByText("La recepción no cabe en el tanque")).toBeVisible();
  const confirmar = page.getByRole("button", { name: "Registrar con este reparto" });
  // Vino precargado con todo el excedente a cubeta: cuadra.
  await expect(confirmar).toBeEnabled();

  // Un reparto que no cuadra no se puede guardar.
  await page.locator("#exc-cantidad-0").fill("150");
  await expect(page.getByText(/Faltan 50/)).toBeVisible();
  await expect(confirmar).toBeDisabled();

  // Dividir: 150 a cubeta + 50 devueltos.
  await page.getByRole("button", { name: "+ Dividir en otro destino" }).click();
  await page.locator("#exc-destino-1").selectOption("devolucion");
  await expect(page.getByText("El reparto cubre todo el excedente.")).toBeVisible();
  await confirmar.click();

  await expect(page.getByText(/Recepción registrada/)).toBeVisible();

  // Al tanque entraron los 1000 que caben; la entrega fue de 1200.
  const lista = await page.request.get(
    `/api/erp/combustible/recepciones?combustible_id=${tanqueId}`
  );
  const filas = (await lista.json()).data as { cantidad: string; cantidad_derivada: string }[];
  expect(filas).toHaveLength(1);
  expect(Number(filas[0].cantidad)).toBe(1000);
  expect(Number(filas[0].cantidad_derivada)).toBe(200);
});
