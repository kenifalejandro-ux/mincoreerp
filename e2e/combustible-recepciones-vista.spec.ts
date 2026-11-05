/** e2e/combustible-recepciones-vista.spec.ts
 *
 * La vista "Recepciones" de Cisternas: las descargas de combustible, también las anuladas, con lo que
 * decía el documento contra lo descargado. Los datos y los permisos los cubren los tests de servidor
 * y de lógica; acá se ve en un navegador que la vista se abra, que muestre la diferencia (en rojo si
 * pasa la tolerancia) y las anuladas con su motivo, y que los filtros respondan.
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

test("Recepciones: la diferencia contra el documento, las anuladas con su motivo y los filtros", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const sede = await primerGrifoActivo(page);
  const proveedor = await crear(page, "/api/erp/combustible/grifos", { nombre: `PROVV ${marca}` });
  const tanque = await crear(page, "/api/erp/combustible", {
    codigo: `RV-${marca}`,
    tanque_nombre: `Tanque vista ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 20000,
    nivel_actual: 1000,
    requiere_documento: true,
    modo_excedente_recepcion: "flexible",
    grifo_interno_id: sede,
  });
  const comprar = (documento: string, cantidad: number) =>
    crear(page, "/api/erp/combustible/compras-cisterna", {
      grifo_interno_id: sede,
      grifo_id: proveedor.id,
      tipo_combustible: "diesel_b5",
      tipo_documento: "guia_remision",
      numero_documento: documento,
      fecha_compra: hoy(),
      llegada_estimada: hoy(),
      cantidad_facturada: cantidad,
      costo_unitario: 24.5,
    });
  const recibir = (compraId: unknown, cantidad: number) =>
    crear(page, "/api/erp/combustible/recepciones", {
      combustible_id: tanque.id,
      grifo_id: proveedor.id,
      compra_id: Number(compraId),
      cantidad,
      costo_unitario: 24.5,
    });

  // Una que llegó 10 gal menos (pasa la tolerancia de 3), una exacta y una que se anula.
  const cMenos = await comprar(`TRR1-M${marca}`, 1000);
  const rMenos = await recibir(cMenos.id, 990);
  const cJusta = await comprar(`TRR1-J${marca}`, 500);
  const rJusta = await recibir(cJusta.id, 500);
  const cAnulada = await comprar(`TRR1-A${marca}`, 300);
  const rAnulada = await recibir(cAnulada.id, 300);
  const anula = await page.request.patch(`/api/erp/combustible/recepciones/${rAnulada.id}/anular`, {
    data: { motivo: `se registró duplicada ${marca}` },
  });
  expect(anula.status(), await anula.text()).toBe(200);

  // Una que llegó entera de sobrante: el tanque estaba lleno y los 300 se quedaron en la cisterna.
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
  const rSobrante = await crear(page, "/api/erp/combustible/recepciones", {
    combustible_id: lleno.id,
    grifo_id: proveedor.id,
    cantidad: 300,
    costo_unitario: 24.5,
    reparto_excedente: [{ destino: "cisterna", cantidad: 300 }],
  });

  await page.reload();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Cisternas", exact: true }).click();
  await page
    .getByRole("group", { name: "Vista de cisternas" })
    .getByRole("button", { name: /^Recepciones/ })
    .click();

  const tarjeta = (id: unknown) => page.getByRole("article", { name: `Recepción ${id}` });

  // ── La diferencia contra el documento ───────────────────────────────────
  await expect(tarjeta(rMenos.id)).toContainText("−10 gal");
  await expect(tarjeta(rMenos.id)).toContainText(`PROVV ${marca}`);
  await expect(tarjeta(rJusta.id)).toContainText("Sin diferencia");

  // ── Las anuladas se ven, con su motivo ─────────────────────────────────
  await expect(tarjeta(rAnulada.id)).toContainText("Anulada");
  await expect(tarjeta(rAnulada.id)).toContainText(`se registró duplicada ${marca}`);

  // ── Anular desde el historial: pide el motivo y queda anulada ───────────
  await tarjeta(rJusta.id).getByRole("button", { name: "Anular", exact: true }).click();
  const confirmar = page.getByRole("button", { name: "Anular recepción" });
  await expect(confirmar).toBeDisabled();
  await page.locator("#recepcion-anular-motivo").fill(`error de tipeo ${marca}`);
  await confirmar.click();
  await expect(tarjeta(rJusta.id)).toContainText("Anulada");
  await expect(tarjeta(rJusta.id)).toContainText(`error de tipeo ${marca}`);
  await expect(tarjeta(rJusta.id).getByRole("button", { name: "Anular", exact: true })).toHaveCount(
    0
  );

  // ── La cantidad es lo que LLEGÓ (tanque + sobrante), con su desglose ────
  await expect(tarjeta(rSobrante.id)).toContainText(/300 gal/);
  await expect(tarjeta(rSobrante.id)).toContainText(/0 al tanque · 300 de sobrante/);

  // ── Los filtros ────────────────────────────────────────────────────────
  await page.locator("#recepciones-estado").selectOption("anulada");
  await expect(tarjeta(rAnulada.id)).toBeVisible();
  await expect(tarjeta(rMenos.id)).toHaveCount(0);
  await page.locator("#recepciones-estado").selectOption("todas");
  await expect(tarjeta(rMenos.id)).toBeVisible();

  // ── En un celular cabe ─────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 800 });
  const cabe = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1
  );
  expect(cabe, "la página se desborda en 390 px").toBe(true);
});
