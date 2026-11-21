/** e2e/proveedores-gestion-comercial.spec.ts
 *
 * Ecosistema «Gestión de proveedores», PR4: Gestión comercial (precios de proveedores, solo lectura).
 * Con el admin del tenant sembrado (precios cargados por la API de Combustible, como hoy):
 *
 * 1. «Gestión comercial» muestra el precio vigente de un proveedor, cuánto subió frente al anterior y
 *    desde cuándo rige; un proveedor de ruta sin precio sale «Sin precio».
 * 2. Al abrir el proveedor desde la tabla se llega a su ficha, en la pestaña «Comercial», con su historia.
 * 3. Una persona con perfil Lectura no ve «Gestión comercial» en el menú.
 */
import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

const dias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

test("gestión comercial: precio vigente, variación, ficha y Lectura sin acceso", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const conPrecio = `GRIFO PRECIO ${marca}`;
  const sinPrecio = `GRIFO SIN PRECIO ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // «Sin precio» se deriva de los tipos de combustible que la empresa maneja en sus tanques (igual que
  // la pantalla Precios de Combustible): en una base limpia no hay ninguno, así que el spec siembra uno.
  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `GC-${marca}`,
      tanque_nombre: `Tanque comercial ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 1000,
      nivel_actual: 500,
      requiere_documento: false,
      grifo_interno_id: await primerGrifoActivo(page),
    },
  });
  expect(tanque.status(), await tanque.text()).toBe(201);

  // Dos proveedores de ruta; solo el primero tiene precios (10.00 y luego 10.80: sube 8 %).
  const crear = async (nombre: string) => {
    const r = await page.request.post("/api/erp/proveedores", {
      data: {
        nombre,
        ruc: "",
        abastece_tanque: false,
        abastece_ruta: true,
        abastece_urea: false,
        abastece_urea_ruta: false,
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).id as number;
  };
  const idConPrecio = await crear(conPrecio);
  await crear(sinPrecio);
  for (const [precio, desde] of [
    [10.0, dias(-20)],
    [10.8, dias(-2)],
  ] as const) {
    const r = await page.request.post("/api/erp/combustible/precios/masivo", {
      data: {
        tipo_combustible: "diesel_b5",
        grifo_ids: [idConPrecio],
        precio_unitario: precio,
        vigente_desde: desde,
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }

  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByRole("button", { name: "Gestión comercial" }).click();
  await expect(
    page.getByRole("heading", { name: "Precios de proveedores", level: 1 })
  ).toBeVisible();

  // 1. Precio vigente, variación y antigüedad; el otro proveedor, sin precio.
  await page.getByPlaceholder("Buscar por proveedor o producto").fill(marca);
  const fila = page.getByRole("row", { name: new RegExp(conPrecio) });
  await expect(fila).toBeVisible({ timeout: 20_000 });
  await expect(fila).toContainText("S/ 10.80");
  await expect(fila).toContainText("por galón");
  await expect(fila).toContainText("▲ 8.0 %");
  await expect(fila).toContainText("hace 2 días");
  await expect(
    page.getByRole("row", { name: new RegExp(sinPrecio) }).getByText("Sin precio", { exact: true })
  ).toBeVisible();
  // Filtro «Sin precio»: queda solo el que no tiene.
  await page.getByLabel("Estado del precio").selectOption("sin");
  await expect(page.getByRole("row", { name: new RegExp(conPrecio) })).toHaveCount(0);
  await page.getByLabel("Estado del precio").selectOption("todos");

  // 2. De la tabla a la ficha, ya en «Comercial», con su historia.
  await page.getByRole("button", { name: `Abrir ${conPrecio}` }).click();
  await expect(page.getByRole("heading", { name: new RegExp(conPrecio), level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Comercial" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("heading", { name: "Diésel B5", level: 2 })).toBeVisible();
  await page.getByText(/^Historial \(2\)/).click();
  await expect(page.getByText("S/ 10.00")).toBeVisible();
  await page.getByRole("tab", { name: "Resumen" }).click();
  await expect(page.getByRole("heading", { name: "Qué abastece" })).toBeVisible();

  // 3. Lectura no ve «Gestión comercial» (ni la pestaña «Comercial»).
  const email = `lectura-com-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Lectura ${marca}`, email, password: temporal, rol: "lectura" },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  const contexto = await browser.newContext();
  const lectura = await contexto.newPage();
  try {
    await lectura.goto("/");
    await lectura.getByLabel("Correo").fill(email);
    await lectura.getByLabel("Contraseña").fill(temporal);
    await lectura.getByRole("button", { name: "Ingresar" }).click();
    await lectura.locator("#passwordActual").fill(temporal);
    await lectura.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await lectura.locator("#confirmacion").fill(`${temporal}Nueva`);
    await lectura.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(lectura.getByRole("button", { name: "Dashboard" })).toBeVisible({
      timeout: 20_000,
    });
    await lectura.getByRole("button", { name: /Gestión de proveedores/ }).click();
    await lectura.getByRole("button", { name: "Centro de administración" }).click();
    const menuLectura = lectura.getByRole("complementary", {
      name: "Menú de Gestión de proveedores",
    });
    await expect(menuLectura).toBeVisible({ timeout: 15_000 });
    await expect(
      menuLectura.getByRole("button", { name: "Directorio de proveedores" })
    ).toBeVisible();
    await expect(menuLectura.getByRole("button", { name: "Gestión comercial" })).toHaveCount(0);
    await menuLectura.getByRole("button", { name: "Directorio de proveedores" }).click();
    await lectura.getByPlaceholder("Buscar por nombre, código o RUC").fill(marca);
    await lectura
      .getByRole("row", { name: new RegExp(conPrecio) })
      .getByRole("button", { name: new RegExp(conPrecio) })
      .click();
    await expect(
      lectura.getByRole("heading", { name: new RegExp(conPrecio), level: 1 })
    ).toBeVisible();
    await expect(lectura.getByRole("tab", { name: "Comercial" })).toHaveCount(0);
  } finally {
    await contexto.close();
  }
});
