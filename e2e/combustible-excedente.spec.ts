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
import { primerGrifoActivo } from "./fixtures/grifos";

test("nuevo tanque: sin tolerancia, capacidad 10000 por defecto, y el excedente se reparte", async ({
  page,
}) => {
  // Recorre cuatro pantallas (nuevo tanque, recepción, despacho, tanquetas):
  // los 30 s por defecto no alcanzan cuando corre en paralelo con otra spec.
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // El grifo que ya existe. NO se crea uno: con dos grifos activos, el resto
  // de las specs (que crean equipos sin grifo) empieza a recibir 400 -- el
  // tenant e2e es compartido y las specs corren en paralelo.
  const grifoInternoId = await primerGrifoActivo(page);

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
  const placa = `EX-${marca}`;
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: placa,
      tipo: "EXCAVADORA",
      tipo_medidor: "horometro",
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(equipo.status(), "no se pudo crear el equipo de prueba").toBe(201);
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

  // El reparto propuesto llena tanquetas sin pasar ninguna de su tope. Otras
  // specs en paralelo pueden tener tanquetas libres en este grifo, así que
  // no se fija CUÁLES propone: solo que ninguna línea pase de 280.
  await expect(page.locator("#exc-destino-0")).toHaveValue("cubeta");
  expect(Number(await page.locator("#exc-cantidad-0").inputValue())).toBeLessThanOrEqual(280);

  // Se arma el reparto con las tanquetas de ESTA corrida: 280 + 280 + 40.
  const quitar = page.getByRole("button", { name: "Quitar línea" });
  while ((await quitar.count()) > 0) await quitar.last().click();
  const elegirTanqueta = async (i: number, codigo: string) => {
    const valor = await page
      .locator(`#exc-tanqueta-${i} option`, { hasText: codigo })
      .getAttribute("value");
    await page.locator(`#exc-tanqueta-${i}`).selectOption(valor!);
  };
  await page.locator("#exc-destino-0").selectOption("cubeta");
  await elegirTanqueta(0, codigos[0]);
  await page.locator("#exc-cantidad-0").fill("280");

  await page.getByRole("button", { name: "+ Dividir en otro destino" }).click();
  await page.locator("#exc-destino-1").selectOption("cubeta");
  await elegirTanqueta(1, codigos[1]);
  await page.locator("#exc-cantidad-1").fill("280");

  // El resto va directo de la cisterna a la excavadora.
  await page.getByRole("button", { name: "+ Dividir en otro destino" }).click();
  await expect(page.locator("#exc-destino-2")).toHaveValue("equipo");
  await page.locator("#exc-cantidad-2").fill("40");
  await expect(page.getByText(/Completa cada línea/)).toBeVisible();
  await expect(confirmar).toBeDisabled();
  await page.locator("#exc-equipo-2").selectOption({ label: placa });

  // Una tanqueta no admite más que su espacio libre, aunque el total cuadre.
  await page.locator("#exc-cantidad-0").fill("300");
  await page.locator("#exc-cantidad-2").fill("20");
  await expect(page.getByText(/solo admite 280/)).toBeVisible();
  await expect(confirmar).toBeDisabled();
  await page.locator("#exc-cantidad-0").fill("280");
  await page.locator("#exc-cantidad-2").fill("40");
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

  // ── Los 40 a la unidad quedan pendientes de vale ───────────────────────
  // Aviso en Tanques -> despacho con origen "Excedente de cisterna", con la
  // unidad, la cantidad y el costo de la factura precargados.
  await page.getByRole("button", { name: "Tanques", exact: true }).click();
  // El tenant e2e sobrevive entre corridas: puede haber otros pendientes, así
  // que se elige el de esta corrida por su unidad.
  await expect(page.getByText(/directo a (una unidad|unidades) sin vale/)).toBeVisible();
  await page
    .locator("div", { hasText: /sin vale/ })
    .getByRole("button", { name: "Registrar despacho" })
    .last()
    .click();
  await expect(page.locator("#despacho-origen")).toHaveValue("excedente_recepcion");
  const opcion = await page
    .locator("#despacho-excedente option", { hasText: placa })
    .getAttribute("value");
  await page.locator("#despacho-excedente").selectOption(opcion!);
  await expect(page.locator("#despacho-excedente")).not.toHaveValue("");
  await expect(
    page.locator("div.bg-slate-50", { hasText: placa }).filter({ hasText: "40 gal" })
  ).toBeVisible();
  await expect(page.locator("#despacho-costo-unitario")).toHaveValue("17.5");
  // Por defecto el despacho interno no pide horómetro (0113): se toma en ruta.
  await expect(page.locator("#despacho-excedente-medidor")).toHaveCount(0);
  await page.locator("#despacho-serie").fill(`S${marca}`);
  await page.locator("#despacho-n-vale").fill("1");
  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(page.getByText(/Despacho registrado/)).toBeVisible();
  const pendientes = await (
    await page.request.get("/api/erp/combustible/despachos/excedentes-pendientes")
  ).json();
  expect(pendientes.some((x: { equipo: string }) => x.equipo === placa)).toBe(false);

  // El vale NO bajó el tanque: sigue lleno (2000).
  const ficha = await (await page.request.get(`/api/erp/combustible/${tanqueId}`)).json();
  expect(Number(ficha.nivel_teorico)).toBe(2000);

  // ── El panel de Tanquetas: las dos llenas ──────────────────────────────
  await page.getByRole("button", { name: "Tanquetas" }).click();
  for (const codigo of codigos) {
    const tarjeta = page.locator("div", { has: page.getByText(codigo, { exact: true }) }).last();
    await expect(tarjeta.getByText(/100% · libre 0 gal/)).toBeVisible();
  }
});
