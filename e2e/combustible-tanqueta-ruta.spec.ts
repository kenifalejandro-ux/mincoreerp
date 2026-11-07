/** e2e/combustible-tanqueta-ruta.spec.ts
 *
 * El ciclo de la tanqueta en la pantalla (0114): se llena desde el tanque con
 * un vale a "Reserva en cubeta" eligiendo la tanqueta, y el panel de Tanquetas
 * muestra el saldo. La carga desde la tanqueta es del conductor, no de este formulario.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("tanqueta: previsión desde el tanque y carga en ruta", async ({ page }) => {
  // Cuatro formularios seguidos: los 30 s por defecto no alcanzan.
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // El grifo que ya existe: crear otro rompe las specs que crean equipos sin
  // grifo (el tenant e2e es compartido y todo corre en paralelo).
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
  const tanqueId = (await tanque.json()).id as number;
  const tqt = await page.request.post("/api/erp/combustible/tanquetas", {
    data: { grifo_interno_id: grifoInternoId, codigo: `TQ-${marca}` },
  });
  expect(tqt.status()).toBe(201);
  const codigoTanqueta = (await tqt.json()).codigo as string;
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

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();

  // ── 3c: previsión desde el tanque a la tanqueta ────────────────────────
  await page.getByRole("button", { name: "Registrar despacho" }).first().click();
  await page.locator("#despacho-tanque").selectOption(String(tanqueId));
  await page.locator("#despacho-cantidad").fill("280");
  await page.locator("#despacho-contometro").fill("280");
  await page.locator("#despacho-tipo-destino").selectOption("reserva_cubeta");
  await page
    .locator("#despacho-tanqueta-destino")
    .selectOption({ label: `${codigoTanqueta} (libre 280 gal)` });
  // La unidad que la lleva (0139): se asigna al llenarla.
  await page.locator("#despacho-tanqueta-equipo").selectOption({ label: `${placa} — VOLQUETE` });
  await page.locator("#despacho-costo-unitario").fill("16");
  await page.locator("#despacho-serie").fill(`P${marca}`);
  await page.locator("#despacho-n-vale").fill("1");
  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(page.getByText(/Despacho registrado/)).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();

  // El tanque bajó solo por la previsión (8000 - 280).
  const ficha = await (await page.request.get(`/api/erp/combustible/${tanqueId}`)).json();
  expect(Number(ficha.nivel_teorico)).toBe(7720);

  // ── El panel: la tanqueta con 180 de 280 ───────────────────────────────
  await page.getByRole("button", { name: "Tanquetas" }).click();
  const tarjeta = page
    .locator("div", { has: page.getByText(codigoTanqueta, { exact: true }) })
    .last();
  // Recién llena: 280 de 280.
  await expect(tarjeta.getByText(/libre 0 gal/)).toBeVisible();
  await expect(tarjeta.getByText(`Va con la unidad ${placa}`)).toBeVisible();
});
