/** e2e/combustible-tanqueta-asignar.spec.ts
 *
 * La pestaña Tanquetas asigna una tanqueta con saldo a la unidad que la lleva
 * (0139) y la recibe de vuelta (0143), con motivo si el saldo que volvió no coincide, y
 * mandando el saldo al tanque (0145). El preparativo va por API: el tanque, la tanqueta y el
 * vale que la llena.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("tanqueta: se asigna a una unidad desde la pestaña y se recibe de vuelta", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `HMC-${marca}`,
      tanque_nombre: `Huamachuco ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 8000,
      requiere_documento: false,
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status()).toBe(201);
  const tqt = await page.request.post("/api/erp/combustible/tanquetas", {
    data: { grifo_interno_id: grifoInternoId, codigo: `TQ-${marca}` },
  });
  expect(tqt.status()).toBe(201);
  const { id: tanquetaId, codigo } = await tqt.json();
  const placa = `VQ-${marca}`;
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: placa,
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(equipo.status()).toBe(201);
  const vale = await page.request.post("/api/erp/combustible/despachos", {
    data: {
      origen: "tanque_propio",
      combustible_id: (await tanque.json()).id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: Number(tanquetaId),
      serie_talonario: `A${marca}`,
      n_vale: 1,
      cantidad: 200,
      lectura_contometro: 200,
      costo_unitario: 16,
    },
  });
  expect(vale.status()).toBe(201);

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Tanquetas" }).click();

  await page.getByRole("button", { name: `Asignar ${codigo} a una unidad` }).click();
  await page.locator("#asignar-unidad").selectOption({ label: placa });
  // Al elegir la unidad se pide el vale de la salida (0141): sin él no se asigna.
  await expect(page.locator("#asignar-serie")).toBeVisible();
  await expect(page.getByRole("button", { name: "Asignar", exact: true })).toBeDisabled();
  await page.locator("#asignar-serie").fill(`S${marca}`);
  await page.locator("#asignar-vale").fill("1");
  await page.getByRole("button", { name: "Asignar", exact: true }).click();
  await expect(page.getByText(`Va con la unidad ${placa}`)).toBeVisible();

  // Si lo que volvió no coincide con el saldo calculado, el motivo es obligatorio.
  await page.getByRole("button", { name: `Recibir ${codigo} de vuelta` }).click();
  await page.locator("#retorno-volvio").fill("190");
  await expect(page.getByRole("button", { name: "Registrar retorno" })).toBeDisabled();
  await page.locator("#retorno-motivo").fill("Se derramó al bajarla");
  // Nada viene elegido: sin decir a dónde va el saldo no se puede registrar.
  const registrar = page.getByRole("button", { name: "Registrar retorno" });
  await expect(registrar).toBeDisabled();
  // Vuelve al tanque (pozo): pide el tanque de la sede y recién entonces se puede registrar.
  await page.getByLabel("Volver al tanque (pozo)").check();
  await expect(registrar).toBeDisabled();
  const opcionTanque = page.locator("#retorno-tanque option", { hasText: `HMC-${marca}` });
  await page.locator("#retorno-tanque").selectOption((await opcionTanque.getAttribute("value"))!);
  await expect(registrar).toBeEnabled();
  await registrar.click();
  await expect(page.getByText(`Va con la unidad ${placa}`)).toHaveCount(0);
});
