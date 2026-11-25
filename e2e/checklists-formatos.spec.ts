/** e2e/checklists-formatos.spec.ts
 *
 * Formatos de checklist con versiones y preguntas críticas (E5-1), con una empresa que tiene SOLO Checklists:
 * crear, llenar mientras otra persona cambia el formato (queda anotado con la versión que se tuvo delante), editar
 * con «qué cambió», chocar con otra edición, volver a una versión, desactivar y no poder borrar lo ya usado.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

const API = "/api/erp/checklists";

/** Acepta el siguiente aviso del navegador y devuelve lo que decía. */
function siguienteAviso(page: Page): Promise<string> {
  return new Promise((resolver) => {
    page.once("dialog", async (d) => {
      resolver(d.message());
      await d.accept();
    });
  });
}

test("un formato se crea, se edita por versiones, se restaura y se desactiva", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const nombre = `Volquete ${randomBytes(2).toString("hex").toUpperCase()}`;
  const empresa = await crearEmpresaSola(request, "checklists", "formatos");
  const pestania = page.getByRole("button", { name: /^Plantillas/ });
  await entrarPorPrimeraVez(page, empresa, pestania);

  // ── Crear, con una pregunta crítica ───────────────────────────────────
  await pestania.click();
  await page.getByRole("button", { name: "+ Nueva Plantilla" }).click();
  const nueva = page.getByRole("dialog", { name: "Nueva Plantilla" });
  await nueva.getByLabel("Nombre").fill(nombre);
  await nueva.getByPlaceholder("Ítem 1").fill("Frenos");
  await nueva.getByLabel("Ítem 1 es crítico").check();
  await nueva.getByRole("button", { name: "+ Agregar ítem" }).click();
  await nueva.getByPlaceholder("Ítem 2").fill("Luces");
  await nueva.getByRole("button", { name: "Crear Plantilla" }).click();
  await expect(nueva).toHaveCount(0);
  const fila = page.getByRole("row", { name: new RegExp(nombre) });
  await expect(page.getByRole("columnheader", { name: "acciones" })).toBeVisible();
  await expect(fila).toContainText("v1");
  const lista = await (await page.request.get(`${API}/plantillas?pageSize=50`)).json();
  const id = lista.data[0].id as number;

  // ── Se llena mientras el formato cambia: queda con la versión que se vio ─
  await page.getByRole("button", { name: "Checklists" }).last().click();
  await page.getByRole("button", { name: "Nuevo Checklist" }).click();
  await page.getByLabel("Plantilla").selectOption({ label: nombre });
  await expect(page.getByText("Crítica", { exact: true })).toHaveCount(1);
  const cambio = await page.request.put(`${API}/plantillas/${id}`, {
    data: {
      version_base: 1,
      cambio: "Otra persona agrega la bocina",
      nombre,
      items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Bocina" }],
    },
  });
  expect(cambio.status(), await cambio.text()).toBe(200);
  await page.getByLabel(/^Activo o lugar/).fill("Horno 4");
  await page.getByRole("button", { name: "Registrar Checklist" }).click();
  await expect(page.getByRole("cell", { name: "Horno 4" })).toBeVisible({ timeout: 20_000 });
  const llenos = await (await page.request.get(`${API}?pageSize=10`)).json();
  expect(llenos.data[0].plantilla_version).toBe(1);

  // ── Editar: pide qué cambió ───────────────────────────────────────────
  await pestania.click();
  await fila.getByRole("button", { name: "Editar" }).click();
  const editor = page.getByRole("dialog", { name: /Editar formato \(versión 2\)/ });
  await editor.getByRole("button", { name: "Guardar versión" }).click();
  await expect(editor.getByRole("alert")).toContainText("qué cambió");
  await editor.getByRole("button", { name: "+ Agregar ítem" }).click();
  await editor.getByPlaceholder("Ítem 3").fill("Extintor");
  await editor.getByLabel("Qué cambió").fill("Se agrega el extintor");
  await editor.getByRole("button", { name: "Guardar versión" }).click();
  await expect(editor).toHaveCount(0);
  // La lista se vuelve a leer: ya va en la 3.
  await expect(fila).toContainText("v3");

  // ── Chocar con otra edición: no pisa y no pierde lo escrito ───────────
  await fila.getByRole("button", { name: "Editar" }).click();
  const choque = page.getByRole("dialog", { name: /Editar formato \(versión 3\)/ });
  await expect(choque).toBeVisible();
  await page.request.put(`${API}/plantillas/${id}`, {
    data: { version_base: 3, cambio: "Cambio ajeno", nombre, items: [{ descripcion: "Frenos" }] },
  });
  await choque.getByLabel("Qué cambió").fill("Mi cambio");
  await choque.getByRole("button", { name: "Guardar versión" }).click();
  await expect(choque.getByRole("alert")).toContainText("Alguien cambió este formato");
  await expect(choque.getByLabel("Qué cambió")).toHaveValue("Mi cambio");
  await choque.getByRole("button", { name: "Cerrar" }).click();

  // ── Volver a la versión original ──────────────────────────────────────
  await fila.getByRole("button", { name: "Versiones" }).click();
  const versiones = page.getByRole("dialog", { name: "Versiones del formato" });
  await expect(versiones.getByText("Versión 4 · vigente")).toBeVisible();
  const confirmar = siguienteAviso(page);
  await versiones
    .getByRole("region", { name: "Versión 1" })
    .getByRole("button", { name: "Volver a esta versión" })
    .click();
  expect(await confirmar).toContain("versión 1");
  await expect(versiones.getByText("Versión 5 · vigente")).toBeVisible();
  await expect(versiones.getByRole("region", { name: "Versión 5" })).toContainText("Luces");
  await versiones.getByRole("button", { name: "Cerrar" }).click();
  await expect(fila).toContainText("v5");

  // ── Con checklists llenados no se borra; desactivado no se ofrece ─────
  const avisos: string[] = [];
  page.on("dialog", async (d) => {
    avisos.push(d.message());
    await d.accept();
  });
  await fila.getByRole("button", { name: "Eliminar" }).click();
  await expect.poll(() => avisos.join(" | ")).toContain("desactívalo en lugar de borrarlo");
  await fila.getByRole("button", { name: "Desactivar" }).click();
  await expect(fila).toContainText("Desactivada");
  await page.setViewportSize({ width: 393, height: 852 });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Checklists" }).last().click();
  avisos.length = 0;
  await page.getByRole("button", { name: "Nuevo Checklist" }).click();
  await expect.poll(() => avisos.length).toBe(1);
  expect(avisos[0]).toContain("Todas las plantillas están desactivadas");
  await expect(page.getByRole("button", { name: "Registrar Checklist" })).toHaveCount(0);
});
