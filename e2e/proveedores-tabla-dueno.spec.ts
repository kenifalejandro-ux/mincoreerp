/** e2e/proveedores-tabla-dueno.spec.ts
 *
 * PR6: el catálogo de proveedores es del módulo Proveedores; la pestaña «Proveedores» de Combustible se
 * oculta SOLO cuando hay a dónde ir. Tres casos en el navegador:
 *
 * 1. Empresa con ambos módulos (admin): el submenú de Combustible ya no trae «Proveedores»; el proveedor se
 *    ve y se registra en el Directorio de «Gestión de proveedores».
 * 2. Empresa SOLO con Combustible (sin el módulo Proveedores): la pestaña sigue igual y se registra un
 *    proveedor desde ahí. Es la autonomía de Combustible.
 * 3. Una persona sin el módulo Proveedores asignado, en una empresa que sí lo tiene: sigue editando en
 *    Combustible (si no, no tendría dónde).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA, leerEnv } from "./fixtures/entorno";

async function abrirProveedoresDeCombustible(page: Page) {
  const submenu = page.locator('div[aria-hidden="false"] button');
  const entrada = page.getByRole("button", { name: /^Combustible Abrir submenú$/ });
  await entrada.click();
  await submenu.filter({ hasText: /^Proveedores$/ }).click();
  await expect(page.getByRole("heading", { name: "Proveedores", level: 2 })).toBeVisible({
    timeout: 15_000,
  });
}

test("con ambos módulos «Proveedores» sale del menú de Combustible y el alta se hace en el ecosistema", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const nombre = `GRIFO DUENO ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const alta = await page.request.post("/api/erp/combustible/grifos", { data: { nombre } });
  expect(alta.ok(), await alta.text()).toBeTruthy();

  // El submenú de Combustible ya no trae «Proveedores» (sí «Precios», con la venta interna).
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  const submenu = page.locator('div[aria-hidden="false"] button');
  await expect(submenu.filter({ hasText: /^Precios$/ })).toBeVisible();
  await expect(submenu.filter({ hasText: /^Proveedores$/ })).toHaveCount(0);

  // El proveedor existe y se maneja en el ecosistema, con su dirección.
  await page.goto("/proveedores/directorio");
  await page.getByPlaceholder("Buscar por nombre, código o RUC").fill(marca);
  await expect(page.getByRole("row", { name: new RegExp(nombre) })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Registrar proveedor" })).toBeVisible();
});

test("una empresa solo con Combustible sigue registrando proveedores desde su pestaña", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toLowerCase();
  const BEARER = { Authorization: `Bearer ${leerEnv("PLATFORM_ADMIN_TOKEN")}` };
  const password = `Solo!${marca}2026`;
  const email = `solo-comb-${marca}@mincoreerp.test`;
  const creada = await request.post("/api/platform/tenants", {
    headers: BEARER,
    data: {
      tenantNombre: `Solo Combustible ${marca}`,
      tenantSlug: `solo-comb-${marca}`,
      adminNombre: "Admin Solo Combustible",
      adminEmail: email,
      adminPassword: password,
    },
  });
  expect(creada.ok(), await creada.text()).toBeTruthy();
  const tenantId = (await creada.json()).tenant.id as string;
  const actuales = await request.get(`/api/platform/tenants/${tenantId}/modulos`, {
    headers: BEARER,
  });
  const modulos = (await actuales.json()).modulos as { modulo: string }[];
  const apagar = await request.put(`/api/platform/tenants/${tenantId}/modulos`, {
    headers: BEARER,
    data: {
      configuraciones: modulos.map((m) => ({
        modulo: m.modulo,
        estado: m.modulo === "combustible" ? "habilitado" : "deshabilitado",
      })),
    },
  });
  expect(apagar.ok(), await apagar.text()).toBeTruthy();

  await page.goto("/");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  const cambio = page.locator("#passwordActual");
  const combustible = page.getByRole("button", { name: /^Combustible Abrir submenú$/ });
  await cambio.or(combustible).first().waitFor({ timeout: 20_000 });
  if (await cambio.isVisible()) {
    await cambio.fill(password);
    await page.locator("#passwordNueva").fill(`${password}Nueva`);
    await page.locator("#confirmacion").fill(`${password}Nueva`);
    await page.getByRole("button", { name: "Guardar y continuar" }).click();
  }
  await expect(combustible).toBeVisible({ timeout: 20_000 });
  // Sin el módulo Proveedores no hay ecosistema en el menú.
  await expect(page.getByRole("button", { name: /Gestión de proveedores/ })).toHaveCount(0);

  await abrirProveedoresDeCombustible(page);
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Nuevo proveedor" }).click();
  const dialogo = page.getByRole("dialog", { name: "Nuevo proveedor" });
  await dialogo.getByLabel("Nombre").fill(`GRIFO SOLO ${marca}`);
  await dialogo.getByRole("button", { name: "Agregar" }).click();
  await expect(dialogo).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(`GRIFO SOLO ${marca}`) })).toBeVisible({
    timeout: 20_000,
  });
});

test("quien no tiene el módulo Proveedores asignado sigue editando en Combustible", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const email = `operador-dueno-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Operador ${marca}`, email, password: temporal, rol: "operador" },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  const id = (await alta.json()).id as string;
  // Se le quita el módulo Proveedores (la empresa lo sigue teniendo).
  const permisos = await page.request.get(`/api/erp/usuarios/${id}/permisos`);
  const cuerpo = await permisos.json();
  const guardado = await page.request.put(`/api/erp/usuarios/${id}/permisos`, {
    data: {
      modulos: cuerpo.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: m.modulo === "proveedores" ? false : m.asignado,
        nivel: m.nivel,
      })),
      motivo: "Prueba: sin Proveedores",
    },
  });
  expect(guardado.ok(), await guardado.text()).toBeTruthy();

  const contexto = await browser.newContext();
  const operador = await contexto.newPage();
  try {
    await operador.goto("/");
    await operador.getByLabel("Correo").fill(email);
    await operador.getByLabel("Contraseña").fill(temporal);
    await operador.getByRole("button", { name: "Ingresar" }).click();
    await operador.locator("#passwordActual").fill(temporal);
    await operador.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await operador.locator("#confirmacion").fill(`${temporal}Nueva`);
    await operador.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(operador.getByRole("button", { name: /^Combustible Abrir submenú$/ })).toBeVisible(
      {
        timeout: 20_000,
      }
    );
    await expect(operador.getByRole("button", { name: /Gestión de proveedores/ })).toHaveCount(0);
    await abrirProveedoresDeCombustible(operador);
    await expect(operador.getByRole("button", { name: "Nuevo proveedor" })).toBeVisible();
    await expect(operador.getByRole("status")).toHaveCount(0);
  } finally {
    await contexto.close();
  }
});
