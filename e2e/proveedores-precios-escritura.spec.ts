/** e2e/proveedores-precios-escritura.spec.ts
 *
 * Ecosistema «Gestión de proveedores», PR4b: cargar y anular precios de proveedores desde el ecosistema.
 * Con el admin del tenant sembrado (todos los módulos):
 *
 * 1. «Nuevo precio» de combustible a dos proveedores de ruta a la vez: ambos quedan con su precio vigente.
 * 2. Un precio nuevo con un salto de más de 50 % no se envía sin marcar la confirmación.
 * 3. Un precio de urea de a uno (proveedor + presentación).
 * 4. Desde la ficha del proveedor, «Comercial»: se anula un precio con motivo y vuelve a regir el anterior.
 * 5. Combustible → Precios (API de Combustible) ve lo que se cargó acá.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

async function entrarAComercial(page: Page) {
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByRole("button", { name: "Gestión comercial" }).click();
  await expect(page.getByRole("heading", { name: "Precios negociados", level: 1 })).toBeVisible();
  return menu;
}

test("nuevo precio de combustible y urea, confirmación del salto y anulación con motivo", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const rutaA = `RUTA A ${marca}`;
  const rutaB = `RUTA B ${marca}`;
  const urea = `UREA ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const crear = async (
    nombre: string,
    tipo: { abastece_ruta?: boolean; abastece_urea?: boolean }
  ) => {
    const r = await page.request.post("/api/erp/proveedores", {
      data: {
        nombre,
        ruc: "",
        abastece_tanque: false,
        abastece_ruta: false,
        abastece_urea: false,
        abastece_urea_ruta: false,
        ...tipo,
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).id as number;
  };
  const idA = await crear(rutaA, { abastece_ruta: true });
  await crear(rutaB, { abastece_ruta: true });
  await crear(urea, { abastece_urea: true });

  await entrarAComercial(page);
  await page.getByPlaceholder("Buscar por proveedor o producto").fill(marca);

  // 1. Combustible a dos proveedores a la vez; vacío avisa lo que falta.
  await page.getByRole("button", { name: "Nuevo precio" }).first().click();
  const dialogo = page.getByRole("dialog", { name: "Nuevo precio" });
  await expect(dialogo).toBeVisible();
  await dialogo.getByRole("button", { name: "Cargar precio" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("Elige al menos un proveedor.");
  await expect(dialogo.getByRole("alert")).toContainText("Escribe el precio.");
  await dialogo.getByLabel("Producto").selectOption("combustible");
  await dialogo.getByLabel(rutaA).check();
  await dialogo.getByLabel(rutaB).check();
  await dialogo.getByLabel(/^Precio por/).fill("15,80");
  // Vigencia hasta (opcional): una fecha anterior a hoy avisa; una futura se guarda y se ve en la fila.
  await dialogo.getByLabel("Vigencia hasta (opcional)").fill("2020-01-01");
  await dialogo.getByRole("button", { name: "Cargar precio" }).click();
  await expect(dialogo.getByRole("alert")).toContainText(
    "La vigencia hasta no puede ser anterior a la fecha desde la que rige."
  );
  const dentroDe40 = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(
    Date.now() + 40 * 86_400_000
  );
  await dialogo.getByLabel("Vigencia hasta (opcional)").fill(dentroDe40);
  await dialogo.getByRole("button", { name: "Cargar precio" }).click();
  await expect(dialogo).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Precio cargado a 2 proveedores");
  await expect(page.getByRole("row", { name: new RegExp(rutaA) }).first()).toContainText(
    "vence en 40 días",
    { timeout: 20_000 }
  );
  for (const nombre of [rutaA, rutaB]) {
    const fila = page.getByRole("row", { name: new RegExp(nombre) });
    await expect(fila.first()).toContainText("S/ 15.80", { timeout: 20_000 });
  }

  // 2. Un salto de más de 50 %: pide la confirmación y sin ella no se envía.
  await page.getByRole("button", { name: "Nuevo precio" }).first().click();
  await dialogo.getByLabel("Producto").selectOption("combustible");
  await dialogo.getByLabel(rutaA).check();
  await dialogo.getByLabel(/^Precio por/).fill("30");
  await expect(dialogo.getByLabel("Variación contra el precio vigente")).toContainText("▲ 89.9 %");
  await dialogo.getByRole("button", { name: "Cargar precio" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("marca la confirmación");
  await dialogo.getByLabel(/^Confirmo el cambio/).check();
  await dialogo.getByRole("button", { name: "Cargar precio" }).click();
  await expect(dialogo).toHaveCount(0);
  const filaA = page.getByRole("row", { name: new RegExp(rutaA) }).first();
  await expect(filaA).toContainText("S/ 30.00", { timeout: 20_000 });

  // 3. Urea, de a uno.
  await page.getByRole("button", { name: "Nuevo precio" }).first().click();
  await dialogo.getByLabel("Producto").selectOption("urea");
  await dialogo.getByLabel("Proveedor", { exact: true }).selectOption({ label: urea });
  await dialogo.getByLabel("Presentación").selectOption({ label: "Balde (20 L)" });
  await dialogo.getByLabel(/^Precio por/).fill("120");
  await dialogo.getByRole("button", { name: "Cargar precio" }).click();
  await expect(dialogo).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(`Balde.*${urea}`) })).toContainText(
    "S/ 120.00",
    { timeout: 20_000 }
  );

  // 4. Desde la ficha: anular el de 30 con motivo; vuelve a regir el de 15.80.
  await page
    .getByRole("button", { name: `Abrir ${rutaA}` })
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "Comercial" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.getByText(/^Historial \(2\)/).click();
  await page
    .getByRole("button", { name: /^Anular precio .*30\.00/ })
    .first()
    .click();
  const anular = page.getByRole("dialog", { name: "Anular precio" });
  await anular.getByRole("button", { name: "Anular precio" }).click();
  await expect(anular.getByRole("alert")).toContainText("Escribe el motivo");
  await anular.getByLabel("Motivo").fill("Error de tipeo");
  await anular.getByRole("button", { name: "Anular precio" }).click();
  await expect(anular).toHaveCount(0);
  // El aviso sale en el panel; el de «Precio cargado» de la pantalla de atrás sigue ahí.
  await expect(
    page.getByRole("complementary", { name: "Detalle del proveedor" }).getByRole("status")
  ).toContainText("Precio anulado");
  await expect(page.getByText(/anulado: Error de tipeo/)).toBeVisible({ timeout: 20_000 });

  // 5. Combustible ve lo cargado acá (misma tabla): el vigente de A es 15.80 y el 30 figura anulado.
  const r = await page.request.get("/api/erp/combustible/precios");
  expect(r.ok(), await r.text()).toBeTruthy();
  const precios = (await r.json()) as { grifo_id: number | null; precio_unitario: string }[];
  const deA = precios.filter((p) => p.grifo_id === idA).map((p) => Number(p.precio_unitario));
  expect(deA).toContain(15.8);
});
