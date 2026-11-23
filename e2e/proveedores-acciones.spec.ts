/** e2e/proveedores-acciones.spec.ts
 *
 * Acciones sobre un proveedor del ecosistema «Gestión de proveedores»: desactivar, reactivar y eliminar, desde
 * el menú de cada fila del Directorio y desde «Más acciones» de su panel.
 *
 * 1. Desactivar pide el motivo; el Directorio lo muestra «Desactivado» y el menú ofrece «Reactivar».
 * 2. Un proveedor con precios no se elimina: el diálogo dice por qué y ofrece desactivarlo en su lugar.
 * 3. Uno sin historia se elimina y desaparece del Directorio; el Historial dice quién lo hizo y cuál era.
 * 4. Desde el panel: eliminar cierra el panel y la lista se actualiza.
 * 5. El operador desactiva pero no elimina.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI, pulsarIngresar } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const BUSCADOR = "Buscar por razón social, RUC, código o ciudad...";

async function alDirectorio(page: Page) {
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible();
  return menu;
}

async function crear(page: Page, nombre: string) {
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
}

test("desactivar, reactivar y eliminar proveedores", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const libre = `GRIFO LIBRE ${marca}`;
  const conPrecio = `GRIFO CON PRECIO ${marca}`;
  const desdePanel = `GRIFO PANEL ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await crear(page, libre);
  const idConPrecio = await crear(page, conPrecio);
  await crear(page, desdePanel);
  const precio = await page.request.post("/api/erp/combustible/precios/masivo", {
    data: { tipo_combustible: "diesel_b5", grifo_ids: [idConPrecio], precio_unitario: 15.2 },
  });
  expect(precio.ok(), await precio.text()).toBeTruthy();

  const menu = await alDirectorio(page);
  await page.getByPlaceholder(BUSCADOR).fill(marca);
  const fila = (nombre: string) => page.getByRole("row", { name: new RegExp(nombre) });
  const acciones = (nombre: string) =>
    fila(nombre).getByRole("button", { name: "Acciones del proveedor" });
  await expect(fila(libre)).toBeVisible({ timeout: 20_000 });

  // 1. Desactivar pide el motivo; después, el menú ofrece reactivar.
  await acciones(libre).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Editar proveedor",
    "Desactivar proveedor",
    "Eliminar proveedor",
  ]);
  await page.getByRole("menuitem", { name: "Desactivar proveedor" }).click();
  const desactivar = page.getByRole("dialog", { name: "Desactivar proveedor" });
  await desactivar.getByRole("button", { name: "Desactivar proveedor" }).click();
  await expect(desactivar.getByRole("alert")).toContainText("Escribe el motivo");
  await desactivar.getByLabel("Motivo").fill("Ya no nos abastece");
  await desactivar.getByRole("button", { name: "Desactivar proveedor" }).click();
  await expect(desactivar).toHaveCount(0);
  await expect(fila(libre).getByText("Desactivado")).toBeVisible({ timeout: 20_000 });
  await acciones(libre).click();
  await expect(page.getByRole("menuitem", { name: "Reactivar proveedor" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Reactivar proveedor" }).click();
  const reactivar = page.getByRole("dialog", { name: "Reactivar proveedor" });
  // Reactivar no exige motivo.
  await reactivar.getByRole("button", { name: "Reactivar proveedor" }).click();
  await expect(reactivar).toHaveCount(0);
  await expect(fila(libre).getByText("Activo", { exact: true })).toBeVisible({ timeout: 20_000 });

  // 2. Con precios no se elimina: el diálogo dice por qué y ofrece desactivarlo en su lugar.
  await acciones(conPrecio).click();
  await page.getByRole("menuitem", { name: "Eliminar proveedor" }).click();
  const eliminar = page.getByRole("dialog", { name: "Eliminar proveedor" });
  await expect(eliminar.getByText(/No se puede eliminar: tiene 1 precio/)).toBeVisible();
  await expect(eliminar.getByRole("button", { name: "Eliminar proveedor" })).toHaveCount(0);
  await eliminar.getByRole("button", { name: "Desactivar en su lugar" }).click();
  await page
    .getByRole("dialog", { name: "Desactivar proveedor" })
    .getByLabel("Motivo")
    .fill("Se cambió de proveedor");
  await page
    .getByRole("dialog", { name: "Desactivar proveedor" })
    .getByRole("button", { name: "Desactivar proveedor" })
    .click();
  await expect(fila(conPrecio).getByText("Desactivado")).toBeVisible({ timeout: 20_000 });

  // 3. Uno sin historia se elimina y desaparece de la lista.
  await acciones(libre).click();
  await page.getByRole("menuitem", { name: "Eliminar proveedor" }).click();
  await expect(eliminar.getByText(/Se eliminará/)).toBeVisible();
  await expect(eliminar.getByText(/no se puede deshacer/i)).toBeVisible();
  await eliminar.getByRole("button", { name: "Eliminar proveedor" }).click();
  await expect(eliminar).toHaveCount(0);
  await expect(fila(libre)).toHaveCount(0, { timeout: 20_000 });

  // 4. Desde el panel: «Eliminar» cierra el panel y la lista se actualiza.
  await fila(desdePanel)
    .getByRole("button", { name: new RegExp(desdePanel) })
    .click();
  const panel = page.getByRole("complementary", { name: "Detalle del proveedor" });
  await expect(
    panel.getByRole("heading", { name: new RegExp(desdePanel), level: 1 })
  ).toBeVisible();
  await panel.getByRole("button", { name: "Más acciones" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Editar proveedor",
    "Desactivar proveedor",
    "Eliminar proveedor",
  ]);
  // Escape cierra solo el menú, no el panel.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Más acciones" }).click();
  await page.getByRole("menuitem", { name: "Eliminar proveedor" }).click();
  await eliminar.getByRole("button", { name: "Eliminar proveedor" }).click();
  await expect(panel).toHaveCount(0, { timeout: 20_000 });
  await expect(fila(desdePanel)).toHaveCount(0);

  // El Historial lo cuenta: quién desactivó (con motivo) y quién eliminó y cuál era.
  await menu.getByRole("button", { name: "Historial y auditoría" }).click();
  await page.getByLabel("Tipo").selectOption("proveedor");
  await page.getByPlaceholder("Buscar por nombre del proveedor").fill("");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByText("Desactivó un proveedor").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Motivo: Ya no nos abastece").first()).toBeVisible();
  await expect(page.getByText(`${libre} · PRV-`)).toBeVisible();
  await expect(page.getByText(`${desdePanel} · PRV-`)).toBeVisible();
  await expect(page.getByText("Eliminó un proveedor").first()).toBeVisible();

  // 5. El operador desactiva pero no elimina.
  const email = `operador-acciones-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const usuario = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Operador ${marca}`, email, password: temporal, rol: "operador" },
  });
  expect(usuario.ok(), await usuario.text()).toBeTruthy();
  const contexto = await browser.newContext();
  const operador = await contexto.newPage();
  try {
    await operador.goto("/");
    await operador.getByLabel("Correo").fill(email);
    await operador.getByLabel("Contraseña").fill(temporal);
    await pulsarIngresar(operador);
    await operador.locator("#passwordActual").fill(temporal);
    await operador.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await operador.locator("#confirmacion").fill(`${temporal}Nueva`);
    await operador.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(operador.getByRole("button", { name: "Dashboard" })).toBeVisible({
      timeout: 20_000,
    });
    await alDirectorio(operador);
    await operador.getByPlaceholder(BUSCADOR).fill(marca);
    await expect(operador.getByRole("row", { name: new RegExp(conPrecio) })).toBeVisible({
      timeout: 20_000,
    });
    await operador
      .getByRole("row", { name: new RegExp(conPrecio) })
      .getByRole("button", { name: "Acciones del proveedor" })
      .click();
    await expect(operador.getByRole("menuitem")).toHaveText([
      "Editar proveedor",
      "Reactivar proveedor",
    ]);
  } finally {
    await contexto.close();
  }
});
