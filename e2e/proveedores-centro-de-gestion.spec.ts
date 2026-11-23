/** e2e/proveedores-centro-de-gestion.spec.ts
 *
 * El Centro de gestión del ecosistema «Gestión de proveedores», como la maqueta. Con el admin del tenant
 * sembrado y un proveedor con precios (uno por vencer y con alza de 5 % o más) y la ficha vacía:
 *
 * 1. Se ven las cuatro tarjetas, «Requieren tu atención» con el precio por vencer, el alza y las fichas
 *    incompletas, «Estado de las fichas», «Movimientos recientes» y «Proveedores por tipo».
 * 2. «Ver precios» lleva a Gestión comercial; «Ver directorio» y «Explorar directorio», al Directorio.
 * 3. «Registrar proveedor» desde el Centro abre el formulario de la maqueta y, al terminar, el total sube.
 * 4. El operador no ve «Movimientos recientes» (solo el admin) pero sí lo demás.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI, pulsarIngresar } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const dia = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const ruta = (page: Page) => new URL(page.url()).pathname;

async function entrarAlCentro(page: Page) {
  await page.getByRole("button", { name: /Gestión de proveedores/ }).click();
  await page.getByRole("button", { name: "Centro de administración" }).click();
  await expect(
    page.getByRole("heading", { name: /^(Buenos días|Buenas tardes|Buenas noches)/, level: 1 })
  ).toBeVisible({ timeout: 20_000 });
}

/** El número de «Proveedores registrados» (la tarjeta lo dice con su etiqueta). */
async function totalRegistrados(page: Page): Promise<number> {
  const tarjeta = page.getByRole("button", { name: /^Proveedores registrados/ });
  await expect(tarjeta).toBeVisible();
  const texto = (await tarjeta.innerText()).replace(/\s+/g, " ");
  return Number(/Proveedores registrados (\d+)/.exec(texto)?.[1]);
}

test("el Centro de gestión muestra lo que requiere atención, la calidad de las fichas y registra proveedores", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const nombre = `GRIFO CENTRO ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // Un proveedor de ruta con dos precios (10.00 y luego 10.80: sube 8 %); el vigente vence en 10 días.
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
  const diaHasta = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  for (const [precio, desde, hasta] of [
    [10.0, dia(-20), undefined],
    [10.8, dia(-2), diaHasta],
  ] as const) {
    const r = await page.request.post("/api/erp/combustible/precios/masivo", {
      data: {
        tipo_combustible: "diesel_b5",
        grifo_ids: [id],
        precio_unitario: precio,
        vigente_desde: desde,
        ...(hasta ? { vigente_hasta: hasta } : {}),
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }

  await entrarAlCentro(page);

  // 1. Las tarjetas y los paneles de la maqueta.
  for (const etiqueta of [
    /^Proveedores registrados/,
    /^Activos \d/,
    /^Activos sin precio vigente/,
    /^Documentos por vencer/,
  ]) {
    await expect(page.getByRole("button", { name: etiqueta })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Requieren tu atención" })).toBeVisible();
  await expect(page.getByText(/precios? vencen? en los próximos 30 días/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/precios? subi(ó|eron) 5 % o más/)).toBeVisible();
  await expect(page.getByText(/fichas? incompletas? \(menos del 80 %\)/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Estado de las fichas" })).toBeVisible();
  await expect(page.getByRole("img", { name: /% de ficha completa en promedio/ })).toBeVisible();
  await expect(page.getByText("Documentos vigentes")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proveedores por tipo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Movimientos recientes" })).toBeVisible();
  // El movimiento más reciente es el precio recién cargado, con su proveedor y cuándo.
  await expect(page.getByText(nombre).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Hace \d+ min|Ahora/).first()).toBeVisible();

  // 2. Los botones llevan a donde dicen.
  await page
    .getByRole("button", { name: /^Ver precios/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Precios negociados", level: 1 })).toBeVisible();
  expect(ruta(page)).toBe("/proveedores/precios");
  await page.getByRole("button", { name: "Centro de gestión" }).click();
  await page.getByRole("button", { name: /^Ver directorio/ }).click();
  await expect(
    page.getByRole("heading", { name: "Directorio de proveedores", level: 1 })
  ).toBeVisible();
  expect(ruta(page)).toBe("/proveedores/directorio");
  await page.getByRole("button", { name: "Centro de gestión" }).click();
  await page.getByRole("button", { name: /^Explorar directorio/ }).click();
  expect(ruta(page)).toBe("/proveedores/directorio");
  await page.getByRole("button", { name: "Centro de gestión" }).click();

  // 3. Registrar desde el Centro: el formulario de la maqueta y, al terminar, el total sube.
  // Las cifras cargan después de la pantalla: «—» y luego el número.
  await expect.poll(() => totalRegistrados(page), { timeout: 20_000 }).not.toBeNaN();
  const antes = await totalRegistrados(page);
  await page.getByRole("button", { name: "Registrar proveedor" }).click();
  const dialogo = page.getByRole("dialog", { name: "Registrar proveedor" });
  await dialogo.getByLabel("Razón social").fill(`GRIFO NUEVO ${marca}`);
  await dialogo.getByLabel("Ciudad").fill("Arequipa");
  await dialogo.getByLabel("Qué suministra").selectOption("urea");
  await dialogo.getByLabel("Abastece a").selectOption("ambos");
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  const exito = page.getByRole("dialog", { name: "Proveedor registrado" });
  await exito.getByRole("button", { name: "Continuar" }).click();
  await expect(exito).toHaveCount(0);
  await expect.poll(() => totalRegistrados(page), { timeout: 20_000 }).toBe(antes + 1);

  // 4. El operador ve el Centro pero no «Movimientos recientes» (solo el admin).
  const email = `operador-centro-${marca.toLowerCase()}@mincoreerp.test`;
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
    await pulsarIngresar(operador);
    await operador.locator("#passwordActual").fill(temporal);
    await operador.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await operador.locator("#confirmacion").fill(`${temporal}Nueva`);
    await operador.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(operador.getByRole("button", { name: "Dashboard" })).toBeVisible({
      timeout: 20_000,
    });
    await entrarAlCentro(operador);
    await expect(operador.getByRole("heading", { name: "Requieren tu atención" })).toBeVisible();
    await expect(operador.getByRole("heading", { name: "Proveedores por tipo" })).toBeVisible();
    await expect(operador.getByRole("heading", { name: "Movimientos recientes" })).toHaveCount(0);
  } finally {
    await contexto.close();
  }
});
