/** e2e/combustible-menu-orden.spec.ts
 *
 * El submenú de Combustible sigue el flujo de la operación: primero el alta (proveedores y sus
 * precios), luego la cisterna que recibe, el tanque y la tanqueta que reparten, la urea y la
 * compra en ruta; al final lo que se consulta. Se lee el orden real del menú en el navegador.
 *
 * Las pestañas que un usuario ve dependen de sus permisos y de los módulos de la empresa: por eso
 * no se compara la lista entera, sino que las que aparezcan vengan en este orden.
 */
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const ORDEN = [
  "Proveedores",
  "Precios",
  "Cisternas",
  "Tanques",
  "Tanquetas",
  "Urea",
  "Compra en ruta",
  "Histórico",
  "Auditoría",
  "Bitácora",
];

test("el submenú de Combustible sigue el flujo: alta, recepción, reparto y consulta", async ({
  page,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();

  const submenu = page.locator('div[aria-hidden="false"] button');
  await expect(submenu.filter({ hasText: /^Cisternas$/ })).toBeVisible();
  const textos = (await submenu.allTextContents()).map((t) => t.trim());
  const vistos = textos.filter((t) => ORDEN.includes(t));

  // El admin ve al menos el alta, la cisterna, el tanque y la tanqueta.
  for (const base of ["Proveedores", "Cisternas", "Tanques", "Tanquetas"]) {
    expect(vistos, `falta ${base} en ${textos.join(" | ")}`).toContain(base);
  }
  const posiciones = vistos.map((t) => ORDEN.indexOf(t));
  expect(posiciones, `orden real: ${vistos.join(" > ")}`).toEqual(
    [...posiciones].sort((a, b) => a - b)
  );
});
