/** e2e/maestro-unidades-checklists.spec.ts
 *
 * Las unidades son un maestro único: las mantiene Flota o Mantenimiento. Con una empresa que tiene
 * Mantenimiento, Checklists y Órdenes de trabajo pero NO Flota, los dos formularios ofrecen las unidades
 * que se registraron en Mantenimiento y guardan el checklist y la orden con esa unidad.
 *
 * La empresa es nueva (no hay API para borrarlas): la base de los e2e es efímera en CI.
 */
import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";
import { elegirUnidad } from "./fixtures/selectorDeUnidad";

test("sin Flota, Checklists y Órdenes de trabajo ofrecen las unidades de Mantenimiento", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const placa = `MNT-${marca}`;
  const empresa = await crearEmpresaSola(
    request,
    ["mantenimiento", "checklists", "ordenes_trabajo"],
    "maestro"
  );
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: "Checklists" }).first()
  );

  // De verdad no tiene Flota: su lista de equipos no existe para esta persona.
  expect((await page.request.get("/api/erp/equipos")).status()).toBe(403);

  // Andamiaje por API: la unidad vive en Mantenimiento, la plantilla en Checklists.
  const unidad = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: {
      placa_codigo: placa,
      tipo: "Volquete",
      medidor: "horometro",
      lectura: 10,
      propiedad: "propia",
    },
  });
  expect(unidad.status(), await unidad.text()).toBe(201);
  const unidadId = (await unidad.json()).id as number;
  const plantilla = await page.request.post("/api/erp/checklists/plantillas", {
    data: { nombre: `Pre-uso ${marca}`, items: [{ descripcion: "Frenos" }] },
  });
  expect(plantilla.status(), await plantilla.text()).toBe(201);

  // ── Checklists ───────────────────────────────────────────────────────
  // La vista ya cargó al entrar, antes de sembrar: se sale y se vuelve para que pida de nuevo sus listas
  // (recargar la página pediría otra vez la clave).
  await page.getByRole("button", { name: "Órdenes de Trabajo" }).first().click();
  await page.getByRole("button", { name: "Checklists" }).first().click();
  await page.getByRole("button", { name: "Nuevo Checklist" }).click();
  const equipo = page.getByLabel("Equipo");
  await expect(equipo).toBeVisible();
  await elegirUnidad(page, "checklist-equipo", placa);
  await page.getByLabel("Plantilla").selectOption({ label: `Pre-uso ${marca}` });
  await expect(page.getByText("Frenos")).toBeVisible();
  await page.getByRole("button", { name: /Registrar Checklist|Registrando/ }).click();
  await expect(page.getByRole("cell", { name: placa })).toBeVisible({ timeout: 20_000 });
  const checklists = await (await page.request.get("/api/erp/checklists?pageSize=100")).json();
  expect(
    (checklists.data as { equipo_id: number | null }[]).filter((c) => c.equipo_id === unidadId)
  ).toHaveLength(1);

  // ── Órdenes de trabajo ───────────────────────────────────────────────
  await page.getByRole("button", { name: "Órdenes de Trabajo" }).first().click();
  await page.getByRole("button", { name: "+ Nueva Orden de Trabajo" }).click();
  const unidadOrden = page.getByLabel(/^Equipo \(opcional\)/);
  await expect(unidadOrden).toBeVisible();
  await elegirUnidad(page, "ot-equipo", placa);
  await page.getByLabel("Título", { exact: true }).fill(`Cambiar frenos ${marca}`);
  await page.getByRole("button", { name: "Registrar Orden de Trabajo" }).click();
  await expect(page.getByRole("cell", { name: placa }).first()).toBeVisible({ timeout: 20_000 });
  const ordenes = await (await page.request.get("/api/erp/ordenes_trabajo?pageSize=100")).json();
  expect(
    (ordenes.data as { equipo_id: number | null }[]).filter((o) => o.equipo_id === unidadId)
  ).toHaveLength(1);
});
