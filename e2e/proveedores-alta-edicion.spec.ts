/** e2e/proveedores-alta-edicion.spec.ts
 *
 * Ecosistema «Gestión de proveedores», PR2: registrar y editar un proveedor desde el directorio.
 * Con el admin del tenant sembrado:
 *
 * 1. «Registrar proveedor» valida en la pantalla (nombre, RUC de 11 dígitos, elegir qué abastece) y,
 *    con datos buenos, el proveedor aparece en el directorio con su uso Interno / Externo.
 * 2. Registrar el mismo nombre otra vez muestra el aviso del servidor y no duplica.
 * 3. «Editar» en la ficha cambia el nombre y lo desactiva; el directorio lo muestra «Desactivado».
 * 4. Una persona con perfil Lectura ve el directorio pero no los botones de registrar ni editar.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

async function entrarAlEcosistema(page: Page) {
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible();
}

test("registrar y editar un proveedor desde el directorio", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const nombre = `GRIFO ALTA ${marca}`;
  const editado = `GRIFO EDITADO ${marca}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  await entrarAlEcosistema(page);

  // 1. Validación en la pantalla.
  await page.getByRole("button", { name: "Registrar proveedor" }).click();
  const dialogo = page.getByRole("dialog", { name: "Registrar proveedor" });
  await expect(dialogo).toBeVisible();
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("Escribe el nombre");
  await dialogo.getByLabel("Razón social").fill(nombre);
  await dialogo.getByLabel(/^RUC/).fill("123");
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("11 dígitos");
  await dialogo.getByLabel(/^RUC/).fill("");
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("qué abastece");

  // Con datos buenos: queda registrado, interno de combustible.
  await dialogo.getByLabel("Combustible · Interno").check();
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(dialogo).toHaveCount(0);
  await page.getByPlaceholder("Buscar por razón social, RUC, código o ciudad...").fill(marca);
  const fila = page.getByRole("row", { name: new RegExp(nombre) });
  await expect(fila).toBeVisible({ timeout: 20_000 });
  await expect(fila.getByText("Interno", { exact: true })).toBeVisible();
  await expect(fila.getByText("Externo", { exact: true })).toHaveCount(0);

  // 2. El mismo nombre otra vez: aviso del servidor, sin duplicar.
  await page.getByRole("button", { name: "Registrar proveedor" }).click();
  await dialogo.getByLabel("Razón social").fill(nombre);
  await dialogo.getByLabel("Combustible · Externo").check();
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("Ya existe un proveedor llamado");
  await dialogo.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("row", { name: new RegExp(nombre) })).toHaveCount(1);

  // 3. Editar desde la ficha: nuevo nombre y desactivado.
  await fila.getByRole("button", { name: new RegExp(nombre) }).click();
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  const edicion = page.getByRole("dialog", { name: "Editar proveedor" });
  await edicion.getByLabel("Razón social").fill(editado);
  await edicion.getByLabel("Activo (recibe pedidos)").uncheck();
  await edicion.getByRole("button", { name: "Guardar" }).click();
  await expect(edicion).toHaveCount(0);
  await expect(page.getByRole("heading", { name: new RegExp(editado), level: 1 })).toBeVisible();
  await expect(page.getByText("Desactivado")).toBeVisible();
  await page.getByRole("button", { name: "Volver al directorio" }).click();
  await page.getByPlaceholder("Buscar por razón social, RUC, código o ciudad...").fill(marca);
  const filaEditada = page.getByRole("row", { name: new RegExp(editado) });
  await expect(filaEditada).toBeVisible();
  await expect(filaEditada.getByText("Desactivado")).toBeVisible();

  // 4. Lectura mira, no escribe. La clave que le da el admin es temporal: la primera vez la cambia.
  const email = `lectura-prov-${marca.toLowerCase()}@mincoreerp.test`;
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

    await entrarAlEcosistema(lectura);
    await lectura.getByPlaceholder("Buscar por razón social, RUC, código o ciudad...").fill(marca);
    const filaLectura = lectura.getByRole("row", { name: new RegExp(editado) });
    await expect(filaLectura).toBeVisible({ timeout: 20_000 });
    await expect(lectura.getByRole("button", { name: "Registrar proveedor" })).toHaveCount(0);
    await filaLectura.getByRole("button", { name: new RegExp(editado) }).click();
    await expect(
      lectura.getByRole("heading", { name: new RegExp(editado), level: 1 })
    ).toBeVisible();
    await expect(lectura.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0);
  } finally {
    await contexto.close();
  }
});
