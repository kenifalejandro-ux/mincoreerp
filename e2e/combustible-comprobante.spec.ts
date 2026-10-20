/** e2e/combustible-comprobante.spec.ts
 *
 * El historial de compras externas de Tanques (el del admin y el operador):
 * reemplazar la foto de un comprobante pide foto nueva y motivo, y deja la nueva.
 *
 * El REGISTRO de la compra ya no vive acá: se hace desde "Compra en ruta" (0135)
 * y lo cubre combustible-compra-ruta.spec.ts, con su foto y sus horas abastecidas.
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
