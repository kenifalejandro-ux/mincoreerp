/** e2e/proveedores-compras.spec.ts
 *
 * Ecosistema «Gestión de proveedores», PR5: Compras y recepciones (solo lectura) y la autonomía en el
 * navegador.
 *
 * 1. Con el tenant sembrado (todos los módulos): las compras de cisterna que se registran en Combustible
 *    aparecen en «Compras y recepciones» con su estado (registrada, por llegar, anulada), se filtran y de la
 *    tabla se abre la ficha del proveedor en su pestaña «Compras».
 * 2. Una empresa con SOLO el módulo Proveedores (sin Combustible) recorre el ecosistema sin errores: el
 *    ERP no le muestra Combustible, puede registrar un proveedor, y «Gestión comercial» y «Compras y
 *    recepciones» salen vacías con su aviso, sin 403 ni pantalla rota.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA, leerEnv } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

const hoy = () => new Date().toISOString().slice(0, 10);
const enDias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function entrarAlEcosistema(page: Page) {
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  return menu;
}

test("compras y recepciones: estados, filtro y ficha del proveedor", async ({ page }) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const proveedor = `GRIFO COMPRAS ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // Un proveedor de tanque y tres compras registradas como hoy, por Combustible: una registrada, una
  // por llegar (habilitada) y una anulada.
  const alta = await page.request.post("/api/erp/proveedores", {
    data: {
      nombre: proveedor,
      ruc: "",
      abastece_tanque: true,
      abastece_ruta: false,
      abastece_urea: false,
      abastece_urea_ruta: false,
    },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  const proveedorId = (await alta.json()).id as number;
  const grifoInternoId = await primerGrifoActivo(page);
  const comprar = async (documento: string) => {
    const r = await page.request.post("/api/erp/combustible/compras-cisterna", {
      data: {
        grifo_interno_id: grifoInternoId,
        grifo_id: proveedorId,
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_documento: "factura",
        numero_documento: `${documento}-${marca}`,
        fecha_compra: hoy(),
        llegada_estimada: enDias(5),
        cantidad_facturada: 1000,
        costo_unitario: 15.5,
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).id as number;
  };
  await comprar("REG");
  const porLlegar = await comprar("PLL");
  const anulada = await comprar("ANU");
  const habilitar = await page.request.patch(
    `/api/erp/combustible/compras-cisterna/${porLlegar}/habilitar`
  );
  expect(habilitar.ok(), await habilitar.text()).toBeTruthy();
  const anular = await page.request.patch(
    `/api/erp/combustible/compras-cisterna/${anulada}/anular`,
    { data: { motivo: "factura duplicada" } }
  );
  expect(anular.ok(), await anular.text()).toBeTruthy();

  const menu = await entrarAlEcosistema(page);
  await menu.getByRole("button", { name: "Compras y recepciones" }).click();
  await expect(
    page.getByRole("heading", { name: "Compras y recepciones", level: 1 })
  ).toBeVisible();

  await page.getByPlaceholder("Buscar por documento o proveedor").fill(marca);
  const filaReg = page.getByRole("row", { name: new RegExp(`REG-${marca}`) });
  await expect(filaReg).toBeVisible({ timeout: 20_000 });
  await expect(filaReg).toContainText("Registrada");
  await expect(filaReg).toContainText("S/ 15,500.00");
  await expect(filaReg).toContainText("Aún no llega");
  const filaPll = page.getByRole("row", { name: new RegExp(`PLL-${marca}`) });
  await expect(filaPll).toContainText("Por llegar");
  await expect(filaPll).toContainText("Esperando la descarga");
  const filaAnu = page.getByRole("row", { name: new RegExp(`ANU-${marca}`) });
  await expect(filaAnu).toContainText("Anulada");
  await expect(filaAnu).toContainText("factura duplicada");

  // Filtro por estado.
  await page.getByLabel("Estado de la compra").selectOption("anulada");
  await expect(page.getByRole("row", { name: new RegExp(`REG-${marca}`) })).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(`ANU-${marca}`) })).toBeVisible();
  await page.getByLabel("Estado de la compra").selectOption("todos");

  // De la tabla a la ficha, ya en «Compras».
  await page
    .getByRole("button", { name: `Abrir ${proveedor}`, exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: new RegExp(proveedor), level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Compras" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("row", { name: new RegExp(`PLL-${marca}`) })).toBeVisible();
  await page.getByRole("tab", { name: "Resumen" }).click();
  await expect(page.getByRole("heading", { name: "Qué abastece" })).toBeVisible();
});

test("una empresa solo con Proveedores recorre el ecosistema sin Combustible", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toLowerCase();
  const BEARER = { Authorization: `Bearer ${leerEnv("PLATFORM_ADMIN_TOKEN")}` };
  const password = `Solo!${marca}2026`;
  const email = `solo-prov-${marca}@mincoreerp.test`;

  const creada = await request.post("/api/platform/tenants", {
    headers: BEARER,
    data: {
      tenantNombre: `Solo Proveedores ${marca}`,
      tenantSlug: `solo-prov-${marca}`,
      adminNombre: "Admin Solo Proveedores",
      adminEmail: email,
      adminPassword: password,
    },
  });
  expect(creada.ok(), await creada.text()).toBeTruthy();
  const tenantId = (await creada.json()).tenant.id as string;
  try {
    // Solo Proveedores: el resto de los módulos, apagado.
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

    // La cuenta nueva entra con la clave que le dio la plataforma (cambio obligatorio la primera vez).
    await page.goto("/");
    await page.getByLabel("Correo").fill(email);
    await page.getByLabel("Contraseña").fill(password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    // Tras ingresar sale una de dos pantallas: la del cambio de clave (primera vez) o la de trabajo.
    const cambio = page.locator("#passwordActual");
    const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
    await cambio.or(menu).first().waitFor({ timeout: 20_000 });
    if (await cambio.isVisible()) {
      await cambio.fill(password);
      await page.locator("#passwordNueva").fill(`${password}Nueva`);
      await page.locator("#confirmacion").fill(`${password}Nueva`);
      await page.getByRole("button", { name: "Guardar y continuar" }).click();
    }
    // Su único módulo es el ecosistema: entra directo a él (no hay un ERP con menú de otros módulos) y
    // no se le ofrece un «Volver al ERP» que no lleva a ningún lado.
    await expect(menu).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Volver al ERP" })).toHaveCount(0);

    // Registra un proveedor: el trabajo esencial del módulo funciona solo.
    await menu.getByRole("button", { name: "Directorio de proveedores" }).click();
    await page.getByRole("button", { name: "Registrar proveedor" }).click();
    const dialogo = page.getByRole("dialog", { name: "Registrar proveedor" });
    await dialogo.getByLabel("Razón social").fill(`SOLO PROVEEDOR ${marca}`);
    await dialogo.getByLabel("Combustible · Externo").check();
    await dialogo.getByRole("button", { name: "Guardar" }).click();
    await expect(dialogo).toHaveCount(0);
    await expect(
      page.getByRole("row", { name: new RegExp(`SOLO PROVEEDOR ${marca}`) })
    ).toBeVisible({
      timeout: 20_000,
    });

    // Gestión comercial y Compras y recepciones: vacías, con su aviso y sin error.
    await menu.getByRole("button", { name: "Gestión comercial" }).click();
    await expect(
      page.getByRole("heading", { name: "Precios de proveedores", level: 1 })
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/Se cargan en Combustible → Precios/)).toBeVisible({
      timeout: 15_000,
    });
    await menu.getByRole("button", { name: "Compras y recepciones" }).click();
    await expect(
      page.getByRole("heading", { name: "Compras y recepciones", level: 1 })
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/Todavía no hay compras de cisterna/)).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    // No hay API para borrar empresas: la de este test queda en la base de los e2e, que es efímera en CI.
  }
});
