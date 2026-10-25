/** e2e/combustible-mi-viaje-historial.spec.ts
 *
 * "Mi viaje" › Historial: el conductor ve sus viajes cerrados con lo suyo (recorrido, lo que
 * recorrió) y, sin señal, la última página que vio. El viaje se hace por API con su sesión; el
 * preparativo es el del fixture (conductor, unidad, viaje A → B → A).
 */
import { test, expect } from "@playwright/test";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";

test("el conductor ve su viaje terminado en el historial, también sin señal", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const v = await prepararViajeDeConductor(page);
  await entrarAMiViaje(page, v);

  // Hace el viaje completo con su sesión (por API: aquí se prueba el historial, no las marcas).
  const marcar = async (accion: string, medidor: Record<string, number>) => {
    const r = await page.request.post(`/api/erp/combustible/viajes/${v.viajeId}/${accion}`, {
      data: medidor,
    });
    expect(r.status(), `${accion}: ${await r.text()}`).toBe(200);
  };
  await marcar("iniciar-mio", { medidor_inicio: 100 });
  await marcar("llegada-mia", { medidor: 150 });
  await marcar("salida-mia", { medidor: 150 });
  await marcar("llegada-mia", { medidor: 250 });

  await page.getByRole("tab", { name: "Historial" }).click();
  await expect(page.getByText(`${v.a} → ${v.b} → ${v.a}`)).toBeVisible();
  await expect(page.getByText("150")).toBeVisible(); // lo que recorrió: 250 − 100

  // Sin señal: al volver a abrir el historial se ve la última página guardada.
  await context.setOffline(true);
  await page.getByRole("tab", { name: "Mi viaje" }).click();
  await page.getByRole("tab", { name: "Historial" }).click();
  await expect(page.getByText(/Sin señal: ves lo último guardado/)).toBeVisible();
  await expect(page.getByText(`${v.a} → ${v.b} → ${v.a}`)).toBeVisible();
  await context.setOffline(false);

  await darDeBajaAlConductor(page, v);
});
