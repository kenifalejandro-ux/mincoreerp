/** e2e/combustible-viaje-recorrido.spec.ts
 *
 * Programar un viaje con recorrido (0148): ida y vuelta (A → B → A) y varias paradas. La unidad
 * y el conductor van por API; la pantalla elige el conductor, el tipo de viaje y las paradas.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("programar un viaje de ida y vuelta y uno con varias paradas", async ({ page }) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoId = await primerGrifoActivo(page);

  const lugar = async (nombre: string) => {
    const r = await page.request.post("/api/erp/combustible/lugares", { data: { nombre } });
    expect(r.status()).toBe(201);
  };
  const a = `Huamachuco ${marca}`;
  const b = `Bambamarca ${marca}`;
  const c = `Cajamarca ${marca}`;
  await lugar(a);
  await lugar(b);
  await lugar(c);

  const conductor = `Conductor ${marca}`;
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: `VQ-${marca}`,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: conductor,
      conductor_dni: `4${Math.floor(1e6 + Math.random() * 9e6)}`,
      grifo_interno_id: grifoId,
    },
  });
  expect(equipo.status()).toBe(201);
  const equipoId = (await equipo.json()).id as number;

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Viajes" }).click();

  const programar = async (tipo: RegExp, elegir: () => Promise<void>) => {
    await page.getByRole("button", { name: "Nuevo viaje" }).click();
    await page.getByRole("button", { name: "Conductor", exact: true }).click();
    await page.getByRole("option", { name: new RegExp(conductor) }).click();
    await page.getByRole("radio", { name: tipo }).click();
    await elegir();
    await page.getByRole("button", { name: "Programar viaje", exact: true }).click();
  };

  // Ida y vuelta: sale de A, va a B y vuelve a A.
  await programar(/Ida y vuelta/, async () => {
    await page.getByLabel("Sale de", { exact: true }).selectOption({ label: a });
    await page.getByLabel("Va a", { exact: true }).selectOption({ label: b });
    await expect(page.getByText(/Vuelve a/)).toContainText(a);
  });
  await expect(page.getByRole("cell", { name: `${a} → ${b} → ${a}` })).toBeVisible();

  // Varias paradas: A → B → C → A, con la parada extra que trae el formulario.
  await programar(/Varias paradas/, async () => {
    await page.getByLabel("Sale de", { exact: true }).selectOption({ label: a });
    await page.getByLabel("Parada 1", { exact: true }).selectOption({ label: b });
    await page.getByLabel("Parada 2", { exact: true }).selectOption({ label: c });
    await page.getByLabel("Llega a", { exact: true }).selectOption({ label: a });
  });
  await expect(page.getByRole("cell", { name: `${a} → ${b} → ${c} → ${a}` })).toBeVisible();

  // El servidor guardó las paradas de los dos viajes, en orden.
  const lista = await page.request.get("/api/erp/combustible/viajes", {
    params: { equipo_id: String(equipoId), estado: "programado" },
  });
  const viajes = (await lista.json()).data as { paradas: { lugar: string }[] }[];
  const recorridos = viajes
    .map((v) => v.paradas.map((p) => p.lugar))
    .sort((x, y) => x.length - y.length);
  expect(recorridos).toEqual([
    [a, b, a],
    [a, b, c, a],
  ]);
});
