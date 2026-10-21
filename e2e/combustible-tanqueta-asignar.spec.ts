/** e2e/combustible-tanqueta-asignar.spec.ts
 *
 * La pestaña Tanquetas asigna una tanqueta con saldo a la unidad que la lleva
 * (0139) y la libera con motivo. El preparativo va por API: el tanque, la
 * tanqueta y el vale que la llena.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("tanqueta: se asigna a una unidad desde la pestaña y se libera con motivo", async ({
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

  // Liberar pide motivo: sin él, el botón no se habilita.
  await page.getByRole("button", { name: `Asignar ${codigo} a una unidad` }).click();
  await expect(page.getByRole("button", { name: "Liberar" })).toBeDisabled();
  await page.locator("#liberar-motivo").fill("Volvió al grifo con saldo");
  await page.getByRole("button", { name: "Liberar" }).click();
  await expect(page.getByText(`Va con la unidad ${placa}`)).toHaveCount(0);
});
