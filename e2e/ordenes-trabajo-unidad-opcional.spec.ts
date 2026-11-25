/** e2e/ordenes-trabajo-unidad-opcional.spec.ts
 *
 * La unidad de la orden de trabajo es opcional (migración 0190): se identifica por la unidad de
 * Flota, por un texto libre («Horno 4, faja transportadora») o por las dos. Lo que se fija en la
 * pantalla, con una empresa que SÍ tiene Flota (adminA): el selector de unidad sigue ahí con su
 * opción «Sin unidad», el texto es obligatorio solo mientras no haya unidad, y una orden solo de
 * texto se guarda y se ve en el listado. (Sin Flota —que no se pida `equipos` ni aparezca el
 * selector ni el filtro— lo cubre la lógica de tests/ordenes-trabajo-autonomia.test.ts en el
 * servidor.)
 */
import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { elegirUnidad } from "./fixtures/selectorDeUnidad";

test("una orden solo de texto («Activo o lugar») se guarda sin unidad y se ve en el listado", async ({
  page,
}) => {
  const marca = `UNI-${randomBytes(3).toString("hex").toUpperCase()}`;
  const activo = `Horno ${marca}`;
  const titulo = `Cambiar faja ${marca}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  const equipo = await page.request.post("/api/erp/equipos", {
    data: { placa_codigo: marca, tipo: "Camioneta" },
  });
  expect(equipo.status(), "no se pudo crear el equipo de prueba").toBe(201);

  await page.getByRole("button", { name: "Órdenes de Trabajo" }).first().click();
  await page.getByRole("button", { name: "+ Nueva Orden de Trabajo" }).click();

  // La unidad es opcional y se puede dejar sin elegir.
  const unidad = page.getByLabel(/^Equipo \(opcional\)/);
  await expect(unidad).toBeVisible();
  await expect(unidad).not.toHaveAttribute("required", "");
  await expect(unidad).toContainText("Sin unidad");

  // Sin unidad, el texto es obligatorio; con unidad ya no.
  const texto = page.getByLabel(/^Activo o lugar/);
  await expect(texto).toHaveAttribute("required", "");
  await elegirUnidad(page, "ot-equipo", marca);
  await expect(texto).not.toHaveAttribute("required", "");
  await elegirUnidad(page, "ot-equipo", "Sin unidad");
  await expect(texto).toHaveAttribute("required", "");

  await texto.fill(activo);
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page.getByRole("button", { name: "Registrar Orden de Trabajo" }).click();

  // El modal se cierra y la fila aparece con el texto en la columna «equipo / activo».
  await expect(page.getByRole("columnheader", { name: "equipo / activo" })).toBeVisible();
  await expect(page.getByRole("cell", { name: activo })).toBeVisible({ timeout: 20_000 });

  // En el servidor: sin unidad y con el texto.
  const listado = await page.request.get("/api/erp/ordenes_trabajo?pageSize=100");
  const cuerpo = (await listado.json()) as {
    data: {
      titulo: string;
      equipo_id: number | null;
      placa_codigo: string | null;
      activo_texto: string | null;
    }[];
  };
  const mias = cuerpo.data.filter((o) => o.titulo === titulo);
  expect(mias).toHaveLength(1);
  expect(mias[0]).toMatchObject({ equipo_id: null, placa_codigo: null, activo_texto: activo });
});
