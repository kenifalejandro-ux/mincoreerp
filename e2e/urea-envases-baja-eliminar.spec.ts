/** e2e/urea-envases-baja-eliminar.spec.ts
 *
 * Envases de urea: dejaron Configuración y ahora tienen su botón en
 * Herramientas, con tres acciones por fila según lo que el envase ya vivió:
 *
 *   - nunca se usó, no es el principal  → Eliminar
 *   - ya tiene historial, no es principal → Dar de baja (y Reactivar)
 *   - es el principal                    → ninguna de las dos
 *
 * La API (siete tablas que lo usan, carreras, permisos, aislamiento) está en
 * tests/combustible-urea-presentaciones-eliminar. Lo que solo se ve en un
 * navegador: que cada fila ofrezca la acción que corresponde, que el motivo
 * sea obligatorio, que el 409 del servidor se lea tal cual en pantalla y que
 * Configuración ya no tenga la pestaña Envases.
 *
 * El tenant e2e es compartido: los envases son propios de esta corrida
 * (código con marca) y al final no queda stock suelto ni envases activos.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const API = "/api/erp/combustible/urea/presentaciones";

async function abrirEnvases(page: Page) {
  await page.getByRole("button", { name: "Envases", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Envases de urea" })).toBeVisible();
}

test("cada envase ofrece la acción que le corresponde: eliminar, dar de baja o reactivar", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex");
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const sinUso = `frasco${marca}`;
  const conUso = `tarro${marca}`;
  let entradaId: number | null = null;
  let conUsoId: number | null = null;
  let sinUsoId: number | null = null;

  try {
    // Un proveedor de urea y dos envases propios de esta corrida.
    const proveedor = await page.request.post("/api/erp/combustible/grifos", {
      data: {
        nombre: `UREA E2E ${marca}`,
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      },
    });
    expect(proveedor.status(), "no se pudo crear el proveedor de urea").toBe(201);

    const a = await page.request.post(API, {
      data: { codigo: sinUso, nombre: `Frasco ${marca}`, litros: 5, es_referencia: false },
    });
    expect(a.status(), "no se pudo dar de alta el envase sin uso").toBe(201);
    sinUsoId = (await a.json()).id as number;

    const b = await page.request.post(API, {
      data: { codigo: conUso, nombre: `Tarro ${marca}`, litros: 10, es_referencia: false },
    });
    expect(b.status(), "no se pudo dar de alta el envase con uso").toBe(201);
    conUsoId = (await b.json()).id as number;

    // Una unidad en el almacén: le da historial Y stock al envase con uso.
    const entrada = await page.request.post("/api/erp/combustible/recepciones", {
      data: {
        cliente_uuid: crypto.randomUUID(),
        producto: "urea",
        grifo_id: (await proveedor.json()).id,
        presentacion: conUso,
        cantidad_bultos: 1,
        costo_unitario: 20,
        recibido_en: new Date().toISOString(),
      },
    });
    expect(entrada.status(), "no se pudo registrar la entrada").toBe(201);
    entradaId = (await entrada.json()).id as number;

    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await page.getByRole("button", { name: /^Urea$/ }).click();
    await abrirEnvases(page);

    const fila = (codigo: string) => page.getByRole("row", { name: new RegExp(codigo) });

    // ── Qué ofrece cada fila ─────────────────────────────────────────────
    await expect(fila(sinUso).getByRole("button", { name: "Eliminar", exact: true })).toBeVisible();
    await expect(fila(sinUso).getByRole("button", { name: "Dar de baja" })).toHaveCount(0);

    await expect(fila(conUso).getByRole("button", { name: "Dar de baja" })).toBeVisible();
    await expect(fila(conUso).getByRole("button", { name: "Eliminar", exact: true })).toHaveCount(
      0
    );

    // El principal no se elimina ni se da de baja: primero hay que elegir otro.
    const principal = page.getByRole("row").filter({ hasText: "se abre primero" });
    await expect(principal.getByRole("button", { name: "Editar" })).toBeVisible();
    await expect(principal.getByRole("button", { name: "Dar de baja" })).toHaveCount(0);
    await expect(principal.getByRole("button", { name: "Eliminar", exact: true })).toHaveCount(0);

    // ── Eliminar el que nunca se usó: el motivo es obligatorio ───────────
    await fila(sinUso).getByRole("button", { name: "Eliminar", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: new RegExp(`Eliminar Frasco ${marca}`) })
    ).toBeVisible();
    const confirmarEliminar = page.getByRole("button", { name: "Eliminar envase" });
    await expect(confirmarEliminar).toBeDisabled();
    await page.getByPlaceholder("Se dio de alta por error").fill("lo di de alta por error");
    await expect(confirmarEliminar).toBeEnabled();
    await confirmarEliminar.click();
    await expect(fila(sinUso)).toHaveCount(0);
    sinUsoId = null;

    // ── Dar de baja con stock: el 409 del servidor se lee tal cual ────────
    await fila(conUso).getByRole("button", { name: "Dar de baja" }).click();
    const confirmarBaja = page.getByRole("button", { name: "Dar de baja" }).last();
    await expect(confirmarBaja).toBeDisabled();
    await page.getByPlaceholder("Ya no se compra este envase").fill("prueba de baja con stock");
    await confirmarBaja.click();
    await expect(page.getByText(/Quedan 1 de/)).toBeVisible();
    // La ventana de la baja sigue abierta y el envase sigue activo.
    await page.getByRole("button", { name: "Cancelar" }).click();
    await expect(fila(conUso).getByText("Activo")).toBeVisible();

    // ── Sin stock, la baja pasa; reactivar no pide motivo ────────────────
    const anular = await page.request.patch(
      `/api/erp/combustible/recepciones/${entradaId}/anular`,
      { data: { motivo: "limpieza de la spec e2e" } }
    );
    expect(anular.status()).toBe(200);
    entradaId = null;

    await fila(conUso).getByRole("button", { name: "Dar de baja" }).click();
    await page.getByPlaceholder("Ya no se compra este envase").fill("ya no se compra");
    await page.getByRole("button", { name: "Dar de baja" }).last().click();
    await expect(fila(conUso).getByText("De baja")).toBeVisible();
    // Con historial NO se ofrece eliminarlo, de baja o no.
    await expect(fila(conUso).getByRole("button", { name: "Eliminar", exact: true })).toHaveCount(
      0
    );

    await fila(conUso).getByRole("button", { name: "Reactivar" }).click();
    await expect(fila(conUso).getByText("Activo")).toBeVisible();
    await expect(fila(conUso).getByRole("button", { name: "Dar de baja" })).toBeVisible();

    // ── Configuración quedó solo con Umbrales ────────────────────────────
    await page
      .getByRole("dialog", { name: "Envases de urea" })
      .getByRole("button", { name: "Cerrar" })
      .click();
    await page.getByRole("button", { name: "Configuración", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Configuración de urea" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Envases" })).toHaveCount(0);
  } finally {
    // Limpieza: sin stock suelto, sin envases activos de esta corrida.
    if (entradaId !== null) {
      await page.request.patch(`/api/erp/combustible/recepciones/${entradaId}/anular`, {
        data: { motivo: "limpieza de la spec e2e" },
      });
    }
    if (sinUsoId !== null) {
      await page.request.delete(`${API}/${sinUsoId}`, {
        data: { motivo: "limpieza de la spec e2e" },
      });
    }
    if (conUsoId !== null) {
      await page.request.put(`${API}/${conUsoId}`, {
        data: {
          nombre: `Tarro ${marca}`,
          litros: 10,
          es_referencia: false,
          activa: false,
          motivo: "limpieza de la spec e2e",
        },
      });
    }
  }
});
