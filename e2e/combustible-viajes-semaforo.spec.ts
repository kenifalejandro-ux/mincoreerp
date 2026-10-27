/** e2e/combustible-viajes-semaforo.spec.ts
 *
 * La lista de viajes del encargado: el semáforo de cada viaje (un viaje que salió 30 min tarde,
 * con 10 de tolerancia, sale en rojo) y los filtros por conductor y por semáforo. El conductor
 * inicia desde su celular y la oficina lo mira desde otra sesión. El preparativo va por API.
 */
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  iniciarMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";
import { adminA } from "./fixtures/entorno";

test("la lista muestra el semáforo de cada viaje y se filtra por conductor y por semáforo", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  // Debía salir hace 30 min y la tolerancia es de 10: al iniciar sale tarde, en rojo.
  const v = await prepararViajeDeConductor(page, { programadoHaceMin: 30 });
  await entrarAMiViaje(page, v);
  await iniciarMiViaje(page, "100");

  const contexto = await browser.newContext();
  try {
    const oficina = await contexto.newPage();
    const admin = adminA();
    await loginPorUI(oficina, admin.email, admin.password);
    await oficina.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await oficina.getByRole("button", { name: "Viajes" }).click();

    const fila = oficina.getByRole("row").filter({ hasText: `${v.a} → ${v.b} → ${v.a}` });
    await expect(
      fila.getByRole("img", { name: /^Semáforo Rojo: Salió \d+ min tarde/ })
    ).toBeVisible({ timeout: 15_000 });

    // Por conductor: solo sus viajes.
    await oficina
      .locator("label", { hasText: /^Conductor/ })
      .locator("select")
      .selectOption({ label: `Conductor ${v.marca}` }, { timeout: 15_000 });
    await expect(fila).toHaveCount(1);
    await expect(oficina.getByRole("row").filter({ hasText: " → " })).toHaveCount(1);

    // Si otro filtro deja sin viajes a ese conductor, sigue elegido en el desplegable (no queda un
    // filtro activo mostrando "Todos").
    const filtroConductor = oficina.locator("label", { hasText: /^Conductor/ }).locator("select");
    await oficina
      .locator("label", { hasText: /^Estado/ })
      .locator("select")
      .selectOption("anulado");
    await expect(filtroConductor.locator("option:checked")).toHaveText(`Conductor ${v.marca}`);
    await oficina
      .locator("label", { hasText: /^Estado/ })
      .locator("select")
      .selectOption("");
    await expect(fila).toHaveCount(1);

    // Por semáforo: en verde no está, en rojo sí.
    await oficina
      .locator("label", { hasText: /^Semáforo/ })
      .locator("select")
      .selectOption("verde");
    await expect(fila).toHaveCount(0);
    await oficina
      .locator("label", { hasText: /^Semáforo/ })
      .locator("select")
      .selectOption("rojo");
    await expect(fila).toHaveCount(1);

    // Exportar a Excel baja lo que la lista muestra con los filtros puestos.
    const descarga = oficina.waitForEvent("download");
    await oficina.getByRole("button", { name: "Exportar a Excel" }).click();
    expect((await descarga).suggestedFilename()).toMatch(/^Viajes .*\.xlsx$/);
  } finally {
    await contexto.close();
  }
  await darDeBajaAlConductor(page, v);
});
