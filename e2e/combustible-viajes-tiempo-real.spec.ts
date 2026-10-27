/** e2e/combustible-viajes-tiempo-real.spec.ts
 *
 * Dos sesiones reales: la oficina mira el viaje y el conductor marca desde su celular. Lo que marca
 * el conductor (salida, llegada, retorno) se ve en el panel del encargado SIN recargar, y un viaje
 * que programa la oficina aparece en la cola del conductor sin que él recargue. El preparativo va
 * por API (ver el fixture).
 */
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  iniciarMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

const irAViajes = async (page: Page) => {
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Viajes" }).click();
};

test("el panel del encargado sigue al conductor sin recargar: salida, llegada y retorno", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const v = await prepararViajeDeConductor(page);
  const contexto = await browser.newContext();
  try {
    // ── La oficina abre el detalle del viaje y lo deja abierto ───────────
    const oficina = await contexto.newPage();
    const admin = adminA();
    await loginPorUI(oficina, admin.email, admin.password);
    await irAViajes(oficina);
    await oficina
      .getByRole("row")
      .filter({ hasText: `${v.a} → ${v.b} → ${v.a}` })
      .first()
      .click();
    await expect(oficina.getByText("Aún no sale")).toBeVisible();

    // ── El conductor sale: el panel lo dice y muestra el odómetro ────────
    await entrarAMiViaje(page, v);
    const odometro = page.getByLabel(/que marca el tablero/);
    await iniciarMiViaje(page, "100");
    await expect(oficina.getByText(`En ruta a ${v.b}`, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(oficina.getByText("100 km", { exact: true })).toBeVisible();

    // ── Llega a la parada: odómetro actual y estado cambian ──────────────
    await page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true }).click();
    await odometro.fill("200");
    await page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true }).click();
    await expect(page.getByText("Llegada registrada.")).toBeVisible();
    await expect(oficina.getByText(`En ${v.b} · sigue a ${v.a}`, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(oficina.getByText("200 km", { exact: true })).toBeVisible();

    // ── Sale de vuelta: el panel dice que retorna ────────────────────────
    await page.getByRole("button", { name: `Salir hacia ${v.a}`, exact: true }).click();
    await odometro.fill("200");
    await page.getByRole("button", { name: `Salir hacia ${v.a}`, exact: true }).click();
    await expect(page.getByText(/Salida registrada/)).toBeVisible();
    await expect(oficina.getByText(`Retornando a ${v.a}`, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await contexto.close();
  }
  await darDeBajaAlConductor(page, v);
});

test("un viaje que programa la oficina aparece en la cola del conductor sin recargar", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const v = await prepararViajeDeConductor(page);
  const contexto = await browser.newContext();
  try {
    await entrarAMiViaje(page, v);
    await expect(page.getByRole("button", { name: "Revisar mi viaje" })).toBeVisible();
    // Con un solo viaje no hay cola que mostrar.
    await expect(page.getByTestId("cola-viajes")).toHaveCount(0);

    // La oficina programa otro viaje para el mismo conductor, en otra unidad.
    const oficina = await contexto.newPage();
    const admin = adminA();
    await loginPorUI(oficina, admin.email, admin.password);
    const grifoId = await primerGrifoActivo(oficina);
    const detalle = await oficina.request.get(`/api/erp/combustible/viajes/${v.viajeId}`);
    const { origen_id, destino_id } = (await detalle.json()).viaje as {
      origen_id: string;
      destino_id: string;
    };
    const unidad = await oficina.request.post("/api/erp/equipos", {
      data: {
        placa_codigo: `VQ-${v.marca}-X`,
        tipo: "VOLQUETE",
        tipo_medidor: "odometro",
        conductor_nombre: `Conductor ${v.marca}`,
        conductor_dni: v.dni,
        grifo_interno_id: grifoId,
      },
    });
    expect(unidad.status()).toBe(201);
    const otro = await oficina.request.post("/api/erp/combustible/viajes", {
      data: {
        equipo_id: (await unidad.json()).id,
        paradas: [Number(origen_id), Number(destino_id)],
        conductor_dni: v.dni,
        salida_programada_en: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      },
    });
    expect(otro.status(), await otro.text()).toBe(201);

    // El celular del conductor se entera solo: aparece la cola con los dos viajes.
    const cola = page.getByTestId("cola-viajes");
    await expect(cola).toBeVisible({ timeout: 30_000 });
    await expect(cola.getByRole("listitem")).toHaveCount(2);
  } finally {
    await contexto.close();
  }
  await darDeBajaAlConductor(page, v);
});
