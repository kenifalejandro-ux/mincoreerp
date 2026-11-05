/** e2e/combustible-compra-cisterna.spec.ts
 *
 * "Registrar compra" en la pestaña Cisternas: la encargada anota la compra de una cisterna con lo
 * que importa (proveedor, documento, fechas, cantidad); la sede, el precio y la empresa de
 * transporte se rellenan solos con lo último de ese proveedor. Después la habilita a la cancha o la
 * anula. Sin señal, la compra queda guardada en el equipo y llega sola.
 *
 * Los datos y las reglas las cubren los tests de servidor y de lógica; acá se ve en un navegador
 * que el formulario se rellene solo, que la lista y los botones respondan, que funcione sin señal y
 * que en un celular no se desborde.
 *
 * El tenant e2e sobrevive entre corridas: todo se busca por el proveedor y el documento de ESTA
 * corrida, nunca por conteos.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

const enDias = (n: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(
    new Date(Date.now() + n * 86_400_000)
  );

const tarjetaDe = (page: Page, documento: string) =>
  page.getByRole("article", { name: `Compra ${documento}` });

async function irACompras(page: Page) {
  await page.reload();
  // Recargada, la página vuelve al Dashboard con el submenú cerrado.
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Cisternas", exact: true }).click();
  await page
    .getByRole("group", { name: "Vista de cisternas" })
    .getByRole("button", { name: /^Compras/ })
    .click();
}

async function preparar(page: Page, marca: string) {
  const crear = async (ruta: string, data: object) => {
    const r = await page.request.post(ruta, { data });
    expect(r.status(), `${ruta}: ${await r.text()}`).toBe(201);
    return (await r.json()) as Record<string, unknown>;
  };
  const sede = await primerGrifoActivo(page);
  const nombre = `PROVC ${marca}`;
  const proveedor = await crear("/api/erp/combustible/grifos", { nombre });
  // El precio de compra del proveedor, que el formulario trae solo.
  const precio = await page.request.post("/api/erp/combustible/precios/masivo", {
    data: {
      tipo_combustible: "diesel_b5",
      grifo_ids: [proveedor.id],
      precio_unitario: 24.8,
      vigente_desde: new Date(Date.now() - 3_600_000).toISOString(),
    },
  });
  expect(precio.status(), await precio.text()).toBe(201);
  // Una compra anterior de ese proveedor: de ella sale la empresa de transporte sugerida.
  await crear("/api/erp/combustible/compras-cisterna", {
    grifo_interno_id: sede,
    grifo_id: proveedor.id,
    tipo_combustible: "diesel_b5",
    tipo_documento: "guia_remision",
    numero_documento: `ANT-${marca}`,
    fecha_compra: enDias(-10),
    llegada_estimada: enDias(-8),
    cantidad_facturada: 5000,
    costo_unitario: 24.5,
    transportista: "CORPORACION KIME S.A.C.",
    transportista_ruc: "20602504655",
  });
  return { nombre, proveedorId: Number(proveedor.id), sede };
}

test("Compras: el formulario se rellena solo, se registra, se habilita y se anula", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { nombre } = await preparar(page, marca);
  const documento = `TRR1-${marca}`;

  await irACompras(page);
  await page.getByRole("button", { name: "Registrar compra", exact: true }).click();

  // ── Al elegir el proveedor se rellena lo que se sabe de él ──────────────
  await page.locator("#compra-proveedor").selectOption({ label: nombre });
  await expect(page.locator("#compra-transportista")).toHaveValue("CORPORACION KIME S.A.C.");
  await expect(page.locator("#compra-transportista-ruc")).toHaveValue("20602504655");
  await expect(page.locator("#compra-costo")).toHaveValue("24.8");
  // Lo que se escribe a mano no se pisa: cambiar el combustible solo recalcula el precio.
  await page.locator("#compra-transportista").fill("OTRA TRANSPORTES S.A.");
  await page.locator("#compra-combustible").selectOption("diesel_b5");
  await expect(page.locator("#compra-transportista")).toHaveValue("OTRA TRANSPORTES S.A.");

  // Sin el número del documento y la cantidad, no se puede registrar.
  const registrar = page.getByRole("button", { name: "Registrar compra", exact: true }).last();
  await expect(registrar).toBeDisabled();
  await page.locator("#compra-numero").fill(documento);
  await page.locator("#compra-cantidad").fill("11100");
  await page.locator("#compra-llegada").fill(enDias(4));
  await expect(registrar).toBeEnabled();
  await registrar.click();

  await expect(page.getByText(/Compra registrada: Guía de remisión/)).toBeVisible();
  const tarjeta = tarjetaDe(page, documento);
  await expect(tarjeta).toContainText(nombre);
  await expect(tarjeta).toContainText("Registrada");
  await expect(tarjeta).toContainText(/11[.,]?100 gal/);
  await expect(tarjeta).toContainText("OTRA TRANSPORTES S.A.");

  // ── Habilitarla a la cancha ─────────────────────────────────────────────
  await tarjeta.getByRole("button", { name: "Habilitar a la cancha" }).click();
  await expect(tarjeta).toContainText("Por llegar");
  await expect(tarjeta.getByRole("button", { name: "Habilitar a la cancha" })).toHaveCount(0);

  // ── Anularla: pide el motivo y sale de "Por recibir" ────────────────────
  await tarjeta.getByRole("button", { name: "Anular", exact: true }).click();
  const anular = page.getByRole("button", { name: "Anular compra" });
  await expect(anular).toBeDisabled();
  await page.locator("#compra-motivo").fill("factura duplicada");
  await anular.click();
  await expect(tarjetaDe(page, documento)).toHaveCount(0);
  await page.locator("#compras-filtro-estado").selectOption("anuladas");
  await expect(tarjetaDe(page, documento)).toContainText("Anulada");
  await expect(tarjetaDe(page, documento)).toContainText("factura duplicada");

  // ── En un celular cabe ──────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 800 });
  const cabe = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1
  );
  expect(cabe, "la página se desborda en 390 px").toBe(true);
});

test("Compras: sin señal la compra queda guardada en el equipo y llega sola", async ({ page }) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { nombre } = await preparar(page, marca);
  const documento = `OFF-${marca}`;
  const hay = async () => {
    const r = await page.request.get("/api/erp/combustible/compras-cisterna");
    const lista = (await r.json()) as { numero_documento: string }[];
    return lista.some((c) => c.numero_documento === documento);
  };
  try {
    await irACompras(page);
    await page.getByRole("button", { name: "Registrar compra", exact: true }).click();
    await page.locator("#compra-proveedor").selectOption({ label: nombre });
    await page.locator("#compra-numero").fill(documento);
    await page.locator("#compra-cantidad").fill("8000");

    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Registrar compra", exact: true }).last().click();
    await expect(page.getByText(/Sin conexión: la compra/)).toBeVisible();
    await expect(page.getByText(/guardada en este equipo/)).toBeVisible();

    // Vuelve la señal: la cola la envía sola.
    await page.context().setOffline(false);
    await expect.poll(hay, { timeout: 30_000 }).toBe(true);
  } finally {
    await page.context().setOffline(false);
  }
});
