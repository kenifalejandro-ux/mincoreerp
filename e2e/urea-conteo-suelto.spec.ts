/** e2e/urea-conteo-suelto.spec.ts
 *
 * El conteo físico con lo suelto (0132): "2 cajas + 2 L de una caja abierta",
 * cargado desde el formulario real.
 *
 * La API está cubierta en tests/combustible-urea-conteo-envase. Acá: que el
 * formulario tenga el campo del suelto, que el total en vivo lo sume, y que
 * la tabla de conteos diga qué se contó.
 *
 * El tenant e2e es compartido: al final se anula el conteo.
 */
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("el conteo suma lo suelto y la tabla dice qué se contó", async ({ page }) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const observacion = `e2e conteo ${Date.now()}`;
  let conteoId: number | null = null;

  try {
    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await page.getByRole("button", { name: /^Urea$/ }).click();
    await page.getByRole("button", { name: "Conteo físico" }).click();

    await page.getByLabel(/^Caja .*contadas$/).fill("2");
    await page.getByLabel(/^Suelto, en litros/).fill("2");
    // 2 cajas de 16 L + 2 L sueltos, antes de guardar.
    await expect(page.getByText(/Total contado:\s*34 L/)).toBeVisible();
    await page.getByLabel("Observaciones").fill(observacion);

    // Se espera la RESPUESTA (mientras guarda, el botón dice "Guardando…"), y
    // el id se toma antes de mirar la pantalla: la limpieza del finally no
    // puede depender de que pasen esas aserciones.
    const guardado = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/erp/combustible/urea/conteos") && r.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Registrar conteo" }).click();
    expect((await guardado).status()).toBe(201);
    // El cuerpo no se lee de la respuesta: pasa por el service worker de la
    // PWA y Playwright no siempre lo tiene. Se busca por la API.
    const conteos = await (
      await page.request.get("/api/erp/combustible/urea/conteos?pageSize=200")
    ).json();
    const elConteo = conteos.data.find(
      (c: { observaciones: string | null }) => c.observaciones === observacion
    );
    conteoId = Number(elConteo.id);
    expect(Number(elConteo.suelto_litros)).toBe(2);
    expect(Number(elConteo.cantidad_litros)).toBe(34);

    // La tabla de conteos (la observación también sale en el kardex de al lado).
    const fila = page
      .getByRole("row")
      .filter({ hasText: observacion })
      .filter({ hasText: "L suelto" });
    await expect(fila).toContainText(/Caja.*\+ 2 L suelto/);
    await expect(fila).toContainText("34 L");
  } finally {
    if (conteoId !== null) {
      const anulado = await page.request.patch(
        `/api/erp/combustible/urea/conteos/${conteoId}/anular`,
        {
          data: { motivo: "limpieza de la spec e2e" },
        }
      );
      expect(anulado.status()).toBe(200);
    }
  }
});
