/** e2e/proveedores-gestion-comercial.spec.ts
 *
 * Ecosistema «Gestión de proveedores», PR4: Gestión comercial (precios de proveedores, solo lectura).
 * Con el admin del tenant sembrado (precios cargados por la API de Combustible, como hoy):
 *
 * 1. «Gestión comercial» muestra el precio vigente de un proveedor, cuánto subió frente al anterior y
 *    desde cuándo rige; un proveedor de ruta sin precio sale «Sin precio».
 * 2. Al abrir el proveedor desde la tabla se llega a su ficha, en la pestaña «Comercial», con su historia.
 * 3. Una persona con perfil Lectura no ve «Gestión comercial» en el menú.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

const dias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
/** AAAA-MM-DD de un instante en Lima (la «vigencia hasta» es un día de Lima). */
const diaDeLima = (instante: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(instante);

/** Pulsa «Ingresar» y comprueba que el formulario SÍ envió el login; si no, vuelve a pulsar (hasta 3 veces).
 *  En la base limpia del hook de pre-push se vio, de forma intermitente, un clic que no mandaba ninguna
 *  petición (en el trace: el clic se ejecuta y no hay `POST /api/auth/login`), y la prueba esperaba la
 *  pantalla de cambio de clave hasta agotar su tiempo. Esto no esconde un fallo del login: si tras tres clics
 *  no hay petición, la prueba falla con ese mensaje y no con un tiempo agotado. */
async function pulsarIngresar(pagina: Page) {
  for (let intento = 1; intento <= 3; intento++) {
    const envio = pagina
      .waitForResponse(
        (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
        { timeout: 10_000 }
      )
      .catch(() => null);
    await pagina.getByRole("button", { name: "Ingresar" }).click();
    if (await envio) return;
  }
  throw new Error("El formulario de ingreso no envió el login tras tres clics");
}

test("gestión comercial: precio vigente, variación, ficha y Lectura sin acceso", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const conPrecio = `GRIFO PRECIO ${marca}`;
  const sinPrecio = `GRIFO SIN PRECIO ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // «Sin precio» se deriva de los tipos de combustible que la empresa maneja en sus tanques (igual que
  // la pantalla Precios de Combustible): en una base limpia no hay ninguno, así que el spec siembra uno.
  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `GC-${marca}`,
      tanque_nombre: `Tanque comercial ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 1000,
      nivel_actual: 500,
      requiere_documento: false,
      grifo_interno_id: await primerGrifoActivo(page),
    },
  });
  expect(tanque.status(), await tanque.text()).toBe(201);

  // Dos proveedores de ruta; solo el primero tiene precios (10.00 y luego 10.80: sube 8 %).
  const crear = async (nombre: string) => {
    const r = await page.request.post("/api/erp/proveedores", {
      data: {
        nombre,
        ruc: "",
        abastece_tanque: false,
        abastece_ruta: true,
        abastece_urea: false,
        abastece_urea_ruta: false,
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).id as number;
  };
  const idConPrecio = await crear(conPrecio);
  await crear(sinPrecio);
  for (const [precio, desde] of [
    [10.0, dias(-20)],
    [10.8, dias(-2)],
  ] as const) {
    const r = await page.request.post("/api/erp/combustible/precios/masivo", {
      data: {
        tipo_combustible: "diesel_b5",
        grifo_ids: [idConPrecio],
        precio_unitario: precio,
        vigente_desde: desde,
        // Solo el vigente tiene fecha de fin: dentro de 10 días.
        ...(precio === 10.8 ? { vigente_hasta: diaDeLima(Date.now() + 10 * 86_400_000) } : {}),
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  // La condición de pago sale de la ficha.
  const ficha = await page.request.put(`/api/erp/proveedores/${idConPrecio}/ficha`, {
    data: { forma_pago: "credito", plazo_pago_dias: 30 },
  });
  expect(ficha.ok(), await ficha.text()).toBeTruthy();

  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de proveedores" });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByRole("button", { name: "Gestión comercial" }).click();
  await expect(page.getByRole("heading", { name: "Precios negociados", level: 1 })).toBeVisible();
  // Las cuatro tarjetas de la maqueta.
  for (const etiqueta of [
    "Precios vigentes",
    "Vencen en 30 días",
    "Alzas de 5 % o más",
    "Activos sin precio",
  ]) {
    await expect(page.getByLabel("Resumen").getByText(etiqueta, { exact: true })).toBeVisible();
  }

  // 1. Precio vigente, variación y antigüedad; el otro proveedor, sin precio.
  await page.getByPlaceholder("Buscar por proveedor o producto").fill(marca);
  const fila = page.getByRole("row", { name: new RegExp(conPrecio) });
  await expect(fila).toBeVisible({ timeout: 20_000 });
  await expect(fila).toContainText("S/ 10.80");
  await expect(fila).toContainText("por galón");
  await expect(fila).toContainText("▲ 8.0 %");
  await expect(fila).toContainText("hace 2 días");
  // Vigencia hasta (opcional): el último precio vence en 10 días; también se ve desde cuándo rige.
  await expect(fila).toContainText("vence en 10 días");
  await expect(fila).toContainText("Rige desde");
  // Condición de pago, de la ficha del proveedor; el uso, de ruta.
  await expect(fila).toContainText("Crédito 30 días");
  await expect(fila.getByText("Externo", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Resumen").getByText("Vencen en 30 días")).toBeVisible();
  // El filtro de uso: los precios de combustible son de ruta (externos), así que «Internos» no deja ninguno.
  await page.getByRole("button", { name: "Internos", exact: true }).click();
  await expect(page.getByRole("row", { name: new RegExp(conPrecio) })).toHaveCount(0);
  await page.getByRole("button", { name: "Externos", exact: true }).click();
  await expect(page.getByRole("row", { name: new RegExp(conPrecio) })).toBeVisible();
  await page.getByRole("button", { name: "Todos", exact: true }).click();
  await expect(
    page.getByRole("row", { name: new RegExp(sinPrecio) }).getByText("Sin precio", { exact: true })
  ).toBeVisible();
  // Filtro «Sin precio»: queda solo el que no tiene.
  await page.getByLabel("Estado del precio").selectOption("sin");
  await expect(page.getByRole("row", { name: new RegExp(conPrecio) })).toHaveCount(0);
  await page.getByLabel("Estado del precio").selectOption("todos");

  // 2. De la tabla a la ficha, ya en «Comercial», con su historia.
  await page.getByRole("button", { name: `Abrir ${conPrecio}` }).click();
  await expect(page.getByRole("heading", { name: new RegExp(conPrecio), level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Comercial" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("heading", { name: "Diésel B5", level: 2 })).toBeVisible();
  await page.getByText(/^Historial \(2\)/).click();
  await expect(page.getByText("S/ 10.00")).toBeVisible();
  await page.getByRole("tab", { name: "Resumen" }).click();
  await expect(page.getByRole("heading", { name: "Qué abastece" })).toBeVisible();

  // 3. Lectura no ve «Gestión comercial» (ni la pestaña «Comercial»).
  const email = `lectura-com-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Lectura ${marca}`, email, password: temporal, rol: "lectura" },
  });
  expect(alta.ok(), await alta.text()).toBeTruthy();
  const contexto = await browser.newContext();
  const lectura = await contexto.newPage();
  try {
    await lectura.goto("/");
    await lectura.getByLabel("Correo").fill(email);
    await lectura.getByLabel("Contraseña").fill(temporal);
    await pulsarIngresar(lectura);
    await lectura.locator("#passwordActual").fill(temporal);
    await lectura.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await lectura.locator("#confirmacion").fill(`${temporal}Nueva`);
    await lectura.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(lectura.getByRole("button", { name: "Dashboard" })).toBeVisible({
      timeout: 20_000,
    });
    await lectura.getByRole("button", { name: /Gestión de proveedores/ }).click();
    await lectura.getByRole("button", { name: "Centro de administración" }).click();
    const menuLectura = lectura.getByRole("complementary", {
      name: "Menú de Gestión de proveedores",
    });
    await expect(menuLectura).toBeVisible({ timeout: 15_000 });
    await expect(
      menuLectura.getByRole("button", { name: "Directorio de proveedores" })
    ).toBeVisible();
    await expect(menuLectura.getByRole("button", { name: "Gestión comercial" })).toHaveCount(0);
    await menuLectura.getByRole("button", { name: "Directorio de proveedores" }).click();
    await lectura.getByPlaceholder("Buscar por nombre, código o RUC").fill(marca);
    await lectura
      .getByRole("row", { name: new RegExp(conPrecio) })
      .getByRole("button", { name: new RegExp(conPrecio) })
      .click();
    await expect(
      lectura.getByRole("heading", { name: new RegExp(conPrecio), level: 1 })
    ).toBeVisible();
    await expect(lectura.getByRole("tab", { name: "Comercial" })).toHaveCount(0);
  } finally {
    await contexto.close();
  }
});
