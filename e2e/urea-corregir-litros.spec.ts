/** e2e/urea-corregir-litros.spec.ts
 *
 * Corregir los litros de un envase con historial (0130), en un navegador
 * real: el encargado con el check abre la ventana desde el detalle del
 * envase, ve el impacto ANTES de aplicar, escribe el motivo y aplica.
 *
 * La lógica (costos, conteos, registro) está cubierta en
 * tests/combustible-urea-corregir-litros. Acá: que la ventana aparezca solo
 * con el check, que la vista previa muestre el cambio real y que al aplicar
 * la pantalla quede con los litros nuevos.
 *
 * El tenant e2e es compartido: el envase es propio de esta corrida y al final
 * se anula la entrada y se desactiva.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

async function entrarConClaveTemporal(page: Page, email: string, temporal: string) {
  await page.goto("/");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(temporal);
  await page.getByRole("button", { name: "Ingresar" }).click();
  // Un usuario nuevo nace con clave temporal: la cambia antes de entrar.
  await page.locator("#passwordActual").fill(temporal);
  await page.locator("#passwordNueva").fill(`${temporal}Nueva`);
  await page.locator("#confirmacion").fill(`${temporal}Nueva`);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
}

// En cuarentena (@inestable, ver playwright.config.ts): la limpieza del final
// (anular la recepción) a veces se cuelga hasta el timeout en el CI, también
// en main, sin que cambie el código; los reintentos chocan después con lo que
// quedó sin limpiar. Causa sin confirmar. Se quita el tag cuando se arregle.
test("el encargado con el check corrige los litros de un envase viendo el impacto antes @inestable", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex");
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const proveedor = await page.request.post("/api/erp/combustible/grifos", {
    data: {
      nombre: `UREA CORR E2E ${marca}`,
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
    },
  });
  expect(proveedor.status()).toBe(201);
  const codigo = `saco${marca}`;
  const envase = await page.request.post("/api/erp/combustible/urea/presentaciones", {
    data: { codigo, nombre: "Saco", litros: 16, es_referencia: false },
  });
  expect(envase.status()).toBe(201);
  const envaseId = (await envase.json()).id as number;
  const entrada = await page.request.post("/api/erp/combustible/recepciones", {
    data: {
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: (await proveedor.json()).id,
      presentacion: codigo,
      cantidad_bultos: 5,
      costo_unitario: 32,
      recibido_en: new Date().toISOString(),
    },
  });
  expect(entrada.status()).toBe(201);
  const entradaId = (await entrada.json()).id as number;

  // El encargado: operador con el check de corregir litros.
  const email = `encargado-${marca}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Encargado ${marca}`, email, password: temporal, rol: "operador" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  const usuarioId = (await alta.json()).id as string;
  const actuales = await (await page.request.get(`/api/erp/usuarios/${usuarioId}/permisos`)).json();
  const habilitar = await page.request.put(`/api/erp/usuarios/${usuarioId}/permisos`, {
    data: {
      modulos: actuales.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: m.asignado,
        nivel: m.nivel,
      })),
      pestanas: [{ modulo: "combustible", pestana: "urea:corregir_litros", permitido: true }],
      motivo: "spec e2e: encargado de urea",
    },
  });
  expect(habilitar.status(), await habilitar.text()).toBe(200);

  const contexto = await browser.newContext();
  const encargado = await contexto.newPage();
  try {
    await entrarConClaveTemporal(encargado, email, temporal);
    await encargado.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await encargado.getByRole("button", { name: /^Urea$/ }).click();

    const almacen = encargado.getByRole("region", { name: "Almacén de urea" });
    await almacen.getByRole("button", { name: /Sacos de 16 L\s*5 sacos/ }).click();
    await almacen.getByRole("button", { name: "Ampliar" }).click();
    await encargado.getByRole("button", { name: "Corregir litros de este envase" }).click();

    const ventana = encargado.getByRole("dialog", { name: "Corregir litros de Saco" });
    await ventana.getByLabel("Litros reales por bulto").fill("20");
    await ventana.getByRole("button", { name: "Ver impacto" }).click();
    // 5 sacos: 80 L → 100 L. Todavía no se escribió nada.
    await expect(ventana.getByText(/5 sacos:\s*80 L → 100 L/)).toBeVisible();
    const sinTocar = await (await page.request.get("/api/erp/combustible/urea/estado")).json();
    expect(sinTocar.stock.envases.find((e: { codigo: string }) => e.codigo === codigo).litros).toBe(
      80
    );

    await ventana.getByLabel("Motivo").fill("spec e2e: los sacos son de 20 L");
    await ventana.getByRole("button", { name: "Aplicar corrección" }).click();
    await expect(ventana).toHaveCount(0);

    const despues = await (await page.request.get("/api/erp/combustible/urea/estado")).json();
    expect(
      despues.stock.envases.find((e: { codigo: string }) => e.codigo === codigo)
    ).toMatchObject({ unidades: 5, litros: 100, litrosPorBulto: 20 });
  } finally {
    await contexto.close();
    const anular = await page.request.patch(
      `/api/erp/combustible/recepciones/${entradaId}/anular`,
      { data: { motivo: "limpieza de la spec e2e" } }
    );
    expect(anular.status()).toBe(200);
    // El envase quedó en 20 L si la corrección se aplicó, en 16 si no.
    const catalogo = await (
      await page.request.get("/api/erp/combustible/urea/presentaciones")
    ).json();
    const litrosActuales = Number(catalogo.find((p: { id: number }) => p.id === envaseId).litros);
    const baja = await page.request.put(`/api/erp/combustible/urea/presentaciones/${envaseId}`, {
      data: {
        nombre: "Saco",
        litros: litrosActuales,
        es_referencia: false,
        activa: false,
        motivo: "limpieza de la spec e2e",
      },
    });
    expect(baja.status()).toBe(200);
  }
});
