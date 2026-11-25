/** e2e/mantenimiento-ecosistema.spec.ts
 *
 * El ecosistema «Gestión de mantenimiento» (M1, etapa 1), por navegador, con una empresa que tiene SOLO el
 * módulo `mantenimiento` (regla de autonomía): sin Flota, Checklists, Órdenes de trabajo ni Almacén.
 *
 * 1. Abre desde el menú del ERP, con su propio menú y su Centro de mantenimiento.
 * 2. Equipos se abre, dice que todavía no hay equipos y la dirección es /mantenimiento/equipos; F5 se queda ahí.
 * 3. Con un solo módulo no hay ERP al que volver: no hay botón «Volver al ERP».
 * 4. Una empresa que no tiene el módulo no ve la entrada ni entra escribiendo la dirección.
 *
 * La empresa de cada test es nueva (no hay API para borrarlas): la base de los e2e es efímera en CI.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

/** Vuelve a entrar con la clave que dejó el cambio obligatorio. Recargar justo después de ese cambio vuelve a
 *  pedirlo (el JWT sigue diciendo que falta hasta el próximo inicio de sesión), así que se entra de nuevo. */
async function entrarDeNuevo(
  request: APIRequestContext,
  empresa: { email: string; password: string }
) {
  await request.post("/api/auth/logout");
  const login = await request.post("/api/auth/login", {
    data: { identificador: empresa.email, password: `${empresa.password}Nueva` },
  });
  expect(login.status(), await login.text()).toBe(200);
}

test("con solo el módulo Mantenimiento, el ecosistema abre y lista sus equipos", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "mant");
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
  const entrada = page.getByRole("button", { name: /Gestión de mantenimiento/ });
  await entrarPorPrimeraVez(page, empresa, menu.or(entrada).first());

  // Con un solo módulo la app puede abrir directo dentro del ecosistema o dejar la entrada en el menú del ERP.
  if (!(await menu.isVisible())) {
    await entrada.click();
    await page.getByRole("button", { name: "Centro de mantenimiento" }).click();
  }
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("heading", { name: /^(Buenos días|Buenas tardes|Buenas noches)$/, level: 1 })
  ).toBeVisible();
  await expect(page).toHaveURL(/\/mantenimiento$/);

  // Equipos: vacío, con su propia dirección.
  await menu.getByRole("button", { name: "Equipos" }).click();
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();
  await expect(page.getByText("Todavía no hay equipos registrados.")).toBeVisible();
  await expect(page).toHaveURL(/\/mantenimiento\/equipos$/);

  // Entrar de nuevo y abrir la dirección de Equipos directamente (lo que hace F5 o un enlace guardado).
  await entrarDeNuevo(page.request, empresa);
  await page.goto("/mantenimiento/equipos");
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page).toHaveURL(/\/mantenimiento\/equipos$/);

  // Sin equipos, el Centro invita a registrarlos y lleva a Equipos.
  await menu.getByRole("button", { name: "Centro de mantenimiento" }).click();
  await expect(page.getByRole("heading", { name: "Todavía no hay equipos" })).toBeVisible();
  await page.getByRole("button", { name: "Ir a Equipos" }).click();
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();

  // No aparece ningún otro módulo del ERP.
  await expect(page.getByRole("button", { name: "Combustible", exact: true })).toHaveCount(0);

  // Sin otro módulo no hay un ERP al que volver: la app no ofrece un botón que no lleva a ningún lado.
  await expect(menu.getByRole("button", { name: /Volver al ERP/ })).toHaveCount(0);
});

test("una empresa sin el módulo no ve la entrada ni entra escribiendo la dirección", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const empresa = await crearEmpresaSola(request, "proveedores", "sinmant");
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
  const menuProveedores = page.getByRole("complementary", {
    name: "Menú de Gestión de proveedores",
  });
  // Una empresa con un solo módulo que es un ecosistema aterriza directo dentro de él.
  await entrarPorPrimeraVez(page, empresa, menuProveedores);
  await expect(page.getByRole("button", { name: /Gestión de mantenimiento/ })).toHaveCount(0);

  // Escribir la dirección de Mantenimiento no le abre nada: se queda en lo que sí tiene.
  await entrarDeNuevo(page.request, empresa);
  await page.goto("/mantenimiento/equipos");
  await expect(menuProveedores).toBeVisible({ timeout: 20_000 });
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toHaveCount(0);
});
