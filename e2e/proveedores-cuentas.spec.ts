/** e2e/proveedores-cuentas.spec.ts
 *
 * Ecosistema «Gestión de proveedores», PR3b: cuentas bancarias del proveedor. Con el admin del tenant sembrado:
 *
 * 1. El admin agrega una cuenta (valida lo que falta): la pantalla muestra solo «•••• 4567»; «Ver número
 *    completo» lo muestra y «Ocultar número» lo esconde; edita sin tocar el número; agrega otra como principal
 *    (la primera deja de serlo); quita una con motivo.
 * 2. Un operador NO ve la pestaña «Cuentas» por defecto. El admin le da, desde Administración → Configuración,
 *    «ver» y «ver el número completo»: ve la lista y el número completo, pero no puede agregar, editar ni quitar.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Browser, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const NUMERO = "19412345678901234567";
const AGRUPADO = "1941 2345 6789 0123 4567";

async function abrirFicha(page: Page, nombre: string, marca: string) {
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  // Según su perfil, la persona aterriza en el ERP (con su menú) o directo en el ecosistema.
  const entrada = page.getByRole("button", { name: /Gestión de proveedores/ });
  await menu.or(entrada).first().waitFor({ timeout: 20_000 });
  if (!(await menu.isVisible())) {
    await entrada.click();
    await page.getByRole("button", { name: "Centro de administración" }).click();
  }
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await page.getByPlaceholder("Buscar por nombre, código o RUC").fill(marca);
  await page
    .getByRole("row", { name: new RegExp(nombre) })
    .getByRole("button", { name: new RegExp(nombre) })
    .click();
  await expect(page.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible();
}

/** Entra con la clave temporal (cambio obligatorio) o con la nueva si ya la cambió. */
async function entrarComoPersona(browser: Browser, email: string, clave: string, primera: boolean) {
  const contexto = await browser.newContext();
  const pagina = await contexto.newPage();
  await pagina.goto("/");
  await pagina.getByLabel("Correo").fill(email);
  await pagina.getByLabel("Contraseña").fill(clave);
  await pagina.getByRole("button", { name: "Ingresar" }).click();
  if (primera) {
    await pagina.locator("#passwordActual").fill(clave);
    await pagina.locator("#passwordNueva").fill(`${clave}Nueva`);
    await pagina.locator("#confirmacion").fill(`${clave}Nueva`);
    await pagina.getByRole("button", { name: "Guardar y continuar" }).click();
  }
  // Aterriza en el ERP (Dashboard) o, si su primer módulo es el ecosistema, directo en él.
  await pagina
    .getByRole("button", { name: "Dashboard" })
    .or(pagina.getByRole("complementary", { name: "Menú de Gestión de proveedores" }))
    .first()
    .waitFor({ timeout: 20_000 });
  return { contexto, pagina };
}

