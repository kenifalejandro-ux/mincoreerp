/** e2e/checklists-unidad-opcional.spec.ts
 *
 * La unidad del checklist es opcional (migración 0189): se identifica por la unidad de Flota, por un
 * texto libre («Horno 4») o por las dos. Lo que se fija en la pantalla, con una empresa que SÍ tiene
 * Flota (adminA): el selector de unidad sigue ahí con su opción «Sin unidad», el texto es obligatorio
 * solo mientras no haya unidad, y un checklist solo de texto se guarda y se ve en el listado.
 * (Sin Flota —que no se pida `equipos` ni aparezca el selector— lo cubre la lógica de
 * tests/checklists-autonomia.test.ts en el servidor.)
 */
import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import {
  abrirModalNuevoChecklist,
  botonRegistrar,
  checklistsDelEquipo,
  nombrePlantilla,
  sembrarEquipoYPlantilla,
} from "./fixtures/checklists";
import { adminA } from "./fixtures/entorno";

test("un checklist solo de texto («Activo o lugar») se guarda sin unidad y se ve en el listado", async ({
  page,
}) => {
  const marca = `UNI-${randomBytes(3).toString("hex").toUpperCase()}`;
  const activo = `Horno ${marca}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  await sembrarEquipoYPlantilla(page, marca);
  await abrirModalNuevoChecklist(page);

  // La unidad es opcional y se puede dejar sin elegir.
  const unidad = page.getByLabel("Equipo");
  await expect(unidad).toBeVisible();
  await expect(unidad).not.toHaveAttribute("required", "");
  await expect(unidad.getByRole("option", { name: "Sin unidad" })).toHaveCount(1);

  // Sin unidad, el texto es obligatorio; con unidad ya no.
  const texto = page.getByLabel(/^Activo o lugar/);
  await expect(texto).toHaveAttribute("required", "");
  await unidad.selectOption({ label: marca });
  await expect(texto).not.toHaveAttribute("required", "");
  await unidad.selectOption({ value: "" });
  await expect(texto).toHaveAttribute("required", "");

  await page.getByLabel("Plantilla").selectOption({ label: nombrePlantilla(marca) });
  await expect(page.getByText("Frenos")).toBeVisible();
  await texto.fill(activo);
  await botonRegistrar(page).click();

  // El modal se cierra y la fila aparece con el texto en la columna «equipo / activo».
  await expect(page.getByRole("columnheader", { name: "equipo / activo" })).toBeVisible();
  await expect(page.getByRole("cell", { name: activo })).toBeVisible({ timeout: 20_000 });

  // En el servidor: sin unidad y con el texto.
  const listado = await page.request.get("/api/erp/checklists?pageSize=100");
  const cuerpo = (await listado.json()) as {
    data: { equipo_id: number | null; placa_codigo: string | null; activo_texto: string | null }[];
  };
  const mias = cuerpo.data.filter((c) => c.activo_texto === activo);
  expect(mias).toHaveLength(1);
  expect(mias[0]).toMatchObject({ equipo_id: null, placa_codigo: null });

  // Y no se creó ningún checklist de la unidad sembrada.
  expect(await checklistsDelEquipo(page, marca)).toHaveLength(0);
});
