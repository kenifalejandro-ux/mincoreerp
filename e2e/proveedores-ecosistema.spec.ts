/** e2e/proveedores-ecosistema.spec.ts
 *
 * Ecosistema «Gestión de proveedores» (PR1, solo lectura). Lo que se fija en la pantalla, con el
 * admin del tenant sembrado (que tiene todos los módulos):
 *
 * 1. En el menú del ERP está «Gestión de proveedores» y su submenú «Centro de administración».
 * 2. Al entrar aparece la pantalla de carga y después el ecosistema, FUERA del menú del ERP: ya no hay
 *    «Dashboard» ni «Combustible», hay el menú propio del ecosistema.
 * 3. El Directorio muestra un proveedor sembrado, con su uso Interno / Externo, y se puede abrir su ficha.
 * 4. «Volver al ERP» pasa otra vez por la pantalla de carga y devuelve al menú del ERP.
 * 5. En un celular (393 px) ninguna pantalla del ecosistema ensancha la PÁGINA: las tablas se mueven por dentro,
 *    la página no (antes el Directorio medía 877 px por el «sr-only» de la columna de acciones).
 */
import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("entrar al ecosistema, ver el directorio y volver al ERP", async ({ page }) => {
  const nombre = `PROVEEDOR E2E ${randomBytes(3).toString("hex").toUpperCase()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);

  // Un proveedor propio de este test: interno de combustible, no externo.
  const alta = await page.request.post("/api/erp/combustible/grifos", {
    data: { nombre, abastece_tanque: true, abastece_ruta: false },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  // Con su ciudad en la ficha (la columna «Lugar» del directorio).
  const ficha = await page.request.put(`/api/erp/proveedores/${(await alta.json()).id}/ficha`, {
    data: { ciudad: "Huancayo" },
  });
  expect(ficha.ok(), await ficha.text()).toBeTruthy();

  // 1. La puerta está en el menú del ERP: la entrada despliega, el submenú entra.
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();

  // 2. Pantalla de carga y después el ecosistema, con su propio menú.
  await expect(page.getByTestId("pantalla-de-carga")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Gestión de proveedores", level: 2 })
  ).toBeVisible();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pantalla-de-carga")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /^(Buenos días|Buenas tardes|Buenas noches)/ })
  ).toBeVisible();
  // Ya no está el menú del ERP.
  await expect(page.getByRole("button", { name: "Dashboard" })).toHaveCount(0);

  // Lo que todavía no existe se dice «Pronto», sin pantalla de ejemplo.
  await menu.getByRole("button", { name: /Facturación y pagos/ }).click();
  await expect(page.getByRole("heading", { name: "Facturación y pagos", level: 2 })).toBeVisible();

  // 3. El directorio lista el proveedor sembrado y abre su ficha.
  await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible();
  await page.getByPlaceholder("Buscar por razón social, RUC, código o ciudad...").fill(nombre);
  const fila = page.getByRole("row", { name: new RegExp(nombre) });
  await expect(fila).toBeVisible({ timeout: 20_000 });
  await expect(fila.getByText("Interno", { exact: true })).toBeVisible();
  await expect(fila.getByText("Externo", { exact: true })).toHaveCount(0);
  // Como la maqueta: lugar, precio vigente (sin precio cargado) y qué tan completa está la ficha.
  for (const columna of ["Abastece a", "Lugar", "Precio vigente", "Ficha completa"]) {
    await expect(page.getByRole("columnheader", { name: columna })).toBeVisible();
  }
  await expect(fila.getByText("Huancayo", { exact: true })).toBeVisible();
  await expect(fila.getByText("Sin precio", { exact: true })).toBeVisible();
  await expect(fila.getByText("0 % completa")).toBeVisible();
  await expect(
    page.getByLabel("Resumen del directorio").getByText("Total registrados")
  ).toBeVisible();
  // Buscar por ciudad también encuentra al proveedor.
  await page.getByPlaceholder("Buscar por razón social, RUC, código o ciudad...").fill("huancayo");
  await expect(fila).toBeVisible();
  await page.getByPlaceholder("Buscar por razón social, RUC, código o ciudad...").fill(nombre);
  await fila.getByRole("button", { name: new RegExp(nombre) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(nombre), level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Cerrar el panel" }).click();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible();

  // 4. Volver al ERP también pasa por la pantalla de carga.
  await page.getByRole("button", { name: "Volver al ERP" }).click();
  await expect(page.getByTestId("pantalla-de-carga")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pantalla-de-carga")).toHaveCount(0);
});

test("en un celular ninguna pantalla del ecosistema ensancha la página", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 393, height: 852 });
  const nombre = `PROVEEDOR CELULAR ${randomBytes(3).toString("hex").toUpperCase()}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  // Con al menos un proveedor la tabla del Directorio tiene su columna de acciones (la que ensanchaba la página).
  const alta = await page.request.post("/api/erp/proveedores", {
    data: {
      nombre,
      ruc: "",
      abastece_tanque: true,
      abastece_ruta: false,
      abastece_urea: false,
      abastece_urea_ruta: false,
    },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  const id = (await alta.json()).id as number;

  const anchos = () =>
    page.evaluate(() => ({
      pagina: document.documentElement.scrollWidth,
      pantalla: document.documentElement.clientWidth,
    }));
  const pantallas: [string, () => Promise<void>][] = [
    [
      "/proveedores",
      async () => void (await expect(page.getByRole("heading", { level: 1 })).toBeVisible()),
    ],
    [
      "/proveedores/directorio",
      async () =>
        void (await expect(page.getByRole("row", { name: new RegExp(nombre) })).toBeVisible()),
    ],
    [
      `/proveedores/directorio/${id}`,
      async () =>
        void (await expect(
          page.getByRole("dialog", { name: "Detalle del proveedor" })
        ).toBeVisible()),
    ],
    [
      "/proveedores/precios",
      async () => void (await expect(page.getByRole("heading", { level: 1 })).toBeVisible()),
    ],
    [
      "/proveedores/compras",
      async () => void (await expect(page.getByRole("heading", { level: 1 })).toBeVisible()),
    ],
    [
      "/proveedores/historial",
      async () => void (await expect(page.getByRole("heading", { level: 1 })).toBeVisible()),
    ],
  ];
  for (const [ruta, listo] of pantallas) {
    await page.goto(ruta);
    await listo();
    await page.waitForTimeout(500);
    const { pagina, pantalla } = await anchos();
    expect(
      pagina,
      `${ruta}: la página mide ${pagina} px en una pantalla de ${pantalla}`
    ).toBeLessThanOrEqual(pantalla);
  }
});
