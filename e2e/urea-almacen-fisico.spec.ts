/** e2e/urea-almacen-fisico.spec.ts
 *
 * El almacén de urea EN FÍSICO: cada envase con sus unidades contadas, sin
 * equivalencias ("102 bolsas" sacadas de dividir 408 L por 4), y los litros de
 * un envase con movimientos fijos.
 *
 * Por qué en un navegador real: la API ya está cubierta en
 * tests/combustible-urea-stock y -presentaciones. Lo que solo se ve acá es que
 * la tarjeta muestre las unidades registradas, que el clic cambie el envase
 * grande, que la ventana ampliada traiga los movimientos de ESE envase, y que
 * la configuración no ofrezca cambiar los litros de un envase usado.
 *
 * El tenant e2e es compartido: el envase es propio de esta corrida y al final
 * se anula la entrada y se desactiva, para no dejar stock suelto.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("el almacén muestra los envases contados, sin equivalencias, y fija los litros usados", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex");
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // Un proveedor de urea y un envase propio de esta corrida.
  const proveedor = await page.request.post("/api/erp/combustible/grifos", {
    data: {
      nombre: `UREA E2E ${marca}`,
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
    },
  });
  expect(proveedor.status(), "no se pudo crear el proveedor de urea").toBe(201);
  const codigo = `saco${marca}`;
  const envase = await page.request.post("/api/erp/combustible/urea/presentaciones", {
    data: { codigo, nombre: "Saco", litros: 20, es_referencia: false },
  });
  expect(envase.status(), "no se pudo dar de alta el envase").toBe(201);
  const envaseId = (await envase.json()).id as number;

  const entrada = await page.request.post("/api/erp/combustible/recepciones", {
    data: {
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: (await proveedor.json()).id,
      presentacion: codigo,
      cantidad_bultos: 3,
      costo_unitario: 20,
      recibido_en: new Date().toISOString(),
    },
  });
  expect(entrada.status(), "no se pudo registrar la entrada").toBe(201);
  const entradaId = (await entrada.json()).id as number;

  try {
    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await page.getByRole("button", { name: /^Urea$/ }).click();

    const almacen = page.getByRole("region", { name: "Almacén de urea" });
    await expect(almacen).toBeVisible();

    // Sin velocímetro ni equivalencias.
    await expect(almacen.getByRole("button", { name: "Tablero" })).toHaveCount(0);
    await expect(almacen).not.toContainText("≈");

    // El envase de esta corrida (puede haber otros sacos de corridas viejas
    // con saldo 0; el nuestro es el que tiene 3).
    await almacen
      .getByRole("button", { name: /Sacos de 20 L\s*3 sacos/ })
      .first()
      .click();
    await expect(almacen.getByRole("img", { name: "3 sacos en la estantería" })).toBeVisible();

    // La ventana ampliada trae los movimientos de ESTE envase.
    await almacen.getByRole("button", { name: "Ampliar" }).click();
    await expect(page.getByText("Movimientos de este envase · últimos 30 días")).toBeVisible();
    await expect(page.getByRole("cell", { name: "+3" }).first()).toBeVisible();
    await page
      .getByRole("dialog", { name: "Sacos de 20 L" })
      .getByRole("button", { name: "Cerrar" })
      .click();
  } finally {
    // Limpieza: sin stock suelto en el tenant compartido.
    const anular = await page.request.patch(
      `/api/erp/combustible/recepciones/${entradaId}/anular`,
      { data: { motivo: "limpieza de la spec e2e" } }
    );
    expect(anular.status()).toBe(200);
  }

  // Con la entrada anulada el envase sigue teniendo un movimiento: sus litros
  // son fijos y la configuración lo dice en vez de ofrecer el cambio.
  await page.getByRole("button", { name: "Envases", exact: true }).click();
  await page
    .getByRole("row", { name: new RegExp(codigo) })
    .getByRole("button", { name: "Editar" })
    .click();
  await expect(page.getByLabel("Litros por bulto")).toBeDisabled();
  await expect(page.getByText(/Fijo: este envase ya tiene/)).toBeVisible();

  const baja = await page.request.put(`/api/erp/combustible/urea/presentaciones/${envaseId}`, {
    data: {
      nombre: "Saco",
      litros: 20,
      es_referencia: false,
      activa: false,
      motivo: "limpieza de la spec e2e",
    },
  });
  expect(baja.status()).toBe(200);
});
