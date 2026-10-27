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

  // Dentro de 3 horas, como lo escribe un datetime-local (hora local, sin zona).
  const en3h = new Date(Date.now() + 3 * 3_600_000);
  const salidaLocal = new Date(en3h.getTime() - en3h.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

  const programar = async (tipo: RegExp, elegir: () => Promise<void>) => {
    await page.getByRole("button", { name: "Nuevo viaje" }).click();
    await page.getByRole("button", { name: "Conductor", exact: true }).click();
    // La opción del desplegable del formulario (la lista de viajes también tiene un filtro "Conductor").
    await page.locator('li[role="option"]').filter({ hasText: conductor }).click();
    await page.getByRole("radio", { name: tipo }).click();
    await elegir();
    await page.getByRole("button", { name: "Programar viaje", exact: true }).click();
  };

  // Ida y vuelta: sale de A, va a B y vuelve a A.
  await programar(/Ida y vuelta/, async () => {
    await page.getByLabel("Sale de", { exact: true }).selectOption({ label: a });
    await page.getByLabel("Va a", { exact: true }).selectOption({ label: b });
    await expect(page.getByText(/Vuelve a/)).toContainText(a);
    // La hora de salida programada y su tolerancia (0155) son opcionales.
    await page.getByLabel("Hora de salida programada (opcional)").fill(salidaLocal);
    await page.getByLabel("Tolerancia (min)").fill("15");
  });
  await expect(page.getByRole("cell", { name: `${a} → ${b} → ${a}` })).toBeVisible();
  // En la fila de ESE viaje (un reintento deja otras filas "Prog." y el selector sería ambiguo).
  await expect(
    page.getByRole("row", { name: new RegExp(`${a} → ${b} → ${a}`) }).getByText(/^Prog\./)
  ).toBeVisible();

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
  const viajes = (await lista.json()).data as {
    paradas: { lugar: string }[];
    salida_programada_en: string | null;
    desfase_tolerancia_min: number;
  }[];
  const recorridos = viajes
    .map((v) => v.paradas.map((p) => p.lugar))
    .sort((x, y) => x.length - y.length);
  // Solo el de ida y vuelta lleva hora programada; el otro queda con la tolerancia de siempre.
  const idaVuelta = viajes.find((v) => v.paradas.length === 3);
  const circuito = viajes.find((v) => v.paradas.length === 4);
  expect(idaVuelta?.salida_programada_en).not.toBeNull();
  expect(idaVuelta?.desfase_tolerancia_min).toBe(15);
  expect(circuito?.salida_programada_en).toBeNull();
  expect(circuito?.desfase_tolerancia_min).toBe(10);
  expect(recorridos).toEqual([
    [a, b, a],
    [a, b, c, a],
  ]);
});
