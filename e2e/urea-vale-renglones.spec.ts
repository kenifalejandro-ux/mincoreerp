/** e2e/urea-vale-renglones.spec.ts
 *
 * Un vale del almacén con dos envases (0131): "1 caja + 2 bolsas" en un solo
 * vale del talonario, cargado desde el formulario real.
 *
 * La API está cubierta en tests/combustible-urea-renglones. Acá: que el
 * formulario deje agregar otra presentación, que muestre el total en litros
 * antes de guardar, y que al registrar cada envase baje lo suyo.
 *
 * El tenant e2e es compartido: se mide por diferencia y al final se anulan el
 * vale y la entrada.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

// En cuarentena (@inestable, ver playwright.config.ts): la limpieza del final
// (anular el vale y la entrada) se colgó en el CI igual que la de
// urea-corregir-litros, sin que cambie el código. Causa sin confirmar. Se
// quita el tag cuando se arregle.
test("un vale con 1 caja + 2 bolsas baja cada envase en lo suyo @inestable", async ({ page }) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const grifoInternoId = await primerGrifoActivo(page);
  const placa = `UR-${marca}`;
  const equipo = await page.request.post("/api/erp/equipos", {
    data: { placa_codigo: placa, tipo: "VOLQUETE", grifo_interno_id: grifoInternoId },
  });
  expect(equipo.status(), await equipo.text()).toBe(201);
  const proveedorNombre = `UREA VALE E2E ${marca}`;
  const proveedor = await page.request.post("/api/erp/combustible/grifos", {
    data: {
      nombre: proveedorNombre,
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
    },
  });
  expect(proveedor.status()).toBe(201);
  const entrada = await page.request.post("/api/erp/combustible/recepciones", {
    data: {
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: (await proveedor.json()).id,
      lineas: [
        { presentacion: "caja", cantidad_bultos: 5, costo_unitario: 90 },
        { presentacion: "bolsa", cantidad_bultos: 10, costo_unitario: 25 },
      ],
    },
  });
  expect(entrada.status(), await entrada.text()).toBe(201);
  const entradaId = (await entrada.json()).id as number;

  const unidades = async () => {
    const estado = await (await page.request.get("/api/erp/combustible/urea/estado")).json();
    const por = (codigo: string) =>
      estado.stock.envases.find((e: { codigo: string }) => e.codigo === codigo).unidades as number;
    return { caja: por("caja"), bolsa: por("bolsa") };
  };
  const antes = await unidades();
  const serie = `E2E-${marca}`;
  let valeId: number | null = null;

  try {
    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await page.getByRole("button", { name: /^Urea$/ }).click();
    await page.getByRole("button", { name: "Vale del almacén" }).click();

    await page.getByLabel("Serie del talonario").fill(serie);
    await page.getByLabel("N° de vale").fill("1");
    await page.getByLabel("Unidad").selectOption({ label: `${placa} (VOLQUETE)` });
    await page.getByLabel("Proveedor").selectOption({ label: proveedorNombre });

    await page.getByLabel("Presentación").first().selectOption("caja");
    await page.getByLabel("Cantidad").first().fill("1");
    await page.getByRole("button", { name: "Agregar otra presentación" }).click();
    await page.getByLabel("Presentación").nth(1).selectOption("bolsa");
    await page.getByLabel("Cantidad").nth(1).fill("2");
    // 1 caja de 16 L + 2 bolsas de 4 L, antes de guardar.
    await expect(page.getByText(/Total:\s*24 L/)).toBeVisible();

    // Se espera la RESPUESTA, no que desaparezca el botón: mientras guarda,
    // el botón dice "Guardando…" y el stock se leería a mitad de la
    // transacción.
    const guardado = page.waitForResponse(
      (r) => r.url().endsWith("/api/erp/combustible/despachos") && r.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Registrar vale" }).click();
    expect((await guardado).status()).toBe(201);

    const despues = await unidades();
    expect(despues.caja).toBe(antes.caja - 1);
    expect(despues.bolsa).toBe(antes.bolsa - 2);

    const vales = await (
      await page.request.get("/api/erp/combustible/despachos", {
        params: { producto: "urea", pageSize: "200" },
      })
    ).json();
    const elVale = vales.data.find((v: { serie_talonario: string }) => v.serie_talonario === serie);
    expect(elVale.renglones).toHaveLength(2);
    valeId = elVale.id;
  } finally {
    if (valeId !== null) {
      const anulado = await page.request.patch(`/api/erp/combustible/despachos/${valeId}/anular`, {
        data: { motivo: "limpieza de la spec e2e" },
      });
      expect(anulado.status()).toBe(200);
    }
    const anulada = await page.request.patch(
      `/api/erp/combustible/recepciones/${entradaId}/anular`,
      { data: { motivo: "limpieza de la spec e2e" } }
    );
    expect(anulada.status()).toBe(200);
  }
});
