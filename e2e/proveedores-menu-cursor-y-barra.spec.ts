/** e2e/proveedores-menu-cursor-y-barra.spec.ts
 *
 * Pulido del ecosistema «Gestión de proveedores»:
 *
 * 1. En el menú del ERP, «Gestión de proveedores» queda justo debajo de «Bandeja» (y esta debajo del Dashboard).
 * 2. Los botones muestran la mano (`cursor: pointer`), en el menú del ERP y dentro del ecosistema.
 * 3. El ecosistema tiene la barra de scroll lima del ERP: `<body>` lleva `barra-lima` y lo que se desplaza se
 *    marca `scrolling-activo` mientras se mueve.
 */
import { test, expect } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("el menú queda bajo Bandeja, los botones muestran la mano y el ecosistema tiene la barra lima", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // 1. Orden del menú: Dashboard, Bandeja, Gestión de proveedores.
  const botones = page.locator("aside[data-menu-lateral] nav button");
  await expect(page.getByRole("button", { name: /^Bandeja/ })).toBeVisible();
  const textos = (await botones.allInnerTexts()).map((t) => t.trim());
  const bandeja = textos.findIndex((t) => t.startsWith("Bandeja"));
  expect(bandeja).toBeGreaterThan(0);
  expect(textos[bandeja - 1]).toMatch(/^Dashboard/);
  expect(textos[bandeja + 1]).toMatch(/^Gestión de proveedores/);

  // 2. La mano en el menú del ERP.
  const entrada = page.getByRole("button", { name: /Gestión de proveedores/ });
  await expect(entrada).toHaveCSS("cursor", "pointer");
  await expect(page.getByRole("button", { name: /^Bandeja/ })).toHaveCSS("cursor", "pointer");

  // 3. Dentro del ecosistema: la mano y la barra lima.
  await entrada.click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await expect(menu.getByRole("button", { name: "Directorio de proveedores" })).toHaveCSS(
    "cursor",
    "pointer"
  );
  await expect(page.locator("body")).toHaveClass(/barra-lima/);

  // Con una ventana baja la página scrollea; mientras se mueve queda marcada para pintar la barra.
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.mouse.move(700, 300);
  await page.mouse.wheel(0, 400);
  await expect(page.locator("html")).toHaveClass(/scrolling-activo/, { timeout: 5_000 });
});
