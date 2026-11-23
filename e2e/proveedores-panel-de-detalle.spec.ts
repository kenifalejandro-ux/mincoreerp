/** e2e/proveedores-panel-de-detalle.spec.ts
 *
 * El panel de detalle del ecosistema «Gestión de proveedores»: una hoja a la derecha que se abre encima de la
 * pantalla en la que está la persona, sin llevarla al Directorio.
 *
 * 1. Directorio: al abrir un proveedor la lista queda detrás con su búsqueda; el panel está en la dirección;
 *    se cierra con ✕, con Escape y pulsando fuera, y la lista sigue como estaba.
 * 2. Gestión comercial: el proveedor se abre en el panel, en «Comercial»; la pantalla y su dirección no cambian.
 * 3. Compras y recepciones: una compra se abre en el panel con su documento y su recepción; desde ahí se pasa a
 *    la ficha del proveedor, en el mismo panel.
 * 4. Historial: el proveedor de un movimiento se abre en el panel y la pantalla no cambia.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

const BUSCADOR = "Buscar por razón social, RUC, código o ciudad...";
const dia = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ruta = (page: Page) => new URL(page.url()).pathname;

async function entrarAlEcosistema(page: Page) {
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 20_000 });
  return menu;
}

test("el panel de detalle abre proveedores y compras sin saltar al Directorio", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const nombre = `GRIFO PANEL ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // Un proveedor de tanque con un precio y una compra de cisterna.
  const alta = await page.request.post("/api/erp/proveedores", {
    data: {
      nombre,
      ruc: "",
      abastece_tanque: true,
      abastece_ruta: true,
      abastece_urea: false,
      abastece_urea_ruta: false,
    },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  const id = (await alta.json()).id as number;
  const precio = await page.request.post("/api/erp/combustible/precios/masivo", {
    data: { tipo_combustible: "diesel_b5", grifo_ids: [id], precio_unitario: 15.2 },
  });
  expect(precio.ok(), await precio.text()).toBeTruthy();
  const compra = await page.request.post("/api/erp/combustible/compras-cisterna", {
    data: {
      grifo_interno_id: await primerGrifoActivo(page),
      grifo_id: id,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_documento: "factura",
      numero_documento: `PNL-${marca}`,
      fecha_compra: dia(),
      llegada_estimada: dia(4),
      cantidad_facturada: 1000,
      costo_unitario: 15.5,
      transportista: "Transportes Andes SAC",
      transportista_ruc: "20123456780",
    },
  });
  expect(compra.ok(), await compra.text()).toBeTruthy();

  const menu = await entrarAlEcosistema(page);
  const panel = page.getByRole("complementary", { name: "Detalle del proveedor" });

  // 1. Directorio: la lista queda detrás, con su búsqueda.
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await page.getByPlaceholder(BUSCADOR).fill(marca);
  const fila = page.getByRole("row", { name: new RegExp(nombre) });
  await expect(fila).toBeVisible({ timeout: 20_000 });
  await fila.getByRole("button", { name: new RegExp(nombre) }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Resumen" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect.poll(() => ruta(page)).toBe(`/proveedores/directorio/${id}`);
  // La lista sigue ahí, con su búsqueda y su encabezado.
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible();
  await expect(page.getByPlaceholder(BUSCADOR)).toHaveValue(marca);

  // ✕ cierra; la lista queda como estaba y la dirección vuelve a la lista.
  await panel.getByRole("button", { name: "Cerrar el panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => ruta(page)).toBe("/proveedores/directorio");
  await expect(page.getByPlaceholder(BUSCADOR)).toHaveValue(marca);
  await expect(fila).toBeVisible();

  // Escape cierra.
  await fila.getByRole("button", { name: new RegExp(nombre) }).click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // Pulsar fuera (en la sombra, entre el menú y el panel) cierra.
  await page.setViewportSize({ width: 1280, height: 800 });
  await fila.getByRole("button", { name: new RegExp(nombre) }).click();
  await expect(panel).toBeVisible();
  await page.mouse.click(268, 400);
  await expect(panel).toHaveCount(0);
  await expect(page.getByPlaceholder(BUSCADOR)).toHaveValue(marca);

  // 2. Gestión comercial: el proveedor se abre en «Comercial» y la pantalla no cambia.
  await menu.getByRole("button", { name: "Gestión comercial" }).click();
  await expect(page.getByRole("heading", { name: "Precios negociados", level: 1 })).toBeVisible();
  await page.getByPlaceholder("Buscar por proveedor o producto").fill(marca);
  await page.getByRole("button", { name: `Abrir ${nombre}` }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Comercial" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(panel.getByRole("heading", { name: "Diésel B5", level: 2 })).toBeVisible();
  expect(ruta(page)).toBe("/proveedores/precios");
  await expect(page.getByRole("heading", { name: "Precios negociados", level: 1 })).toBeVisible();
  await panel.getByRole("button", { name: "Cerrar el panel" }).click();
  await expect(panel).toHaveCount(0);
  expect(ruta(page)).toBe("/proveedores/precios");
  await expect(page.getByPlaceholder("Buscar por proveedor o producto")).toHaveValue(marca);

  // 3. Compras y recepciones: la compra se abre en su panel; de ahí, a la ficha del proveedor.
  await menu.getByRole("button", { name: "Compras y recepciones" }).click();
  await page.getByPlaceholder("Buscar por compra, guía, producto o proveedor...").fill(marca);
  // El nombre del proveedor abre SU ficha (en la pestaña Compras); no el detalle de la compra.
  await page.getByRole("button", { name: `Abrir ${nombre}`, exact: true }).click();
  await expect(panel.getByRole("tab", { name: "Compras y recepciones" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await panel.getByRole("button", { name: "Cerrar el panel" }).click();
  await expect(panel).toHaveCount(0);

  // Pulsar la fila (aquí, la celda del total) abre el detalle de lo que se ingresó en la compra.
  const filaCompra = page.getByRole("row", { name: new RegExp(`PNL-${marca}`) });
  await filaCompra.locator("td").nth(4).click();
  const detalleCompra = page.getByRole("complementary", { name: "Detalle de la compra" });
  await expect(detalleCompra).toBeVisible();
  await expect(
    detalleCompra.getByRole("heading", { name: `Compra PNL-${marca}`, level: 1 })
  ).toBeVisible();
  // Las mismas etiquetas y valores del formulario «Registrar compra».
  const valorDe = (etiqueta: string) => detalleCompra.locator(`dt:text-is("${etiqueta}") + dd`);
  for (const [etiqueta, valor] of [
    ["Proveedor", nombre],
    ["Combustible", "Diésel B5"],
    ["Tipo de documento", "Factura"],
    ["Número del documento", `PNL-${marca}`],
    ["Cantidad facturada", "1,000"],
    ["Unidad", "Galones"],
    ["Costo por galón (S/)", "S/ 15.50"],
    ["Empresa de transporte", "Transportes Andes SAC"],
    ["RUC del transportista", "20123456780"],
  ] as const) {
    await expect(valorDe(etiqueta), etiqueta).toContainText(valor);
  }
  // La sede se dice como en el formulario: «Sede · tanque».
  await expect(valorDe("Sede de llegada")).toContainText(" · ");
  await expect(detalleCompra.getByText("S/ 15,500.00")).toBeVisible();
  await expect(detalleCompra.getByText(/Aún no llega/)).toBeVisible();
  expect(ruta(page)).toBe("/proveedores/compras");
  await detalleCompra.getByRole("button", { name: `Abrir ficha de ${nombre}` }).click();
  await expect(panel.getByRole("tab", { name: "Compras y recepciones" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(detalleCompra).toHaveCount(0);
  expect(ruta(page)).toBe("/proveedores/compras");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // 4. Historial: el proveedor del movimiento se abre en el panel y la pantalla no cambia.
  await menu.getByRole("button", { name: "Historial y auditoría" }).click();
  await expect(
    page.getByRole("heading", { name: "Historial y auditoría", level: 1 })
  ).toBeVisible();
  await page.getByRole("button", { name: nombre, exact: true }).first().click();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible();
  expect(ruta(page)).toBe("/proveedores/historial");
  await expect(
    page.getByRole("heading", { name: "Historial y auditoría", level: 1 })
  ).toBeVisible();
  // Y al cambiar de pantalla con el menú, el panel se cierra.
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await expect(panel).toHaveCount(0);
});
