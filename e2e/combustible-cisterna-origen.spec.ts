/** e2e/combustible-cisterna-origen.spec.ts
 *
 * El panel de la tarjeta de cisterna suma, sin quitar nada: de dónde viene (documento y transporte),
 * la diferencia contra el documento, y en cada movimiento la hora, quién lo registró y su vale. Y el
 * formulario "Registrar compra" con sus campos alineados.
 *
 * El tenant e2e sobrevive entre corridas: todo se busca por la recepción de ESTA corrida.
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

test("Tarjeta de cisterna: de dónde viene, la diferencia y el vale y la persona de cada movimiento", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const sede = await primerGrifoActivo(page);
  const proveedor = await crear(page, "/api/erp/combustible/grifos", { nombre: `PROVO ${marca}` });
  const equipo = await crear(page, "/api/erp/equipos", {
    placa_codigo: `OR-${marca}`,
    tipo: "VOLQUETE",
    tipo_medidor: "horometro",
    grifo_interno_id: sede,
  });
  const tanque = await crear(page, "/api/erp/combustible", {
    codigo: `OT-${marca}`,
    tanque_nombre: `Tanque origen ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 1100,
    nivel_actual: 1000,
    requiere_documento: true,
    modo_excedente_recepcion: "flexible",
    grifo_interno_id: sede,
  });
  const documento = `TRR1-${marca}`;
  const compra = await crear(page, "/api/erp/combustible/compras-cisterna", {
    grifo_interno_id: sede,
    grifo_id: proveedor.id,
    tipo_combustible: "diesel_b5",
    tipo_documento: "guia_remision",
    numero_documento: documento,
    fecha_compra: hoy(),
    llegada_estimada: hoy(),
    cantidad_facturada: 1000,
    costo_unitario: 24.5,
    transportista: "CORPORACION KIME S.A.C.",
    transportista_ruc: "20602504655",
  });
  // Se entregan 995 (100 al tanque y 895 de sobrante): 5 gal menos que el documento.
  const rec = await crear(page, "/api/erp/combustible/recepciones", {
    combustible_id: tanque.id,
    grifo_id: proveedor.id,
    compra_id: Number(compra.id),
    cantidad: 995,
    costo_unitario: 24.5,
    reparto_excedente: [{ destino: "cisterna", cantidad: 895 }],
  });
  const lista = (await (
    await page.request.get("/api/erp/combustible/despachos/cisternas?estado=saldo")
  ).json()) as { id: string; recepcion_id: string }[];
  const linea = lista.find((c) => Number(c.recepcion_id) === Number(rec.id))!;
  expect(linea, "la cisterna no quedó con saldo").toBeDefined();
  const serie = `O${marca}`;
  await crear(page, "/api/erp/combustible/despachos", {
    origen: "excedente_recepcion",
    excedente_linea_id: Number(linea.id),
    tipo_combustible: "diesel_b5",
    tipo_destino: "equipo",
    equipo_id: equipo.id,
    serie_talonario: serie,
    n_vale: 5,
    cantidad: 100,
    lectura_horometro: 100,
    costo_unitario: 1,
  });

  await irACisternas(page);
  const tarjeta = page.locator("article").filter({ hasText: `Recepción #${rec.id} ` });
  await expect(tarjeta).toBeVisible();

  // ── Lo que ya tenía se queda ───────────────────────────────────────────
  const desglose = tarjeta.getByRole("region", { name: "Adónde fue lo que llegó" });
  await expect(desglose).toContainText("Quedó en la cisterna");
  const kardex = tarjeta.getByRole("region", { name: "Movimientos de esta cisterna" });
  await expect(kardex.locator("tbody tr")).toHaveCount(2);
  await expect(kardex.locator("tbody tr").nth(0)).toContainText("Quedó al recibir");
  await expect(kardex.locator("tbody tr").nth(1)).toContainText(`A la unidad OR-${marca}`);

  // ── De dónde viene ─────────────────────────────────────────────────────
  const origen = tarjeta.getByRole("region", { name: "Origen de la cisterna" });
  await expect(origen).toContainText("Guía de remisión");
  await expect(origen).toContainText(documento);
  await expect(origen).toContainText("CORPORACION KIME S.A.C. · RUC 20602504655");

  // ── La diferencia contra el documento (−5 pasa la tolerancia de 3) ─────
  await expect(desglose).toContainText(/Documento 1[.,]?000 gal/);
  await expect(desglose).toContainText(/−5 gal/);
  await expect(desglose).toContainText("pasa la tolerancia");

  // ── Cada movimiento: quién lo registró y su vale ───────────────────────
  await expect(kardex.locator("tbody tr").nth(1)).toContainText(`vale ${serie}-5`);
  await expect(kardex.locator("tbody tr").nth(0)).toContainText(/\d{1,2}:\d{2}/);
});

test("Registrar compra: las fechas, la cantidad y la unidad quedan alineadas", async ({ page }) => {
  test.setTimeout(60_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await irACisternas(page);
  await page.getByRole("button", { name: "Registrar compra", exact: true }).click();
  // Escritorio: las etiquetas no se parten y los campos quedan alineados por abajo (la fila usa
  // `items-end`: un selector y un campo de fecha no miden lo mismo, pero su base coincide).
  await page.setViewportSize({ width: 1280, height: 900 });
  const base = async (id: string) => {
    const caja = (await page.locator(id).boundingBox())!;
    return caja.y + caja.height;
  };
  const emision = await base("#compra-emision");
  expect(Math.abs(emision - (await base("#compra-llegada")))).toBeLessThan(2);
  expect(Math.abs(emision - (await base("#compra-cantidad")))).toBeLessThan(2);
  expect(Math.abs(emision - (await base("#compra-unidad")))).toBeLessThan(2);
  await expect(page.getByText("Llegada a planta", { exact: true })).toBeVisible();
});
