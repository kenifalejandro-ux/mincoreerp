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

  // El ícono TV de la barra superior (junto a la fecha) abre el Control TV central en otra pestaña.
  const [tv] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Control TV", exact: true }).click(),
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
  // Cada tipo tiene su propio largo: el volquete se dibuja más ancho que alto (44×24 en su lienzo).
  const dibujo = tv.getByTitle(new RegExp(`TV-${marca}`)).locator("svg");
  const caja = await dibujo.boundingBox();
  expect(caja!.width).toBeGreaterThan(caja!.height * 1.5);

  // Tocar la unidad abre SU Control TV: el conductor primero, con su placa, y las horas del viaje.
  await tv
    .getByRole("button", { name: new RegExp(`Ver .*TV-${marca}.* en su Control TV`) })
    .click();
  await expect(tv.getByRole("heading", { name: `Conductor ${marca}` })).toBeVisible();
  await expect(tv.getByText(`TV-${marca}`).first()).toBeVisible();
  await expect(tv.getByText("Cómo se fue el tiempo")).toBeVisible();
  await expect(tv.getByText("Consumo del recorrido actual")).toBeVisible();
  await expect(tv.getByText("Dónde está")).toBeVisible();
  expect(tv.url()).toContain(`unidad=${viaje.id}`);
  // En una pantalla de TV (1920×1080) la unidad cabe sin bajar y se reparte en columnas: el consumo
  // queda a la derecha del recorrido, no debajo.
  await tv.setViewportSize({ width: 1920, height: 1080 });
  const desborde = await tv
    .locator("div.fixed.inset-0")
    .first()
    .evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(desborde).toBeLessThanOrEqual(0);
  const tiempo = await tv.getByText("Cómo se fue el tiempo").boundingBox();
  const consumo = await tv.getByText("Consumo del recorrido actual").boundingBox();
  expect(consumo!.x).toBeGreaterThan(tiempo!.x + 200);
  // «TV central» vuelve al tablero de todas las unidades.
  await tv.getByRole("button", { name: "TV central" }).click();
  await expect(tv.getByText("Flota en operación")).toBeVisible();
  expect(tv.url()).not.toContain("unidad=");

  // Los paneles de abajo: tanquetas, consumo y la franja de últimos eventos (la salida del viaje
  // recién preparado no es un evento, pero la franja siempre está).
  await expect(tv.getByRole("heading", { name: "Tanquetas" })).toBeVisible();
  await expect(tv.getByRole("heading", { name: "Consumo por hora" })).toBeVisible();
  await expect(tv.getByRole("heading", { name: "Últimos eventos" })).toBeVisible();
  // El consumo se puede ver también como tabla, con los mismos números.
  await tv.getByRole("button", { name: "Tabla" }).first().click();
  await expect(tv.getByRole("columnheader", { name: "Grifo interno" })).toBeVisible();
  // Cambiar de período no vacía la pantalla, y el consumo pasa a ser por día.
  await tv.getByRole("button", { name: "7 días" }).click();
  await expect(tv.getByText("Flota en operación")).toBeVisible();
  await expect(tv.getByRole("heading", { name: "Consumo por día" })).toBeVisible();

  // «Detalle»: lo que la gerencia usa para decidir.
  await tv.getByRole("button", { name: "Detalle" }).click();
  await expect(tv.getByRole("heading", { name: "Cómo se mueve el combustible" })).toBeVisible();
  await expect(tv.getByRole("heading", { name: /^Combustible · / })).toBeVisible();
  await expect(
    tv.getByRole("heading", { name: "Últimas recepciones de combustible" })
  ).toBeVisible();
  await expect(tv.getByRole("heading", { name: "Para decidir" })).toBeVisible();
  await expect(tv.getByRole("heading", { name: "Unidades que más se desvían" })).toBeVisible();
  await expect(tv.getByRole("heading", { name: "Compra en ruta: cuánto cuesta" })).toBeVisible();
  // El período del detalle cambia sin vaciar la pantalla, y «Tabla» muestra los mismos números.
  await tv.getByRole("button", { name: "7 días" }).click();
  await expect(tv.getByRole("heading", { name: "Combustible · últimos 7 días" })).toBeVisible();
  await tv.getByRole("button", { name: "Tabla" }).click();
  await expect(
    tv.getByRole("columnheader", { name: /Compra en ruta \(gal\)/ }).first()
  ).toBeVisible();
  await tv.getByRole("button", { name: "Resumen" }).click();
  await expect(tv.getByText("Flota en operación")).toBeVisible();

  // El ícono TV de la fila del viaje abre directamente la vista de esa unidad.
  const [fila] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: `Ver en el Control TV el viaje V-${viaje.numero}` }).click(),
  ]);
  await fila.waitForLoadState();
  expect(fila.url()).toContain(`unidad=${viaje.id}`);
  await expect(fila.getByRole("heading", { name: `Conductor ${marca}` })).toBeVisible();

  // En un celular (393×852) el tablero se reparte en pestañas abajo, sin desborde lateral.
  await tv.setViewportSize({ width: 393, height: 852 });
  const nav = tv.getByRole("navigation", { name: "Secciones del Control TV" });
  await expect(nav).toBeVisible();
  for (const t of ["Resumen", "Flota", "Combustible", "Eventos"]) {
    await expect(nav.getByRole("button", { name: t })).toBeVisible();
  }
  await expect(tv.getByRole("button", { name: "Pantalla completa" })).toBeHidden();
  // Las cifras van de a dos por fila.
  const uno = await tv.getByText("Viajes activos").boundingBox();
  const dos = await tv.getByText("Combustible en la empresa").boundingBox();
  expect(Math.abs(uno!.y - dos!.y)).toBeLessThan(4);
  expect(dos!.x).toBeGreaterThan(uno!.x + 100);
  const lateral = await tv
    .locator("div.fixed.inset-0")
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(lateral).toBeLessThanOrEqual(0);
  await nav.getByRole("button", { name: "Flota" }).click();
  await expect(tv.getByText("Flota en operación")).toBeVisible();
  await expect(tv.getByText("Vista en vivo")).toBeVisible();
  await nav.getByRole("button", { name: "Eventos" }).click();
  await expect(tv.getByRole("heading", { name: "Últimos eventos" })).toBeVisible();
  // La unidad también cabe: sus secciones se pliegan con un toque en el título.
  await tv.goto(`/control-tv?unidad=${viaje.id}`);
  await expect(tv.getByRole("heading", { name: `Conductor ${marca}` })).toBeVisible();
  await expect(nav).toBeHidden();
  const resumenUnidad = tv.getByText("Cómo se fue el tiempo");
  await expect(resumenUnidad).toBeVisible();
  await expect(tv.locator("details", { hasText: "Cómo se fue el tiempo" })).not.toHaveAttribute(
    "open",
    ""
  );
  await resumenUnidad.click();
  await expect(tv.locator("details", { hasText: "Cómo se fue el tiempo" })).toHaveAttribute(
    "open",
    ""
  );
  const lateralUnidad = await tv
    .locator("div.fixed.inset-0")
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(lateralUnidad).toBeLessThanOrEqual(0);

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
