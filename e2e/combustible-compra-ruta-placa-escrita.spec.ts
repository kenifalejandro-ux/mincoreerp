/** e2e/combustible-compra-ruta-placa-escrita.spec.ts
 *
 * "Compra en ruta" a una unidad ESCRITA A MANO (migración 0196): una empresa sin Flota (o sin
 * unidades cargadas) recibe la lista de unidades VACÍA y el asistente cambia dos cosas: el primer
 * paso pide la placa en vez de un buscador, y el paso del medidor desaparece (sin unidad
 * registrada no hay medidor del que partir, y el servidor tampoco lo pide).
 *
 * Aquí se simula esa lista vacía en el navegador (el servidor sin Flota ya lo cubre
 * `tests/combustible-compra-ruta-placa-escrita.test.ts`); la compra se registra de verdad contra el
 * servidor, que guarda la placa escrita en los dos vales de la boleta.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

// Sin service worker: es el que respondería la lista de unidades desde su caché y el interceptor del
// navegador (`page.route`) no la vería.
test.use({ serviceWorkers: "block" });

const unico = () => randomBytes(3).toString("hex").toUpperCase();

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

/** Un proveedor que vende diésel Y urea en ruta, y un envase de urea: andamiaje por API. */
async function sembrar(page: Page, marca: string) {
  const grifo = await page.request.post("/api/erp/combustible/grifos", {
    data: {
      nombre: `PRIMAX ${marca}`,
      abastece_ruta: true,
      abastece_tanque: false,
      abastece_urea: true,
      abastece_urea_ruta: true,
    },
  });
  expect(grifo.status(), "no se pudo crear el proveedor de prueba").toBe(201);
  const pres = await page.request.get("/api/erp/combustible/urea/presentaciones");
  const lista = pres.ok() ? ((await pres.json()) as { activa: boolean }[]) : [];
  if (!lista.some((p) => p.activa)) {
    await page.request.post("/api/erp/combustible/urea/presentaciones", {
      data: { codigo: "caja", nombre: "Caja", litros: 20, es_referencia: true },
    });
  }
  return { grifoNombre: `PRIMAX ${marca}` };
}

const botonSiguiente = (page: Page) =>
  page.getByRole("dialog").getByRole("button", { name: "Siguiente", exact: true });

async function siguiente(page: Page) {
  await expect(botonSiguiente(page)).toBeEnabled();
  await botonSiguiente(page).click();
}

async function elegirProveedor(page: Page, nombre: string) {
  await page.locator("#compra-proveedor").click();
  await page.locator('input[aria-controls="compra-proveedor-lista"]').fill(nombre);
  const opcion = page
    .locator('#compra-proveedor-lista [role="option"]')
    .filter({ hasText: nombre });
  await expect(opcion).toHaveCount(1);
  await opcion.click();
}

test("compra en ruta con placa escrita: el asistente pide la placa, salta el medidor y la boleta queda con la placa en sus dos vales", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = unico();
  const placa = `ZC${marca}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  await sinUnidades(page);
  const { grifoNombre } = await sembrar(page, marca);

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Compra en ruta" }).click();
  await page.getByRole("button", { name: "Registrar compra", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Registrar compra en ruta" })).toBeVisible();

  // ── Paso 1: la unidad es un campo de texto, no el buscador de unidades ────
  const unidad = page.locator("#compra-unidad");
  await expect(unidad).toBeVisible();
  expect(await unidad.evaluate((el) => el.tagName)).toBe("INPUT");
  await elegirProveedor(page, grifoNombre);
  // Sin la placa no avanza.
  await expect(botonSiguiente(page)).toBeDisabled();
  await unidad.fill(placa);
  await siguiente(page);

  // ── Qué compró: las dos ───────────────────────────────────────────────────
  await page.getByRole("dialog").getByRole("button", { name: "Las dos", exact: true }).click();
  await siguiente(page);

  // ── Combustible: 40 gal × S/ 17.50 ────────────────────────────────────────
  await page.locator("#compra-galones").fill("40");
  await page.locator("#compra-costo-unitario").fill("17.5");
  await siguiente(page);

  // ── El paso del medidor NO está: sigue la urea ───────────────────────────
  await expect(page.locator("#compra-medidor")).toHaveCount(0);
  await expect(page.locator("#compra-horas")).toHaveCount(0);
  const urea = page.locator("section", { hasText: "Qué se compró" });
  await urea.locator('input[type="number"]').nth(0).fill("2");
  await urea.locator('input[type="number"]').nth(1).fill("50");
  await siguiente(page);

  // ── Comprobante y resumen ─────────────────────────────────────────────────
  await page.locator("#compra-comprobante-tipo").selectOption("boleta");
  await page.locator("#compra-comprobante-numero").fill(numero);
  await siguiente(page);
  await expect(page.getByText("Resumen de tu compra")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(placa);
  await expect(page.locator("#compra-total-boleta")).toHaveText("S/ 800.00");

  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Registrar compra|Guardando/ })
    .click();
  await expect(
    page.getByText(new RegExp(`Tu compra se registró con éxito \\(la boleta ${numero}\\)`))
  ).toBeVisible({ timeout: 30_000 });

  // Los dos vales de la boleta quedaron con la placa escrita y sin medidor.
  for (const producto of ["combustible", "urea"]) {
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            `/api/erp/combustible/despachos?pageSize=200&producto=${producto}`
          );
          const cuerpo = res.ok() ? await res.json() : {};
          const filas = (Array.isArray(cuerpo) ? cuerpo : (cuerpo.data ?? [])) as {
            comprobante_numero: string | null;
            placa_sin_alta: string | null;
            equipo_id: number | null;
            lectura_horometro: string | null;
          }[];
          const f = filas.find((x) => x.comprobante_numero === numero);
          return f ? [f.placa_sin_alta, f.equipo_id, f.lectura_horometro] : null;
        },
        { message: `el vale de ${producto} no quedó con la placa escrita` }
      )
      .toEqual([placa, null, null]);
  }
});
