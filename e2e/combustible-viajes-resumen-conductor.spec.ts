/** e2e/combustible-viajes-resumen-conductor.spec.ts
 *
 * Viajes › Resumen por conductor: el encargado abre el resumen y ve, por conductor, sus viajes
 * cerrados, los kilómetros y las horas al volante del período. El viaje cerrado va por API (ver el
 * fixture): salió hace 10 h, llegó hace 2 h y recorrió 300 km (100 → 400).
 */
import { test, expect } from "@playwright/test";
import { darDeBajaAlConductor, prepararViajeDeConductor } from "./fixtures/conductorConViaje";

test("el resumen por conductor muestra los viajes, los km y las horas de cada uno", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const v = await prepararViajeDeConductor(page, { retroactivo: true });

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Viajes" }).click();

  const resumen = page.getByTestId("resumen-conductores");
  await resumen.getByText("Resumen por conductor").click();
  const fila = resumen.getByRole("row").filter({ hasText: `Conductor ${v.marca}` });
  await expect(fila).toHaveCount(1);
  // 1 viaje, 300 km y 8 h al volante; sin hora programada no hay puntualidad ni consumo que medir.
  await expect(fila.getByRole("cell").nth(1)).toHaveText("1");
  await expect(fila.getByRole("cell").nth(2)).toHaveText("300");
  await expect(fila.getByRole("cell").nth(3)).toContainText("8");

  await darDeBajaAlConductor(page, v);
});
