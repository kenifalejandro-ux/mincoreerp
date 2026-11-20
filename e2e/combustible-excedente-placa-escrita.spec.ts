/** e2e/combustible-excedente-placa-escrita.spec.ts
 *
 * El excedente de una recepción a una unidad ESCRITA A MANO (migración 0195), en las dos pantallas
 * donde se elige la unidad: el reparto de la recepción ("Directo a unidades") y la salida de lo que
 * quedó en la cisterna ("A una unidad").
 *
 * Una empresa sin Flota (o sin unidades cargadas) recibe la lista de unidades VACÍA: las dos
 * pantallas pasan del selector al campo de placa. Aquí se simula esa lista vacía en el navegador
 * (el servidor sin Flota ya lo cubre `tests/combustible-excedente-placa-escrita.test.ts`); el vale
 * se registra de verdad contra el servidor, que guarda la placa escrita.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

// Sin service worker: es el que respondería la lista de unidades desde su caché y el interceptor del
// navegador (`page.route`) no la vería.
test.use({ serviceWorkers: "block" });

const irACisternas = (page: Page) => page.getByRole("button", { name: "Cisternas", exact: true });
const tarjetaDe = (page: Page, recepcionId: string) =>
  page.locator("article").filter({ hasText: `Recepción #${recepcionId} ` });

/** La empresa no tiene unidades que elegir: la lista llega vacía. */
async function sinUnidades(page: Page) {
  await page.route("**/api/erp/combustible/equipos-destino*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        pagination: { page: 1, pageSize: 200, total: 0, totalPages: 1 },
      }),
    })
  );
}

test("excedente con placa escrita: el reparto de la recepción y la salida de la cisterna piden la placa, no una unidad de la lista", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const placaA = `ZA${marca}`;
  const placaB = `ZB${marca}`;
  const serie = `P${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await sinUnidades(page);

  const grifoInternoId = await primerGrifoActivo(page);
  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `PE-${marca}`,
      tanque_nombre: `Tanque placa ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 2000,
      nivel_actual: 2000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status(), "no se pudo crear el tanque de prueba").toBe(201);
  const tanqueId = (await tanque.json()).id as number;
  const proveedor = await page.request.post("/api/erp/combustible/grifos", {
    data: { nombre: `CISTERNA ${marca}` },
  });
  expect(proveedor.status()).toBe(201);

  const recibir = async (cantidad: string) => {
    await page.getByRole("button", { name: "Recepción sin compra registrada" }).click();
    await page.locator("#recepcion-tanque").selectOption(String(tanqueId));
    await page.locator("#recepcion-grifo").selectOption({ label: `CISTERNA ${marca}` });
    await page.locator("#recepcion-cantidad").fill(cantidad);
    await page.locator("#recepcion-costo").fill("17.5");
    await page.locator("form").getByRole("button", { name: "Registrar recepción" }).click();
    await expect(page.getByText("La recepción no cabe en el tanque")).toBeVisible();
    const quitar = page.getByRole("button", { name: "Quitar línea" });
    while ((await quitar.count()) > 0) await quitar.last().click();
  };

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await irACisternas(page).click();

  // ── 1. El reparto de la recepción: «Directo a unidades» pide la placa ────
  await recibir("300");
  await page.locator("#exc-destino-0").selectOption({ label: "Directo a unidades" });
  await page.locator("#exc-cantidad-0").fill("300");
  // La unidad es un campo de texto (con su lista vacía), no un selector de unidades.
  const campoUnidad = page.locator("#exc-equipo-0");
  await expect(campoUnidad).toBeVisible();
  expect(await campoUnidad.evaluate((el) => el.tagName)).toBe("INPUT");
  const confirmar = page.getByRole("button", { name: "Registrar con este reparto" });
  await expect(confirmar).toBeDisabled();
  await campoUnidad.fill(placaA);
  await expect(confirmar).toBeEnabled();
  await confirmar.click();
  await expect(page.getByText(/Recepción registrada/)).toBeVisible();

  const pendientes = await (
    await page.request.get("/api/erp/combustible/despachos/excedentes-pendientes")
  ).json();
  const lineaA = (
    pendientes as { id: string; equipo_id: number | null; equipo: string | null }[]
  ).find((p) => p.equipo === placaA);
  expect(lineaA, "la línea del reparto no quedó con la placa escrita").toBeDefined();
  expect(lineaA?.equipo_id).toBeNull();

  // ── 2. La salida de la cisterna a una unidad: también pide la placa ──────
  await recibir("500");
  await page.locator("#exc-destino-0").selectOption({ label: "Dejar en cisterna" });
  await page.locator("#exc-cantidad-0").fill("500");
  await page.getByRole("button", { name: "Registrar con este reparto" }).click();
  await expect(page.getByText(/Recepción registrada/)).toBeVisible();

  const cisternas = await (
    await page.request.get("/api/erp/combustible/despachos/cisternas-con-saldo")
  ).json();
  const cisterna = (
    cisternas as { id: string; recepcion_id: string; tanque_codigo: string }[]
  ).find((c) => c.tanque_codigo === `PE-${marca}`);
  expect(cisterna, "la cisterna no quedó con saldo").toBeDefined();

  await tarjetaDe(page, cisterna!.recepcion_id).getByRole("button", { name: "Repartir" }).click();
  const unidad = page.locator("#cis-unidad");
  expect(await unidad.evaluate((el) => el.tagName)).toBe("INPUT");
  const registrar = page.getByRole("button", { name: "Registrar salida" });
  await page.locator("#cis-serie").fill(serie);
  await page.locator("#cis-vale").fill("1");
  await page.locator("#cis-cantidad").fill("200");
  await expect(registrar).toBeDisabled();
  await unidad.fill(placaB);
  await expect(registrar).toBeEnabled();
  await registrar.click();
  await expect(
    page.getByText(`Salida registrada: 200 gal de la cisterna a ${placaB}.`)
  ).toBeVisible();
  await expect(tarjetaDe(page, cisterna!.recepcion_id)).toContainText(placaB);

  // ── Limpieza: el tenant e2e sobrevive entre corridas ─────────────────────
  const regularizar = (lineaId: number, placa: string, cantidad: number, vale: number) =>
    page.request.post("/api/erp/combustible/despachos", {
      data: {
        origen: "excedente_recepcion",
        excedente_linea_id: lineaId,
        tipo_combustible: "diesel_b5",
        tipo_destino: "unidad_sin_alta",
        placa_sin_alta: placa,
        serie_talonario: serie,
        n_vale: vale,
        cantidad,
        costo_unitario: 1,
      },
    });
  // La línea del reparto se regulariza con la misma placa (y de otra placa no pasa).
  expect((await regularizar(Number(lineaA!.id), placaB, 300, 2)).status()).toBe(400);
  expect((await regularizar(Number(lineaA!.id), placaA, 300, 3)).status()).toBe(201);
  // Y lo que queda en la cisterna se deja a cero.
  expect((await regularizar(Number(cisterna!.id), placaB, 300, 4)).status()).toBe(201);
});
