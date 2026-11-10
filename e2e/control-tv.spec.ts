/** e2e/control-tv.spec.ts
 *
 * El Control TV (pantalla de la gerencia, /control-tv): se abre desde el botón «TV» y desde el
 * ícono de la fila de un viaje en curso, muestra la flota y la vista en vivo, y sin sesión no deja
 * ver nada. El preparativo (lugares, unidad, viaje en curso) va por API.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("el Control TV muestra la flota en vivo y se abre desde Viajes", async ({ page, context }) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoId = await primerGrifoActivo(page);

  const lugar = async (nombre: string) => {
    const r = await page.request.post("/api/erp/viajes/lugares", { data: { nombre } });
    expect(r.status()).toBe(201);
    return Number((await r.json()).id);
  };
  const a = await lugar(`Origen TV ${marca}`);
  const b = await lugar(`Destino TV ${marca}`);
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: `TV-${marca}`,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: `Conductor ${marca}`,
      conductor_dni: `4${Math.floor(1e6 + Math.random() * 9e6)}`,
      grifo_interno_id: grifoId,
    },
  });
  expect(equipo.status()).toBe(201);
  const viaje = await (
    await page.request.post("/api/erp/viajes", {
      data: { equipo_id: (await equipo.json()).id, paradas: [a, b, a] },
    })
  ).json();
  const inicio = await page.request.post(`/api/erp/viajes/${viaje.id}/iniciar`, {
    data: {
      medidor_inicio: 100,
      inicio_en: new Date(Date.now() - 3_600_000).toISOString(),
      motivo: "preparativo del e2e",
    },
  });
  expect(inicio.status()).toBe(200);

  await page.getByRole("button", { name: /^Gestión operacional de flota Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Viajes" }).click();

  // El ícono de la fila abre el Control TV en otra pestaña.
  const [tv] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: `Ver en el Control TV el viaje V-${viaje.numero}` }).click(),
  ]);
  await tv.waitForLoadState();
  expect(tv.url()).toContain("/control-tv");
  await expect(tv.getByRole("heading", { name: "Control de viajes" })).toBeVisible();
  await expect(tv.getByText("Flota en operación")).toBeVisible();
  await expect(tv.getByText("Vista en vivo")).toBeVisible();
  await expect(tv.getByText("Viajes activos")).toBeVisible();
  await expect(tv.getByRole("button", { name: "Pantalla completa" })).toBeVisible();
  // La unidad del viaje aparece en la vista en vivo con su tipo.
  await expect(tv.getByTitle(new RegExp(`TV-${marca}`))).toBeVisible();
  // Cambiar de período no vacía la pantalla.
  await tv.getByRole("button", { name: "7 días" }).click();
  await expect(tv.getByText("Flota en operación")).toBeVisible();

  // El botón «TV» de la cabecera de Viajes abre lo mismo.
  const [otra] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "TV", exact: true }).click(),
  ]);
  await otra.waitForLoadState();
  await expect(otra.getByRole("heading", { name: "Control de viajes" })).toBeVisible();

  // «Salir» vuelve al ERP.
  await tv.getByRole("button", { name: "Salir" }).click();
  await expect(tv).toHaveURL(/\/$/);
});

test("sin iniciar sesión el Control TV no muestra nada de la flota", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/control-tv");
  await expect(page.getByText("Flota en operación")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Control de viajes" })).toHaveCount(0);
  await ctx.close();
});
