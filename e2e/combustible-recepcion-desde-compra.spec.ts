/** e2e/combustible-recepcion-desde-compra.spec.ts
 *
 * La recepción vive en Cisternas: la compra que viene en camino es una tarjeta llena y, donde una
 * cisterna con saldo tiene "Repartir", esta tiene "Registrar recepción". El formulario nace con lo
 * que la compra ya dice, avisa de la fecha antes de registrar, y los botones de recepción salieron de
 * Tanques. También el formulario "Repartir" con el vale en una sola fila.
 *
 * El tenant e2e sobrevive entre corridas: todo se busca por el documento y el proveedor de ESTA corrida.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

const hoy = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());

async function crear(page: Page, ruta: string, data: object) {
  const r = await page.request.post(ruta, { data });
  expect(r.status(), `${ruta}: ${await r.text()}`).toBe(201);
  return (await r.json()) as Record<string, unknown>;
}

async function irACisternas(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Cisternas", exact: true }).click();
}

async function preparar(page: Page, marca: string) {
  const sede = await primerGrifoActivo(page);
  const tanque = await crear(page, "/api/erp/combustible", {
    codigo: `RC-${marca}`,
    tanque_nombre: `Tanque RC ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 20000,
    nivel_actual: 1000,
    requiere_documento: true,
    modo_excedente_recepcion: "flexible",
    grifo_interno_id: sede,
  });
  const nombre = `PROVR ${marca}`;
  const proveedor = await crear(page, "/api/erp/combustible/grifos", { nombre });
  return { sede, tanque, nombre, proveedor };
}

test("Recepción desde la tarjeta de la compra: el formulario nace relleno y la compra queda recibida", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { sede, tanque, nombre, proveedor } = await preparar(page, marca);
  const documento = `TRR1-${marca}`;
  const compra = await crear(page, "/api/erp/combustible/compras-cisterna", {
    grifo_interno_id: sede,
    grifo_id: proveedor.id,
    tipo_combustible: "diesel_b5",
    tipo_documento: "guia_remision",
    numero_documento: documento,
    fecha_compra: hoy(),
    llegada_estimada: hoy(),
    cantidad_facturada: 5000,
    costo_unitario: 24.5,
  });

  await irACisternas(page);
  const tarjeta = page.getByRole("article", { name: `Cisterna por llegar ${documento}` });
  await expect(tarjeta).toBeVisible();
  await expect(tarjeta).toContainText(nombre);
  await expect(tarjeta).toContainText(/5[.,]?000/);
  await tarjeta.getByRole("button", { name: "Registrar recepción" }).click();

  // ── El formulario nace con lo que la compra dice ───────────────────────
  await expect(page.getByText(/Recibes la compra/)).toBeVisible();
  await expect(page.locator("#recepcion-grifo")).toBeDisabled();
  await expect(page.locator("#recepcion-tipo-doc")).toBeDisabled();
  await expect(page.locator("#recepcion-num-doc")).toHaveValue(documento);
  await expect(page.locator("#recepcion-num-doc")).toBeDisabled();
  await expect(page.locator("#recepcion-cantidad")).toHaveValue("5000");
  await expect(page.locator("#recepcion-costo")).toHaveValue("24.5");

  // Solo se ofrecen los tanques de esa sede y de ese combustible; el nuestro está.
  await page.locator("#recepcion-tanque").selectOption(String(tanque.id));
  // Llegaron 10 gal menos que el documento (la evaporación).
  await page.locator("#recepcion-cantidad").fill("4990");
  await page.locator("form").getByRole("button", { name: "Registrar recepción" }).click();
  await expect(page.getByText(/Recepción registrada/)).toBeVisible();

  // La tarjeta de la compra desaparece de "por llegar" y la compra queda recibida.
  await expect(tarjeta).toHaveCount(0);
  const lista = (await (
    await page.request.get("/api/erp/combustible/compras-cisterna")
  ).json()) as { id: string; estado: string; recepcion_id: string | null }[];
  const la = lista.find((c) => String(c.id) === String(compra.id))!;
  expect(la.estado).toBe("recibida");
  expect(la.recepcion_id).not.toBeNull();
});

test("Recepción: el aviso de la fecha sale antes de registrar y bloquea el botón", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { tanque, nombre } = await preparar(page, marca);

  await irACisternas(page);
  await page.getByRole("button", { name: "Recepción sin compra registrada" }).click();
  await page.locator("#recepcion-tanque").selectOption(String(tanque.id));
  await page.locator("#recepcion-grifo").selectOption({ label: nombre });
  await page.locator("#recepcion-cantidad").fill("100");
  await page.locator("#recepcion-costo").fill("24");
  await page.locator("#recepcion-num-doc").fill(`F-${marca}`);
  const registrar = page.locator("form").getByRole("button", { name: "Registrar recepción" });
  await expect(registrar).toBeEnabled();

  // Dos días antes de que el tanque existiera en el sistema.
  const antes = new Date(Date.now() - 2 * 86_400_000);
  const dos = (n: number) => String(n).padStart(2, "0");
  await page
    .locator("#recepcion-fecha")
    .fill(
      `${antes.getFullYear()}-${dos(antes.getMonth() + 1)}-${dos(antes.getDate())}T${dos(antes.getHours())}:${dos(antes.getMinutes())}`
    );
  await expect(page.getByText(/La primera varilla de este tanque es del/)).toBeVisible();
  await expect(registrar).toBeDisabled();
});

test("Los botones de recepción viven en Cisternas y salieron de Tanques", async ({ page }) => {
  test.setTimeout(60_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Tanques", exact: true }).click();
  await expect(page.getByRole("button", { name: "Registrar despacho" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Registrar recepción" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Validar recepciones" })).toHaveCount(0);

  await page.getByRole("button", { name: "Cisternas", exact: true }).click();
  await expect(page.getByRole("button", { name: "Registrar compra", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recepción sin compra registrada" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Validar recepciones" })).toBeVisible();
});

test("Repartir: la serie, el número de vale y el medidor quedan en una sola fila", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { sede, tanque, proveedor } = await preparar(page, marca);
  await crear(page, "/api/erp/equipos", {
    placa_codigo: `RV-${marca}`,
    tipo: "VOLQUETE",
    tipo_medidor: "horometro",
    grifo_interno_id: sede,
  });
  // Tanque lleno: todo lo que llega queda en la cisterna.
  const lleno = await crear(page, "/api/erp/combustible", {
    codigo: `RL-${marca}`,
    tanque_nombre: `Tanque lleno ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 2000,
    nivel_actual: 2000,
    requiere_documento: false,
    modo_excedente_recepcion: "flexible",
    grifo_interno_id: sede,
  });
  void tanque;
  const rec = await crear(page, "/api/erp/combustible/recepciones", {
    combustible_id: lleno.id,
    grifo_id: proveedor.id,
    cantidad: 300,
    costo_unitario: 17.5,
    recibido_en: new Date().toISOString(),
    reparto_excedente: [{ destino: "cisterna", cantidad: 300 }],
  });

  await irACisternas(page);
  const tarjeta = page.locator("article").filter({ hasText: `Recepción #${rec.id} ` });
  await tarjeta.getByRole("button", { name: "Repartir" }).click();
  await page.locator("#cis-unidad").selectOption({ label: `RV-${marca}` });

  const caja = async (id: string) => (await page.locator(id).boundingBox())!;
  const serie = await caja("#cis-serie");
  const vale = await caja("#cis-vale");
  const medidor = await caja("#cis-medidor");
  // Los tres campos arrancan a la misma altura (antes la serie quedaba más abajo).
  expect(Math.abs(serie.y - vale.y)).toBeLessThan(2);
  expect(Math.abs(serie.y - medidor.y)).toBeLessThan(2);
  // Y se ven uno al lado del otro, no apilados.
  expect(vale.x).toBeGreaterThan(serie.x + serie.width - 2);
  expect(medidor.x).toBeGreaterThan(vale.x + vale.width - 2);
});
