/** e2e/combustible-comprobante.spec.ts
 *
 * La compra en ruta ya no pide serie/vale: pide el comprobante del proveedor y
 * permite adjuntar su foto (0109). Además calcula sola las horas abastecidas a
 * partir de la carga anterior de la unidad, y permite reemplazar la foto con
 * motivo.
 *
 * Qué prueba y por qué en un navegador real: los tests de servidor ya cubren
 * la API. Lo que solo se ve acá es la cadena completa del formulario -- que NO
 * aparezcan serie/vale, que el <input type=file> adjunte, que la foto viaje
 * DESPUÉS del registro apuntando a la compra por su uuid, que lo calculado no
 * pise lo que el conductor escribió, y que el modal de reemplazo no deje
 * confirmar sin foto y sin motivo.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

// JPEG de 1x1 píxel: válido para el navegador y para el filtro de tipos.
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);
// Un PDF mínimo, distinto del JPEG: sirve de "foto nueva" en el reemplazo.
const PDF_MINIMO = Buffer.from("%PDF-1.4\n%reemplazo\n");

const unico = () => randomBytes(3).toString("hex").toUpperCase();

async function elegirPorTexto(page: Page, selector: string, texto: string) {
  const valor = await page
    .locator(`${selector} option`)
    .evaluateAll(
      (opciones, buscado) =>
        (opciones as HTMLOptionElement[]).find((o) => o.textContent?.includes(buscado as string))
          ?.value ?? null,
      texto
    );
  expect(valor, `no hay una opción con "${texto}" en ${selector}`).not.toBeNull();
  await page.locator(selector).selectOption(valor as string);
}

/** Una unidad con horómetro y un proveedor de ruta, creados por API: son
 *  andamiaje, no lo que se prueba. */
async function sembrar(page: Page, marca: string) {
  const equipo = await page.request.post("/api/erp/equipos", {
    data: { placa_codigo: marca, tipo: "VOLQUETE", tipo_medidor: "horometro" },
  });
  expect(equipo.status(), "no se pudo crear el equipo de prueba").toBe(201);
  const grifo = await page.request.post("/api/erp/combustible/grifos", {
    data: { nombre: `PRIMAX ${marca}` },
  });
  expect(grifo.status(), "no se pudo crear el proveedor de prueba").toBe(201);
  return {
    equipoId: (await equipo.json()).id as number,
    grifoId: (await grifo.json()).id as number,
    grifoNombre: `PRIMAX ${marca}`,
  };
}

