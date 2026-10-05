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

  // Una sede propia de esta corrida: las tanquetas del tenant e2e sobreviven
  // entre corridas, y una vieja con espacio cambiaría el reparto propuesto.
  const sedes = (await (await page.request.get("/api/erp/sedes")).json()).sedes;
  const grifoSede = await page.request.post("/api/erp/administracion/grifos", {
    data: { sede_id: sedes[0].id, nombre: `Huamachuco ${marca}` },
  });
  expect(grifoSede.status(), "no se pudo crear el grifo de prueba").toBe(201);
  const grifoInternoId = (await grifoSede.json()).id as number;

  // Tanque LLENO (2000/2000): toda la entrega es excedente.
  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `EX-${marca}`,
      tanque_nombre: `Tanque excedente ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 2000,
      nivel_actual: 2000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status(), "no se pudo crear el tanque de prueba").toBe(201);
  const tanqueId = (await tanque.json()).id as number;
  const codigos: string[] = [];
  for (const sufijo of ["A", "B"]) {
    const t = await page.request.post("/api/erp/combustible/tanquetas", {
      data: { grifo_interno_id: grifoInternoId, codigo: `TQ-${marca}-${sufijo}` },
    });
    expect(t.status(), "no se pudo crear la tanqueta de prueba").toBe(201);
    codigos.push((await t.json()).codigo);
  }
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

  // ── La recepción que no cabe: tanque lleno, llegan 600 ─────────────────
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Registrar recepción" }).first().click();
  await page.locator("#recepcion-tanque").selectOption(String(tanqueId));
  await page.locator("#recepcion-grifo").selectOption({ label: `CISTERNA ${marca}` });
  await page.locator("#recepcion-cantidad").fill("600");
  await page.locator("#recepcion-costo").fill("17.5");

  const registrar = page.locator("form").getByRole("button", { name: "Registrar recepción" });
  await expect(registrar, "en un tanque flexible el botón no se bloquea").toBeEnabled();
  await registrar.click();

  await expect(page.getByText("La recepción no cabe en el tanque")).toBeVisible();
  const confirmar = page.getByRole("button", { name: "Registrar con este reparto" });

  // El reparto propuesto: cada tanqueta hasta su tope (280 + 280) y el resto
  // (40) en una línea a unidades sin unidad elegida, para decidir qué hacer.
  await expect(page.locator("#exc-cantidad-0")).toHaveValue("280");
  await expect(page.locator("#exc-cantidad-1")).toHaveValue("280");
  await expect(page.locator("#exc-cantidad-2")).toHaveValue("40");
  await expect(page.locator("#exc-destino-2")).toHaveValue("equipo");
  await expect(page.getByText(/Completa cada línea/)).toBeVisible();
  await expect(confirmar).toBeDisabled();

  // Una tanqueta no admite más que su espacio libre.
  await page.locator("#exc-cantidad-0").fill("300");
  await page.locator("#exc-cantidad-2").fill("20");
  await expect(page.getByText(/solo admite 280/)).toBeVisible();
  await expect(confirmar).toBeDisabled();
  await page.locator("#exc-cantidad-0").fill("280");
  await page.locator("#exc-cantidad-2").fill("40");

  // El resto se devuelve al proveedor.
  await page.locator("#exc-destino-2").selectOption("devolucion");
  await expect(page.getByText("El reparto cubre todo el excedente.")).toBeVisible();
  await expect(confirmar).toBeEnabled();
  await confirmar.click();

  await expect(page.getByText(/Recepción registrada/)).toBeVisible();

  // Al tanque no entró nada; los 600 se derivaron.
  const lista = await page.request.get(
    `/api/erp/combustible/recepciones?combustible_id=${tanqueId}`
  );
  const filas = (await lista.json()).data as { cantidad: string; cantidad_derivada: string }[];
  expect(filas).toHaveLength(1);
  expect(Number(filas[0].cantidad)).toBe(0);
  expect(Number(filas[0].cantidad_derivada)).toBe(600);

  // ── El panel de Tanquetas: las dos llenas ──────────────────────────────
  await page.getByRole("button", { name: "Tanquetas" }).click();
  for (const codigo of codigos) {
    const tarjeta = page.locator("div", { has: page.getByText(codigo, { exact: true }) }).last();
    await expect(tarjeta.getByText(/100% · libre 0 gal/)).toBeVisible();
  }
});
