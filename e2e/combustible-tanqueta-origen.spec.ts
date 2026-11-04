/** e2e/combustible-tanqueta-origen.spec.ts
 *
 * La tarjeta de la tanqueta dice de dónde entró lo que tiene: lo que salió de un tanque y lo que
 * vino de la cisterna del proveedor (que nunca pasó por un tanque). Las sumas las cubre el test
 * de servidor; acá se ve que la tarjeta lo diga con esas palabras y no con las de antes
 * ("excedente", "previsión").
 */
import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("tanqueta: la tarjeta separa lo que salió del tanque de lo que vino de la cisterna", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const crear = async (ruta: string, data: object) => {
    const r = await page.request.post(ruta, { data });
    expect(r.status(), `${ruta}: ${await r.text()}`).toBe(201);
    return (await r.json()) as Record<string, unknown>;
  };
  const tanqueDe = (codigo: string, capacidad: number, nivel: number) =>
    crear("/api/erp/combustible", {
      codigo,
      tanque_nombre: `Tanque ${codigo}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: grifoInternoId,
    });

  const tanqueta = await crear("/api/erp/combustible/tanquetas", {
    grifo_interno_id: grifoInternoId,
    codigo: `TO-${marca}`,
  });

  // 130 gal del tanque (reserva en cubeta).
  const conNivel = await tanqueDe(`TN-${marca}`, 10000, 8000);
  await crear("/api/erp/combustible/despachos", {
    origen: "tanque_propio",
    combustible_id: conNivel.id,
    tipo_combustible: "diesel_b5",
    tipo_destino: "reserva_cubeta",
    tanqueta_destino_id: Number(tanqueta.id),
    serie_talonario: `O${marca}`,
    n_vale: 1,
    cantidad: 130,
    lectura_contometro: 130,
    costo_unitario: 16,
  });

  // 70 gal de la cisterna: tanque lleno, todo lo recibido queda en la cisterna.
  const lleno = await tanqueDe(`TL-${marca}`, 2000, 2000);
  const proveedor = await crear("/api/erp/combustible/grifos", { nombre: `PROV ${marca}` });
  const rec = await crear("/api/erp/combustible/recepciones", {
    combustible_id: lleno.id,
    grifo_id: proveedor.id,
    cantidad: 500,
    costo_unitario: 17.5,
    recibido_en: new Date().toISOString(),
    reparto_excedente: [{ destino: "cisterna", cantidad: 500 }],
  });
  const lista = (await (
    await page.request.get("/api/erp/combustible/despachos/cisternas?estado=saldo")
  ).json()) as { id: string; recepcion_id: string }[];
  const linea = lista.find((c) => Number(c.recepcion_id) === Number(rec.id));
  expect(linea, "la cisterna no quedó con saldo").toBeDefined();
  await crear("/api/erp/combustible/despachos", {
    origen: "excedente_recepcion",
    excedente_linea_id: Number(linea!.id),
    tipo_combustible: "diesel_b5",
    tipo_destino: "reserva_cubeta",
    tanqueta_destino_id: Number(tanqueta.id),
    cantidad: 70,
    costo_unitario: 1,
    cliente_uuid: randomUUID(),
  });

  await page.reload();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Tanquetas", exact: true }).click();

  // La tarjeta de ESTA tanqueta: el elemento más interno que tiene su código y la línea "Entró".
  const tarjeta = page
    .locator("div")
    .filter({ hasText: `TO-${marca}` })
    .filter({ hasText: "Entró:" })
    .last();
  await expect(tarjeta).toContainText(/Entró: 130 del tanque · 70 de la cisterna/);
  await expect(tarjeta).not.toContainText("de excedente");
  await expect(tarjeta).not.toContainText("de previsión");
});
