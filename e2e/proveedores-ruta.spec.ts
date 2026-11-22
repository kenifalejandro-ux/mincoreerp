/** e2e/proveedores-ruta.spec.ts
 *
 * Las direcciones del ecosistema «Gestión de proveedores»: una por sección y por ficha.
 *
 * 1. Navegando por el menú la dirección cambia (`/proveedores`, `/proveedores/directorio`, la ficha y su
 *    pestaña), F5 deja en el mismo lugar y «atrás» recorre el camino hasta volver al ERP.
 * 2. Un enlace directo abre la ficha en su pestaña; uno a un proveedor que no existe muestra la lista y se
 *    corrige; una sección desconocida cae al Centro.
 * 3. Sin sesión, el enlace pide iniciar sesión y, al entrar, abre ESA ficha.
 * 4. Una persona sin el módulo Proveedores que abre `/proveedores` queda en su inicio, con la dirección `/`.
 * 5. Una empresa SOLO con Proveedores aterriza en el ecosistema y su dirección es `/proveedores`.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA, leerEnv } from "./fixtures/entorno";

const ruta = (page: Page) => new URL(page.url()).pathname;
const menuDe = (page: Page) =>
  page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });

test("la dirección sigue a la pantalla: menú, F5, atrás y enlaces directos", async ({ page }) => {
  test.setTimeout(150_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const nombre = `GRIFO RUTA ${marca}`;
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
  const id = (await alta.json()).id as number;

  // 1. Por el menú.
  expect(ruta(page)).toBe("/");
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = menuDe(page);
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => ruta(page)).toBe("/proveedores");
  await expect(page).toHaveTitle(/Centro de gestión · Gestión de proveedores/);

  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await expect.poll(() => ruta(page)).toBe("/proveedores/directorio");
  await page.getByPlaceholder("Buscar por nombre, código o RUC").fill(marca);
  await page
    .getByRole("row", { name: new RegExp(nombre) })
    .getByRole("button", { name: new RegExp(nombre) })
    .click();
  await expect.poll(() => ruta(page)).toBe(`/proveedores/directorio/${id}`);
  await page.getByRole("tab", { name: "Contactos" }).click();
  await expect.poll(() => ruta(page)).toBe(`/proveedores/directorio/${id}/contactos`);

  // F5: sigue en la ficha, en la pestaña Contactos.
  await page.reload();
  await expect(page.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("tab", { name: "Contactos" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(ruta(page)).toBe(`/proveedores/directorio/${id}/contactos`);

  // «Atrás»: a la pestaña anterior de la ficha, a la lista, al Centro y de vuelta al ERP.
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Resumen" })).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 20_000 }
  );
  expect(ruta(page)).toBe(`/proveedores/directorio/${id}`);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible({ timeout: 20_000 });
  expect(ruta(page)).toBe("/proveedores/directorio");
  await page.goBack();
  await expect(page.getByRole("heading", { name: /^Buenos|^Buenas/, level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  expect(ruta(page)).toBe("/proveedores");
  await page.goBack();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
  expect(ruta(page)).toBe("/");
  // «Adelante» vuelve al ecosistema.
  await page.goForward();
  await expect(menuDe(page)).toBeVisible({ timeout: 20_000 });
  expect(ruta(page)).toBe("/proveedores");

  // 2. Enlaces directos.
  await page.goto(`/proveedores/directorio/${id}/comercial`);
  await expect(page.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("tab", { name: "Comercial" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.goto("/proveedores/directorio/99999999");
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => ruta(page)).toBe("/proveedores/directorio");
  await page.goto("/proveedores/xyz");
  await expect(menuDe(page)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => ruta(page)).toBe("/proveedores");
  await page.goto("/proveedores/historial");
  await expect(page.getByRole("heading", { name: "Historial y auditoría", level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  expect(ruta(page)).toBe("/proveedores/historial");

  // 3. Sin sesión: el enlace pide iniciar sesión y, al entrar, abre ESA ficha.
  await page.context().clearCookies();
  await page.goto(`/proveedores/directorio/${id}`);
  await page.getByLabel("Correo").fill(admin.email);
  await page.getByLabel("Contraseña").fill(admin.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  expect(ruta(page)).toBe(`/proveedores/directorio/${id}`);
});

test("sin el módulo Proveedores, abrir /proveedores deja a la persona en su inicio", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const email = `operador-ruta-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Operador ${marca}`, email, password: temporal, rol: "operador" },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  const id = (await alta.json()).id as string;
  const permisos = await (await page.request.get(`/api/erp/usuarios/${id}/permisos`)).json();
  const guardado = await page.request.put(`/api/erp/usuarios/${id}/permisos`, {
    data: {
      modulos: permisos.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
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
    await operador.goto("/proveedores/directorio");
    await operador.getByLabel("Correo").fill(email);
    await operador.getByLabel("Contraseña").fill(temporal);
    await operador.getByRole("button", { name: "Ingresar" }).click();
    await operador.locator("#passwordActual").fill(temporal);
    await operador.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await operador.locator("#confirmacion").fill(`${temporal}Nueva`);
    await operador.getByRole("button", { name: "Guardar y continuar" }).click();
    // No hay ecosistema para esta persona: queda en el ERP y la dirección vuelve a la raíz.
    await expect(operador.getByRole("button", { name: /^Combustible Abrir submenú$/ })).toBeVisible(
      {
        timeout: 20_000,
      }
    );
    await expect(menuDe(operador)).toHaveCount(0);
    await expect.poll(() => ruta(operador)).toBe("/");
  } finally {
    await contexto.close();
  }
});

test("una empresa solo con Proveedores aterriza en el ecosistema, en /proveedores", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toLowerCase();
  const BEARER = { Authorization: `Bearer ${leerEnv("PLATFORM_ADMIN_TOKEN")}` };
  const password = `Solo!${marca}2026`;
  const email = `solo-ruta-${marca}@mincoreerp.test`;
  const creada = await request.post("/api/platform/tenants", {
    headers: BEARER,
    data: {
      tenantNombre: `Solo Proveedores Ruta ${marca}`,
      tenantSlug: `solo-ruta-${marca}`,
      adminNombre: "Admin Solo Proveedores",
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
        estado: m.modulo === "proveedores" ? "habilitado" : "deshabilitado",
      })),
    },
  });
  expect(apagar.ok(), await apagar.text()).toBeTruthy();

  await page.goto("/");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  const cambio = page.locator("#passwordActual");
  await cambio.or(menuDe(page)).first().waitFor({ timeout: 20_000 });
  if (await cambio.isVisible()) {
    await cambio.fill(password);
    await page.locator("#passwordNueva").fill(`${password}Nueva`);
    await page.locator("#confirmacion").fill(`${password}Nueva`);
    await page.getByRole("button", { name: "Guardar y continuar" }).click();
  }
  await expect(menuDe(page)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => ruta(page)).toBe("/proveedores");
  await menuDe(page).getByRole("button", { name: "Directorio de proveedores" }).click();
  await expect.poll(() => ruta(page)).toBe("/proveedores/directorio");
  // Entra de nuevo, ya con su clave propia, por un enlace directo al Directorio. (No se recarga justo después
  // del primer ingreso: el token sigue diciendo «cambiar clave» hasta que se renueva.)
  await page.context().clearCookies();
  await page.goto("/proveedores/directorio");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(`${password}Nueva`);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible({ timeout: 30_000 });
  expect(ruta(page)).toBe("/proveedores/directorio");
});
