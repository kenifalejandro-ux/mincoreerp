/** e2e/sesion-sin-conexion.spec.ts
 *
 * Reabrir la app cuando /api/auth/me no responde (sin señal o servidor caído)
 * entra con el perfil guardado en vez de mandar al login; un 401 real sí manda
 * al login. Se simula con page.route sobre /me, sin cortar toda la red: así el
 * test no depende de que el service worker esté activo en el entorno de e2e.
 *
 * Necesita el tenant A sembrado, como los otros specs.
 */
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const dashboard = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Dashboard" });

test("sin conexión con /me, la app reabre con el perfil guardado", async ({ page }) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await page.route("**/api/auth/me", (ruta) => ruta.abort("internetdisconnected"));
  await page.reload();

  await expect(dashboard(page)).toBeVisible();
});

test("con el servidor caído (503) en /me, la app reabre con el perfil guardado", async ({
  page,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await page.route("**/api/auth/me", (ruta) =>
    ruta.fulfill({ status: 503, contentType: "application/json", body: "{}" })
  );
  await page.reload();

  await expect(dashboard(page)).toBeVisible();
});

test("un 401 real de /me manda al login y borra el perfil", async ({ page }) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await page.route("**/api/auth/me", (ruta) =>
    ruta.fulfill({ status: 401, contentType: "application/json", body: "{}" })
  );
  await page.route("**/api/auth/refresh", (ruta) =>
    ruta.fulfill({ status: 401, contentType: "application/json", body: "{}" })
  );
  await page.reload();

  await expect(page.getByLabel("Correo")).toBeVisible();
  const perfil = await page.evaluate(() => localStorage.getItem("erp-perfil-offline"));
  expect(perfil).toBeNull();
});

test("al cerrar sesión se borra el perfil guardado", async ({ page }) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  expect(await page.evaluate(() => localStorage.getItem("erp-perfil-offline"))).not.toBeNull();

  await page.getByRole("button", { name: /salir/i }).click();
  await expect(page.getByLabel("Correo")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("erp-perfil-offline"))).toBeNull();
});

test("tras SALIR, sin servidor, se vuelve a entrar con la clave del equipo", async ({ page }) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await page.getByRole("button", { name: /salir/i }).click();
  await expect(page.getByLabel("Correo")).toBeVisible();

  // Sin servidor: el login falla por red (o con 503) y entra la huella local.
  await page.route("**/api/auth/login", (ruta) => ruta.abort("internetdisconnected"));
  await page.route("**/api/auth/me", (ruta) => ruta.abort("internetdisconnected"));

  await page.getByLabel("Correo").fill(admin.email);
  await page.getByLabel("Contraseña").fill("clave-equivocada");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByText("clave incorrecta")).toBeVisible();

  await page.getByLabel("Contraseña").fill(admin.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(dashboard(page)).toBeVisible();
});