/** Una compra ya registrada, por API. */
async function registrarCompra(
  page: Page,
  datos: { equipoId: number; grifoId: number; numero: string; horometro: number; fecha?: string }
) {
  const r = await page.request.post("/api/erp/combustible/despachos", {
    data: {
      origen: "compra_externa",
      grifo_id: datos.grifoId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: datos.equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: datos.numero,
      cantidad: 40,
      lectura_horometro: datos.horometro,
      horas_abastecidas: 10,
      costo_unitario: 17.5,
      despachado_en: datos.fecha ?? new Date(Date.now() - 3600_000).toISOString(),
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id as number;
}

/** En pantalla chica el menú lateral está plegado detrás de un botón; en
 *  escritorio ya está abierto. */
async function abrirMenuCombustible(page: Page) {
  const mostrar = page.getByRole("button", { name: "Mostrar menú" });
  if (await mostrar.isVisible()) await mostrar.click();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
}

async function abrirFormularioCompraExterna(page: Page) {
  // `exact` en el nombre completo: "Combustible" a secas también matchea la
  // campanita de "Alertas de combustible", que viene antes en el DOM. El click
  // navega al panel de Tanques, donde está "Registrar despacho".
  await abrirMenuCombustible(page);
  await page.getByRole("button", { name: "Registrar despacho" }).first().click();
  await page.locator("#despacho-origen").selectOption("compra_externa");
}

/** El flujo completo de registrar una compra con su foto. Se repite en
 *  pantalla de escritorio y de celular: los conductores lo usan en el celular. */
async function flujoCompraConFoto(page: Page) {
  const marca = `CMP-${unico()}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);

  await abrirFormularioCompraExterna(page);

  // Lo central del cambio: una compra externa NO pide serie ni vale.
  await expect(page.locator("#despacho-serie")).toHaveCount(0);
  await expect(page.locator("#despacho-n-vale")).toHaveCount(0);
  await expect(page.locator("#despacho-comprobante-numero")).toBeVisible();

  await elegirPorTexto(page, "#despacho-grifo", grifoNombre);
  await elegirPorTexto(page, "#despacho-equipo-externo", marca);
  await page.locator("#despacho-cantidad-externa").fill("40");
  await page.locator("#despacho-horometro").fill("9707");
  // Primera carga de la unidad: no hay anterior, las horas se escriben a mano.
  await expect(page.getByText(/No hay una carga anterior con horómetro/)).toBeVisible();
  await page.locator("#despacho-horas-abastecidas").fill("12");
  await page.locator("#despacho-costo-unitario").fill("17.5");
  await page.locator("#despacho-comprobante-numero").fill(numero);
  await page
    .locator("#despacho-comprobante-foto")
    .setInputFiles({ name: "boleta.jpg", mimeType: "image/jpeg", buffer: JPEG_1X1 });
  await expect(page.getByText(/se enviará al registrar/)).toBeVisible();

  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(
    page.getByText(new RegExp(`Despacho registrado: la boleta ${numero}`))
  ).toBeVisible();

  // La foto viaja después del registro: esperar a que quede guardada.
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/erp/combustible/despachos");
        if (!res.ok()) return `HTTP ${res.status()}`;
        const cuerpo = await res.json();
        const filas = Array.isArray(cuerpo) ? cuerpo : (cuerpo.data ?? cuerpo.despachos ?? []);
        const fila = filas.find(
          (d: { comprobante_numero: string }) => d.comprobante_numero === numero
        );
        return fila?.comprobante_nombre ?? null;
      },
      { message: "la foto del comprobante no quedó guardada" }
    )
    .toMatch(/boleta.*\.jpg$/);
}

test("compra en ruta: pide comprobante (no vale), adjunta la foto y queda descargable", async ({
  page,
}) => {
  await flujoCompraConFoto(page);
});

test.describe("en pantalla de celular", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true });

  test("compra en ruta: el mismo flujo con la foto, en 393x852", async ({ page }) => {
    await flujoCompraConFoto(page);
  });
});

test("horas abastecidas: se calculan solas desde la carga anterior y lo escrito a mano manda", async ({
  page,
}) => {
  const marca = `HRS-${unico()}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { equipoId, grifoId, grifoNombre } = await sembrar(page, marca);
  await registrarCompra(page, { equipoId, grifoId, numero: `B001-${unico()}`, horometro: 1000 });

  await abrirFormularioCompraExterna(page);
  await elegirPorTexto(page, "#despacho-grifo", grifoNombre);
  await elegirPorTexto(page, "#despacho-equipo-externo", marca);

  const horas = page.locator("#despacho-horas-abastecidas");
  const horometro = page.locator("#despacho-horometro");

  await horometro.fill("1012.5");
  await expect(horas).toHaveValue("12.5");
  await expect(page.getByText(/Carga anterior: 1\.?,?000 h/)).toBeVisible();

  // Lo escrito a mano manda: cambiar la lectura NO pisa lo que el conductor puso.
  await horas.fill("99");
  await horometro.fill("1020");
  await expect(horas).toHaveValue("99");

  // Vaciarlo devuelve el campo al cálculo.
  await horas.fill("");
  await expect(horas).toHaveValue("20");

  // Una lectura menor que la anterior no inventa horas negativas: avisa y deja a mano.
  await horometro.fill("900");
  await expect(horas).toHaveValue("");
  await expect(page.getByText(/La lectura es menor que la de la carga anterior/)).toBeVisible();
});

test("horas abastecidas: una unidad sin carga anterior queda a mano, sin inventar nada", async ({
  page,
}) => {
  const marca = `NEW-${unico()}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);

  await abrirFormularioCompraExterna(page);
  await elegirPorTexto(page, "#despacho-grifo", grifoNombre);
  await elegirPorTexto(page, "#despacho-equipo-externo", marca);
  await page.locator("#despacho-horometro").fill("500");

  await expect(page.getByText(/No hay una carga anterior con horómetro/)).toBeVisible();
  await expect(page.locator("#despacho-horas-abastecidas")).toHaveValue("");
});

test("reemplazar el comprobante: no deja confirmar sin foto y sin motivo, y deja la nueva", async ({
  page,
}) => {
  const marca = `RPL-${unico()}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { equipoId, grifoId } = await sembrar(page, marca);
  const despachoId = await registrarCompra(page, { equipoId, grifoId, numero, horometro: 100 });

  const subida = await page.request.post(
    `/api/erp/combustible/despachos/${despachoId}/comprobante`,
    {
      multipart: { archivo: { name: "vieja.jpg", mimeType: "image/jpeg", buffer: JPEG_1X1 } },
    }
  );
  expect(subida.status(), await subida.text()).toBe(201);

  await abrirMenuCombustible(page);
  await page.getByRole("button", { name: "Historial de compras" }).click();

  const fila = page.getByRole("row").filter({ hasText: numero });
  await expect(fila).toBeVisible();
  await fila.getByRole("button", { name: "Reemplazar", exact: true }).click();

  const confirmar = page.getByRole("button", { name: "Reemplazar comprobante" });
  await expect(confirmar).toBeDisabled();

  await page
    .locator("#reemplazo-comprobante-foto")
    .setInputFiles({ name: "nueva.pdf", mimeType: "application/pdf", buffer: PDF_MINIMO });
  // Con la foto pero sin motivo, tampoco.
  await expect(confirmar).toBeDisabled();

  await page.locator("#motivo-reemplazo-comprobante").fill("la foto anterior estaba borrosa");
  await expect(confirmar).toBeEnabled();
  await confirmar.click();

  await expect(page.getByText(/Comprobante reemplazado/)).toBeVisible();

  const bajada = await page.request.get(`/api/erp/combustible/despachos/${despachoId}/comprobante`);
  expect(bajada.status()).toBe(200);
  expect(Buffer.compare(await bajada.body(), PDF_MINIMO)).toBe(0);
});
