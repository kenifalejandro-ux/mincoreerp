/** e2e/maestro-unidades-combustible.spec.ts
 *
 * Las unidades son un maestro único: las mantiene Flota o Mantenimiento. Con una empresa que tiene
 * Combustible y Mantenimiento pero NO Flota, el asistente de «Compra en ruta» ofrece la unidad que se
 * registró en Mantenimiento: la elige de una lista con buscador, en vez de pedir la placa escrita (que es lo
 * que ve una empresa sin ningún módulo de unidades, ver combustible-compra-ruta-placa-escrita.spec.ts).
 * Una unidad que Mantenimiento quita deja de ofrecerse. El resto (vale, historial con placa, urea,
 * excedente) lo cubre tests/combustible-con-mantenimiento.test.ts en el servidor.
 *
 * La empresa es nueva (no hay API para borrarlas): la base de los e2e es efímera en CI.
 */
import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

test("sin Flota, Combustible ofrece las unidades de Mantenimiento y deja de ofrecer la que se quita", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const placa = `MNC-${marca}`;
  const empresa = await crearEmpresaSola(request, ["combustible", "mantenimiento"], "maestrocomb");
  const menuCombustible = page.getByRole("button", { name: /^Combustible Abrir submenú$/ });
  await entrarPorPrimeraVez(page, empresa, menuCombustible);

  // De verdad no tiene Flota: su lista de equipos no existe para esta persona.
  expect((await page.request.get("/api/erp/equipos")).status()).toBe(403);

  // La unidad vive en Mantenimiento. Se registra ANTES de abrir la pantalla: la lista de unidades se pide
  // al abrirla.
  const unidad = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: {
      placa_codigo: placa,
      tipo: "Volquete",
      medidor: "odometro",
      lectura: 10,
      propiedad: "propia",
    },
  });
  expect(unidad.status(), await unidad.text()).toBe(201);
  const unidadId = (await unidad.json()).id as number;

  await menuCombustible.click();
  await page.getByRole("button", { name: "Compra en ruta" }).click();
  await expect(page.getByRole("heading", { name: "Compra en ruta", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Registrar compra", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Registrar compra en ruta" })).toBeVisible();

  // La unidad es un buscador con la lista de Mantenimiento, no un campo de texto para escribir la placa.
  const campo = page.locator("#compra-unidad");
  await expect(campo).toBeVisible();
  expect(await campo.evaluate((el) => el.tagName)).not.toBe("INPUT");
  await campo.click();
  await page.locator('input[aria-controls="compra-unidad-lista"]').fill(placa);
  await expect(
    page.locator('#compra-unidad-lista [role="option"]').filter({ hasText: placa })
  ).toHaveCount(1);

  // Mantenimiento la quita: Combustible deja de ofrecerla.
  const quitar = await page.request.patch(`/api/erp/mantenimiento/equipos/${unidadId}/quitar`, {
    data: { motivo: "Vendido" },
  });
  expect(quitar.status(), await quitar.text()).toBe(200);
  const ofrecidas = await page.request.get("/api/erp/combustible/equipos-destino?pageSize=200");
  expect(ofrecidas.status()).toBe(200);
  expect(
    ((await ofrecidas.json()).data as { placa_codigo: string }[]).map((u) => u.placa_codigo)
  ).not.toContain(placa);
});
