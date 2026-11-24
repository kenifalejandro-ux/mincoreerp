/** e2e/proveedores-ficha.spec.ts
 *
 * Ecosistema «Gestión de proveedores», PR3a: la ficha del proveedor. Con el admin del tenant sembrado:
 *
 * 1. «Resumen» muestra «Datos y condiciones de pago» (todo «Sin definir» al inicio); «Editar datos» avisa
 *    lo que falta (el crédito pide su plazo), guarda y la ficha lo muestra.
 * 2. «Contactos»: el primero que se agrega es el principal; al agregar otro como principal, el primero
 *    deja de serlo; quitar pide confirmación y lo oculta.
 * 3. Una persona con perfil Lectura ve la ficha y los contactos pero no tiene ningún botón para cambiarlos.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI, pulsarIngresar } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

async function abrirFicha(page: Page, nombre: string, marca: string) {
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await page.getByPlaceholder("Buscar por razón social, RUC, código o ciudad...").fill(marca);
  await page
    .getByRole("row", { name: new RegExp(nombre) })
    .getByRole("button", { name: new RegExp(nombre) })
    .click();
  await expect(page.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible();
}

test("ficha del proveedor: datos y condiciones de pago, contactos y Lectura sin botones", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const nombre = `GRIFO FICHA ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const alta = await page.request.post("/api/erp/proveedores", {
    data: {
      nombre,
      ruc: "",
      abastece_tanque: false,
      abastece_ruta: true,
      abastece_urea: false,
      abastece_urea_ruta: false,
    },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  await abrirFicha(page, nombre, marca);

  // 0. Cabecera como la maqueta: lo que se sabe del proveedor y las pestañas, con Contratos y Documentos «Pronto».
  await expect(page.getByText("Sin ciudad")).toBeVisible();
  await expect(page.getByText("Abastece a: Externo").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Más acciones" })).toBeVisible();
  for (const pestana of [
    "Resumen",
    "Datos generales",
    "Contactos",
    "Comercial",
    "Contratos",
    "Documentos",
    "Compras de combustible",
    "Historial",
  ]) {
    await expect(page.getByRole("tab", { name: pestana })).toBeVisible();
  }
  await page.getByRole("tab", { name: "Contratos" }).click();
  await expect(page.getByText("Sin contratos registrados.")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Detalle del proveedor" }).getByText("Pronto", { exact: true })
  ).toBeVisible();
  await page.getByRole("tab", { name: "Documentos" }).click();
  await expect(page.getByText("Sin documentos cargados.")).toBeVisible();

  // 1. Datos generales: la identificación y los datos y condiciones de pago.
  await page.getByRole("tab", { name: "Datos generales" }).click();
  await expect(page.getByRole("heading", { name: "Datos y condiciones de pago" })).toBeVisible();
  await expect(page.getByText("Sin definir")).toHaveCount(6);
  await page.getByRole("button", { name: "Editar datos" }).click();
  const datos = page.getByRole("dialog", { name: "Datos y condiciones de pago" });
  await datos.getByLabel("Ciudad").fill("Arequipa");
  await datos.getByLabel("Dirección").fill("Av. Los Pinos 123, Huancayo");
  await datos.getByLabel("Teléfono").fill("064-123456");
  await datos.getByLabel("Correo").fill("ventas@grifo.pe");
  await datos.getByLabel("Forma de pago").selectOption("credito");
  await datos.getByRole("button", { name: "Guardar" }).click();
  await expect(datos.getByRole("alert")).toContainText("necesita su plazo");
  await datos.getByLabel("Plazo (días)").fill("30");
  await datos.getByLabel("Moneda").selectOption("PEN");
  await datos.getByRole("button", { name: "Guardar" }).click();
  await expect(datos).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Datos guardados");
  await expect(page.getByText("Arequipa", { exact: true })).toBeVisible();
  await expect(page.getByText("Av. Los Pinos 123, Huancayo")).toBeVisible();
  await expect(page.getByText("Crédito a 30 días").first()).toBeVisible();
  await expect(page.getByText("Soles (S/)")).toBeVisible();
  await expect(page.getByText("Arequipa, Perú")).toBeVisible();

  // Resumen: 3 de los 5 datos que cuenta «Ficha completa» (faltan el RUC y el contacto).
  await page.getByRole("tab", { name: "Resumen" }).click();
  await expect(page.getByLabel("Indicadores del proveedor").getByText("60%")).toBeVisible();
  await expect(
    page.getByLabel("Indicadores del proveedor").getByText("Faltan datos")
  ).toBeVisible();
  await expect(page.getByText("Sin contacto").first()).toBeVisible();

  // 2. Contactos.
  await page.getByRole("tab", { name: "Contactos" }).click();
  await expect(page.getByText("Este proveedor todavía no tiene contactos.")).toBeVisible();
  await page.getByRole("button", { name: "Agregar contacto" }).click();
  const formulario = page.getByRole("dialog", { name: "Agregar contacto" });
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario.getByRole("alert")).toContainText("Escribe el nombre del contacto.");
  await expect(formulario.getByRole("alert")).toContainText("Escribe un teléfono o un correo.");
  await formulario.getByLabel("Nombre", { exact: true }).fill("Rosa Quispe");
  await formulario.getByLabel("Cargo (opcional)").fill("Ventas");
  await formulario.getByLabel("Teléfono").fill("987654321");
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Contacto agregado");
  const rosa = page.getByRole("listitem").filter({ hasText: "Rosa Quispe" });
  await expect(rosa).toContainText("Principal");

  await page.getByRole("button", { name: "Agregar contacto" }).click();
  await formulario.getByLabel("Nombre", { exact: true }).fill("Juan Pérez");
  await formulario.getByLabel("Correo").fill("juan@grifo.pe");
  await formulario.getByLabel("Es el contacto principal").check();
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario).toHaveCount(0);
  const juan = page.getByRole("listitem").filter({ hasText: "Juan Pérez" });
  await expect(juan).toContainText("Principal", { timeout: 20_000 });
  await expect(rosa).not.toContainText("Principal");

  // Editar y quitar (con confirmación): Rosa se va y Juan sigue de principal.
  await page.getByRole("button", { name: "Editar contacto Rosa Quispe" }).click();
  const edicion = page.getByRole("dialog", { name: "Editar contacto" });
  await edicion.getByLabel("Cargo (opcional)").fill("Ventas y cobranza");
  await edicion.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Ventas y cobranza")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Quitar contacto Rosa Quispe" }).click();
  await page.getByRole("button", { name: "No" }).click();
  await expect(rosa).toBeVisible();
  await page.getByRole("button", { name: "Quitar contacto Rosa Quispe" }).click();
  await page.getByRole("button", { name: "Sí, quitar" }).click();
  await expect(page.getByRole("status")).toContainText("Contacto quitado");
  await expect(rosa).toHaveCount(0);
  await expect(juan).toContainText("Principal");

  // 3. Lectura ve la ficha y los contactos, sin botones para cambiarlos.
  const email = `lectura-ficha-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const usuario = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Lectura ${marca}`, email, password: temporal, rol: "lectura" },
  });
  expect(usuario.ok(), await usuario.text()).toBeTruthy();
  const contexto = await browser.newContext();
  const lectura = await contexto.newPage();
  try {
    await lectura.goto("/");
    await lectura.getByLabel("Correo").fill(email);
    await lectura.getByLabel("Contraseña").fill(temporal);
    await pulsarIngresar(lectura);
    await lectura.locator("#passwordActual").fill(temporal);
    await lectura.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await lectura.locator("#confirmacion").fill(`${temporal}Nueva`);
    await lectura.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(lectura.getByRole("button", { name: "Dashboard" })).toBeVisible({
      timeout: 20_000,
    });
    await abrirFicha(lectura, nombre, marca);
    await expect(lectura.getByText("Crédito a 30 días")).toBeVisible({ timeout: 20_000 });
    await expect(lectura.getByRole("button", { name: "Más acciones" })).toHaveCount(0);
    await expect(lectura.getByRole("tab", { name: "Historial" })).toHaveCount(0);
    await lectura.getByRole("tab", { name: "Datos generales" }).click();
    await expect(lectura.getByRole("button", { name: "Editar datos" })).toHaveCount(0);
    await lectura.getByRole("tab", { name: "Contactos" }).click();
    await expect(lectura.getByText("Juan Pérez")).toBeVisible({ timeout: 20_000 });
    await expect(lectura.getByRole("button", { name: "Agregar contacto" })).toHaveCount(0);
    await expect(lectura.getByRole("button", { name: /^Quitar contacto/ })).toHaveCount(0);
    await expect(lectura.getByRole("button", { name: /^Editar contacto/ })).toHaveCount(0);
  } finally {
    await contexto.close();
  }
});
