/** e2e/combustible-tanqueta-ruta.spec.ts
 *
 * El ciclo de la tanqueta en la pantalla (0114): se llena desde el tanque con
 * un vale a "Reserva en cubeta" eligiendo la tanqueta, se carga en ruta desde
 * ella con el medidor de la unidad, y el panel de Tanquetas muestra el saldo.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("tanqueta: previsión desde el tanque y carga en ruta", async ({ page }) => {
  // Cuatro formularios seguidos: los 30 s por defecto no alcanzan.
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // Sede propia de la corrida: el tenant e2e sobrevive entre corridas.
  const sedes = (await (await page.request.get("/api/erp/sedes")).json()).sedes;
  const grifoSede = await page.request.post("/api/erp/administracion/grifos", {
    data: { sede_id: sedes[0].id, nombre: `Huamachuco ${marca}` },
  });
  expect(grifoSede.status()).toBe(201);
  const grifoInternoId = (await grifoSede.json()).id as number;

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
  await page.locator("#despacho-costo-unitario").fill("16");
  await page.locator("#despacho-serie").fill(`P${marca}`);
  await page.locator("#despacho-n-vale").fill("1");
  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(page.getByText(/Despacho registrado/)).toBeVisible();

  // ── 3b: carga en ruta desde la tanqueta ────────────────────────────────
  await page.getByRole("button", { name: "Registrar despacho" }).first().click();
  await page.locator("#despacho-origen").selectOption("tanqueta");
  // Sin vale ni costo: la tanqueta ya salió con el suyo.
  await expect(page.locator("#despacho-serie")).toHaveCount(0);
  await expect(page.locator("#despacho-costo-unitario")).toHaveCount(0);
  await page
    .locator("#despacho-tanqueta-origen")
    .selectOption({ label: `${codigoTanqueta} (quedan 280 gal)` });
  await page.locator("#despacho-equipo-tanqueta").selectOption({ label: `${placa} — VOLQUETE` });
  await page.locator("#despacho-cantidad-tanqueta").fill("100");
  await page.locator("#despacho-medidor-tanqueta").fill("1500");
  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(page.getByText(new RegExp(`la carga desde ${codigoTanqueta}`))).toBeVisible();

  // ── 0115: carga EN PLANTA desde la misma tanqueta, con vale ────────────
  await page.getByRole("button", { name: "Registrar despacho" }).first().click();
  await page.locator("#despacho-origen").selectOption("tanqueta");
  await page.locator("#despacho-tanqueta-lugar").selectOption("planta");
  await page
    .locator("#despacho-tanqueta-origen")
    .selectOption({ label: `${codigoTanqueta} (quedan 180 gal)` });
  await page.locator("#despacho-equipo-tanqueta").selectOption({ label: `${placa} — VOLQUETE` });
  await page.locator("#despacho-cantidad-tanqueta").fill("50");
  // En planta lleva vale; el horómetro no se pide por defecto (0113).
  await expect(page.locator("#despacho-medidor-tanqueta")).toHaveCount(0);
  await page.locator("#despacho-serie").fill(`T${marca}`);
  await page.locator("#despacho-n-vale").fill("1");
  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(page.getByText(new RegExp(`el vale 1 de la serie T${marca}`))).toBeVisible();

  // ── La última lectura aparece sola al elegir la unidad (en ruta) ───────
  await page.getByRole("button", { name: "Registrar despacho" }).first().click();
  await page.locator("#despacho-origen").selectOption("tanqueta");
  await page.locator("#despacho-equipo-tanqueta").selectOption({ label: `${placa} — VOLQUETE` });
  await expect(page.getByText(/Última lectura: 1,500 h/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();

  // El tanque bajó solo por la previsión (8000 - 280), no por la carga en ruta.
  const ficha = await (await page.request.get(`/api/erp/combustible/${tanqueId}`)).json();
  expect(Number(ficha.nivel_teorico)).toBe(7720);

  // ── El panel: la tanqueta con 180 de 280 ───────────────────────────────
  await page.getByRole("button", { name: "Tanquetas" }).click();
  const tarjeta = page
    .locator("div", { has: page.getByText(codigoTanqueta, { exact: true }) })
    .last();
  // 280 - 100 en ruta - 50 en planta = 130 → libre 150.
  await expect(tarjeta.getByText(/libre 150 gal/)).toBeVisible();
});