test("cuentas bancarias: número enmascarado, ver completo con permiso y operador sin acceso", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const nombre = `GRIFO CUENTAS ${marca}`;
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

  // 1. El admin agrega, ve, edita, cambia de principal y quita.
  await page.getByRole("tab", { name: "Cuentas" }).click();
  await expect(page.getByText("Este proveedor todavía no tiene cuentas bancarias.")).toBeVisible();
  await page.getByRole("button", { name: "Agregar cuenta" }).click();
  const formulario = page.getByRole("dialog", { name: "Agregar cuenta bancaria" });
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario.getByRole("alert")).toContainText("Escribe el banco.");
  await expect(formulario.getByRole("alert")).toContainText("Escribe el número de cuenta o CCI.");
  await formulario.getByLabel("Banco").fill("BCP");
  await formulario.getByLabel("Titular (opcional)").fill("GRIFO CUENTAS SAC");
  await formulario.getByLabel("Número de cuenta o CCI").fill("1234");
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario.getByRole("alert")).toContainText("de 8 a 20 dígitos");
  await formulario.getByLabel("Número de cuenta o CCI").fill("194-1234 5678 9012 34567");
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Cuenta agregada");

  const bcp = page.getByRole("listitem").filter({ hasText: "BCP" });
  await expect(bcp).toContainText("•••• 4567");
  await expect(bcp).toContainText("Principal");
  // En la pantalla no está el número entero.
  await expect(page.locator("body")).not.toContainText(AGRUPADO);
  await expect(page.locator("body")).not.toContainText(NUMERO);

  await page.getByRole("button", { name: /^Ver número completo de la cuenta BCP/ }).click();
  await expect(page.getByLabel("Número de la cuenta BCP")).toHaveText(AGRUPADO);
  await page.getByRole("button", { name: "Ocultar número" }).click();
  await expect(page.getByLabel("Número de la cuenta BCP")).toHaveText("•••• 4567");
  await expect(page.locator("body")).not.toContainText(AGRUPADO);

  // Editar sin tocar el número: se conserva.
  await page.getByRole("button", { name: /^Editar cuenta BCP/ }).click();
  const edicion = page.getByRole("dialog", { name: "Editar cuenta bancaria" });
  await expect(edicion.getByLabel("Número de cuenta o CCI")).toHaveValue("");
  await edicion.getByLabel("Titular (opcional)").fill("GRIFO CUENTAS S.A.C.");
  await edicion.getByRole("button", { name: "Guardar" }).click();
  await expect(edicion).toHaveCount(0);
  await expect(page.getByText("Titular: GRIFO CUENTAS S.A.C.")).toBeVisible({ timeout: 20_000 });
  await expect(bcp).toContainText("•••• 4567");

  // Una segunda cuenta como principal: la primera deja de serlo.
  await page.getByRole("button", { name: "Agregar cuenta" }).click();
  await formulario.getByLabel("Banco").fill("BBVA");
  await formulario.getByLabel("Número de cuenta o CCI").fill("00112233445566778899");
  await formulario.getByLabel("Es la cuenta principal").check();
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario).toHaveCount(0);
  const bbva = page.getByRole("listitem").filter({ hasText: "BBVA" });
  await expect(bbva).toContainText("Principal", { timeout: 20_000 });
  await expect(bcp).not.toContainText("Principal");

  // Quitar pide motivo; con él la cuenta sale de la lista y la otra sigue de principal.
  await page.getByRole("button", { name: /^Quitar cuenta BCP/ }).click();
  const quitar = page.getByRole("dialog", { name: "Quitar cuenta" });
  await quitar.getByRole("button", { name: "Quitar cuenta" }).click();
  await expect(quitar.getByRole("alert")).toContainText("Escribe el motivo");
  await quitar.getByLabel("Motivo").fill("Cerró la cuenta");
  await quitar.getByRole("button", { name: "Quitar cuenta" }).click();
  await expect(quitar).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Cuenta quitada");
  await expect(bcp).toHaveCount(0);
  await expect(bbva).toContainText("Principal");

  // 2. Un operador no ve «Cuentas» por defecto; con «ver» y «ver completo» ve el número pero no edita.
  const email = `operador-cuentas-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const nombrePersona = `Operador ${marca}`;
  const usuario = await page.request.post("/api/erp/usuarios", {
    data: { nombre: nombrePersona, email, password: temporal, rol: "operador" },
  });
  expect(usuario.ok(), await usuario.text()).toBeTruthy();

  const sinPermiso = await entrarComoPersona(browser, email, temporal, true);
  try {
    await abrirFicha(sinPermiso.pagina, nombre, marca);
    await expect(sinPermiso.pagina.getByRole("tab", { name: "Contactos" })).toBeVisible();
    await expect(sinPermiso.pagina.getByRole("tab", { name: "Cuentas" })).toHaveCount(0);
  } finally {
    await sinPermiso.contexto.close();
  }

  // El admin se las da desde Administración → Configuración.
  await page.getByRole("button", { name: "Volver al ERP" }).click();
  await page.getByRole("button", { name: "Administración" }).click();
  await page.getByRole("button", { name: "Configuración" }).click();
  await page.getByRole("button", { name: new RegExp(nombrePersona) }).click();
  await page.getByText("Menú: Gestión de proveedores").click();
  // El item más interno (el último en el documento) es el de la propia casilla; el de afuera es el módulo.
  const casilla = (texto: string) =>
    page.getByRole("listitem").filter({ hasText: texto }).last().getByRole("checkbox");
  await casilla("Ver el número completo de la cuenta").check();
  await expect(casilla("Ver el número completo de la cuenta")).toBeChecked();
  // El submenú no es un item de lista sino el encabezado del bloque: su casilla es la primera del módulo.
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Menú: Gestión de proveedores" })
      .getByRole("checkbox")
      .first()
  ).toBeChecked();
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByText(/^Guardado\./)).toBeVisible({ timeout: 20_000 });

  const conPermiso = await entrarComoPersona(browser, email, `${temporal}Nueva`, false);
  try {
    const p = conPermiso.pagina;
    await abrirFicha(p, nombre, marca);
    await p.getByRole("tab", { name: "Cuentas" }).click();
    await expect(p.getByRole("listitem").filter({ hasText: "BBVA" })).toContainText("•••• 8899", {
      timeout: 20_000,
    });
    await p.getByRole("button", { name: /^Ver número completo de la cuenta BBVA/ }).click();
    await expect(p.getByLabel("Número de la cuenta BBVA")).toHaveText("0011 2233 4455 6677 8899");
    await expect(p.getByRole("button", { name: "Agregar cuenta" })).toHaveCount(0);
    await expect(p.getByRole("button", { name: /^Editar cuenta/ })).toHaveCount(0);
    await expect(p.getByRole("button", { name: /^Quitar cuenta/ })).toHaveCount(0);
  } finally {
    await conPermiso.contexto.close();
  }
});
