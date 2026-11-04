/** e2e/combustible-cisterna-tarjeta.spec.ts
 *
 * La tarjeta de la cisterna cuenta la historia de la recepción: cuánto dejó el proveedor, cuánto
 * entró al tanque, adónde fue el sobrante y el kardex de lo que quedó en la cisterna con su saldo.
 * Las cifras las cubre el test de servidor y los textos el de lógica; acá se ve en un navegador que
 * la tarjeta las diga, que el cilindro lleve su escala y que en un celular no se desborde.
 *
 * El tenant e2e sobrevive entre corridas: la tarjeta se busca por la recepción de ESTA corrida.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("Tarjeta: el desglose de la recepción, el kardex con saldo y la escala del cilindro", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const crear = async (ruta: string, data: object) => {
    const r = await page.request.post(ruta, { data });
    expect(r.status(), `${ruta}: ${await r.text()}`).toBe(201);
    return (await r.json()) as Record<string, unknown>;
  };

  // 500 gal de espacio: llegan 1,200, 500 entran al tanque y 700 se reparten.
  const tanque = await crear("/api/erp/combustible", {
    codigo: `CT-${marca}`,
    tanque_nombre: `Tanque tarjeta ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 2000,
    nivel_actual: 1500,
    requiere_documento: false,
    modo_excedente_recepcion: "flexible",
    grifo_interno_id: grifoInternoId,
  });
  const tanqueta = await crear("/api/erp/combustible/tanquetas", {
    grifo_interno_id: grifoInternoId,
    codigo: `TC-${marca}`,
  });
  const destino = await crear("/api/erp/combustible/tanquetas", {
    grifo_interno_id: grifoInternoId,
    codigo: `TD-${marca}`,
  });
  const proveedor = await crear("/api/erp/combustible/grifos", { nombre: `PROVT ${marca}` });
  const rec = await crear("/api/erp/combustible/recepciones", {
    combustible_id: tanque.id,
    grifo_id: proveedor.id,
    cantidad: 1200,
    costo_unitario: 17.5,
    recibido_en: new Date().toISOString(),
    reparto_excedente: [
      { destino: "cisterna", cantidad: 400 },
      { destino: "cubeta", cantidad: 200, tanqueta_id: Number(tanqueta.id) },
      { destino: "devolucion", cantidad: 100 },
    ],
  });
  const lista = (await (
    await page.request.get("/api/erp/combustible/despachos/cisternas?estado=saldo")
  ).json()) as { id: string; recepcion_id: string }[];
  const linea = lista.find((c) => Number(c.recepcion_id) === Number(rec.id));
  expect(linea, "la cisterna no quedó con saldo").toBeDefined();
  // 100 gal de la cisterna a una tanqueta: el saldo pasa de 400 a 300.
  await crear("/api/erp/combustible/despachos", {
    origen: "excedente_recepcion",
    excedente_linea_id: Number(linea!.id),
    tipo_combustible: "diesel_b5",
    tipo_destino: "reserva_cubeta",
    tanqueta_destino_id: Number(destino.id),
    cantidad: 100,
    costo_unitario: 1,
    cliente_uuid: randomUUID(),
  });

  await page.reload();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Cisternas", exact: true }).click();
  const tarjeta = page.locator("article").filter({ hasText: `Recepción #${rec.id} ` });
  await expect(tarjeta).toBeVisible();

  // ── El desglose: del total que dejó el proveedor, adónde fue cada parte ──
  const desglose = tarjeta.getByRole("region", { name: "Adónde fue lo que llegó" });
  await expect(desglose).toContainText(/1[.,]?200 gal/);
  await expect(desglose).toContainText(`Al tanque CT-${marca}`);
  await expect(desglose).toContainText(/500 gal/);
  await expect(desglose).toContainText(`A la tanqueta TC-${marca}`);
  await expect(desglose).toContainText("Devuelto al proveedor");
  await expect(desglose).toContainText("Quedó en la cisterna");
  await expect(desglose).toContainText(/400 gal/);

  // ── El kardex: la entrada y la salida, con el saldo después de cada una ──
  const kardex = tarjeta.getByRole("region", { name: "Movimientos de esta cisterna" });
  const filas = kardex.locator("tbody tr");
  await expect(filas).toHaveCount(2);
  await expect(filas.nth(0)).toContainText("Quedó al recibir");
  await expect(filas.nth(0)).toContainText("+400");
  await expect(filas.nth(1)).toContainText(`A la tanqueta TD-${marca}`);
  await expect(filas.nth(1)).toContainText("−100");
  await expect(filas.nth(1).locator("td").last()).toHaveText("300");

  // ── El cilindro lleva su escala y se lee el porcentaje (300 de 400 = 75 %) ──
  const cilindro = tarjeta.getByRole("img", { name: /^Cisterna de PROVT/ });
  for (const marcaDeEscala of ["100%", "80%", "60%", "40%", "20%"]) {
    await expect(cilindro.getByText(marcaDeEscala, { exact: true })).toBeVisible();
  }
  await expect(tarjeta).toContainText("75 %");

  // ── En un celular las dos columnas se apilan y la tarjeta cabe ──
  await page.setViewportSize({ width: 390, height: 800 });
  await tarjeta.scrollIntoViewIfNeeded();
  await expect(desglose).toBeVisible();
  const cabe = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1
  );
  expect(cabe, "la página se desborda en 390 px").toBe(true);
});
