/** e2e/proveedores-historial.spec.ts
 *
 * Ecosistema «Gestión de proveedores»: «Historial y auditoría» y el menú sin «Contactos».
 * Con el admin del tenant sembrado:
 *
 * 1. El menú ya no trae «Contactos» (los contactos son una pestaña de la ficha) y «Historial y auditoría» es
 *    una pantalla real, no un «Pronto».
 * 2. Tras registrar un proveedor, cargarle un precio y editar sus datos, el historial lo muestra con quién,
 *    qué y sobre qué proveedor; filtra por tipo y por proveedor, y «Limpiar» vuelve a todo. Nunca aparecen
 *    la dirección ni el teléfono que se guardaron.
 * 3. Un operador no ve «Historial y auditoría» en su menú.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

async function entrarAlEcosistema(page: Page) {
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  const entrada = page.getByRole("button", { name: /Gestión de proveedores/ });
  await menu.or(entrada).first().waitFor({ timeout: 20_000 });
  if (!(await menu.isVisible())) {
    await entrada.click();
    await page.getByRole("button", { name: "Centro de administración" }).click();
  }
  await expect(menu).toBeVisible({ timeout: 15_000 });
  return menu;
}

test("historial y auditoría: movimientos con quién, qué y sobre qué proveedor; el operador no lo ve", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const nombre = `GRIFO HISTORIAL ${marca}`;
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
  const precio = await page.request.post("/api/erp/proveedores/precios/combustible", {
    data: { tipo_combustible: "diesel_b5", grifo_ids: [id], precio_unitario: 15.8 },
  });
  expect(precio.ok(), await precio.text()).toBeTruthy();
  const datos = await page.request.put(`/api/erp/proveedores/${id}/ficha`, {
    data: { direccion: "Jr. Secreto 999", telefono: "064123456" },
  });
  expect(datos.ok(), await datos.text()).toBeTruthy();

  // 1. El menú: sin «Contactos», con «Historial y auditoría» real.
  const menu = await entrarAlEcosistema(page);
  await expect(menu.getByRole("button", { name: /^Contactos/ })).toHaveCount(0);
  await menu.getByRole("button", { name: "Historial y auditoría" }).click();
  await expect(
    page.getByRole("heading", { name: "Historial y auditoría", level: 1 })
  ).toBeVisible();
  await expect(page.getByText("Pronto", { exact: true })).toHaveCount(
    // Los demás «Pronto» del menú siguen ahí; la pantalla no es uno de ellos.
    await menu.getByText("Pronto", { exact: true }).count()
  );

  // 2. Lo hecho con ese proveedor, filtrado por su nombre.
  await page.getByPlaceholder("Buscar por nombre del proveedor").fill(marca);
  await page.getByRole("button", { name: "Buscar" }).click();
  const filas = page.getByRole("row").filter({ hasText: nombre });
  await expect(filas).toHaveCount(3, { timeout: 20_000 });
  await expect(filas.filter({ hasText: "Registró un proveedor" })).toHaveCount(1);
  const filaPrecio = filas.filter({ hasText: "Cargó un precio" });
  await expect(filaPrecio).toContainText("Diésel B5 · S/ 15.80 por galón");
  await expect(filaPrecio).toContainText("E2E Admin");
  const filaDatos = filas.filter({ hasText: "Editó los datos y las condiciones de pago" });
  await expect(filaDatos).toContainText("Cambió: dirección, teléfono");
  // Lo que se guardó no aparece en ningún lado de la pantalla.
  await expect(page.locator("body")).not.toContainText("Jr. Secreto 999");
  await expect(page.locator("body")).not.toContainText("064123456");

  // Filtrar por tipo deja solo los precios; «Limpiar» vuelve a todo.
  await page.getByLabel("Tipo").selectOption("precios");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(filas).toHaveCount(1, { timeout: 20_000 });
  await expect(filas).toContainText("Cargó un precio");
  await page.getByRole("button", { name: "Limpiar" }).click();
  await expect(page.getByPlaceholder("Buscar por nombre del proveedor")).toHaveValue("");
  await expect(page.getByRole("row").filter({ hasText: nombre }).first()).toBeVisible({
    timeout: 20_000,
  });
  // Sin coincidencias: lo dice.
  await page.getByPlaceholder("Buscar por nombre del proveedor").fill(`NOEXISTE${marca}`);
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByText("No hay movimientos con esos filtros.")).toBeVisible();

  // 3. Un operador no ve «Historial y auditoría».
  const email = `operador-historial-${marca.toLowerCase()}@mincoreerp.test`;
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
    await operador.getByRole("button", { name: "Ingresar" }).click();
    await operador.locator("#passwordActual").fill(temporal);
    await operador.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await operador.locator("#confirmacion").fill(`${temporal}Nueva`);
    await operador.getByRole("button", { name: "Guardar y continuar" }).click();
    const menuOperador = await entrarAlEcosistema(operador);
    await expect(
      menuOperador.getByRole("button", { name: "Directorio de proveedores" })
    ).toBeVisible();
    await expect(menuOperador.getByRole("button", { name: /Historial y auditoría/ })).toHaveCount(
      0
    );
  } finally {
    await contexto.close();
  }
});
