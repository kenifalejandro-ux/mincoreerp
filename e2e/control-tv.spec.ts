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
  // Los dos lugares con su punto en el mapa (Trujillo y Tocache, aproximados): el mapa digital los dibuja.
  for (const [id, lat, lon] of [
    [a, -8.1116, -79.0288],
    [b, -8.1833, -76.5167],
  ] as const) {
    const r = await page.request.patch(`/api/erp/viajes/lugares/${id}`, {
      data: { latitud: lat, longitud: lon },
    });
    expect(r.status()).toBe(200);
  }
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
  await expect(tv.getByRole("button", { name: "Pantalla completa", exact: true })).toBeVisible();
  // La vista en vivo abre en el mapa digital; «Marcas» está a su lado y la leyenda es el filtro.
  await expect(tv.getByRole("button", { name: "Marcas", exact: true })).toBeVisible();
  await expect(tv.getByRole("img", { name: /Mapa de las unidades en ruta/ })).toBeVisible();
  await expect(tv.getByRole("button", { name: /^Todas\s*\d+$/ })).toBeVisible();
  await expect(tv.getByRole("button", { name: /^En ruta\s*\d+$/ })).toBeVisible();
  // La leyenda es el filtro: pulsar un estado lo marca (aria-pressed) y volver a «Todas» lo quita.
  const detenidas = tv.getByRole("button", { name: /^Detenidas\s*\d+$/ });
  await detenidas.click();
  await expect(detenidas).toHaveAttribute("aria-pressed", "true");
  await expect(tv.getByRole("button", { name: /^Todas\s*\d+$/ })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await tv.getByRole("button", { name: /^Todas\s*\d+$/ }).click();
  await expect(tv.getByRole("button", { name: /^Todas\s*\d+$/ })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(tv.getByRole("button", { name: "Digital", exact: true })).toBeVisible();

  // Tocar la unidad abre SU Control TV: el conductor primero, con su placa, y las horas del viaje.
  // (El mapa es un lienzo: cada unidad tiene además un botón oculto con su nombre, para teclado y lectores.)
  await tv
    .getByRole("button", { name: new RegExp(`Ver .*TV-${marca}.* en su Control TV`) })
    .dispatchEvent("click");
  await expect(tv.getByRole("heading", { name: `Conductor ${marca}` })).toBeVisible();
  await expect(tv.getByText(`TV-${marca}`).first()).toBeVisible();
  // La vista de la unidad: el mapa al medio («Dónde está») y la información del conductor alrededor.
  await expect(tv.getByText("Dónde está")).toBeVisible();
  for (const t of [
    "Consumo acumulado del viaje",
    "Tiempos del viaje",
    "Conductor y relevo",
    "Alertas activas",
    "Consumo por tramo",
    "Rendimiento y cargas",
  ]) {
    await expect(tv.getByRole("heading", { name: t })).toBeVisible();
  }
  await expect(tv.getByRole("heading", { name: /^Resumen de la unidad/ })).toBeVisible();
  await expect(tv.getByText("EN RUTA", { exact: true })).toBeVisible();
  expect(tv.url()).toContain(`unidad=${viaje.id}`);
  // A 1920×990 y 1366×700 la unidad cabe sin bajar, y el mapa queda a la izquierda de la columna de
  // estado operacional (no debajo).
  for (const [ancho, alto, nombre] of [
    [1920, 990, "1920x990"],
    [1366, 820, "1366x820"],
  ] as const) {
    await tv.setViewportSize({ width: ancho, height: alto });
    await expect(tv.getByRole("heading", { name: "Alertas activas" })).toBeVisible();
    const mapa = await tv.getByText("Dónde está").boundingBox();
    const estadoOp = await tv
      .getByRole("heading", { name: "Consumo acumulado del viaje" })
      .boundingBox();
    expect(estadoOp!.x, nombre).toBeGreaterThan(mapa!.x + 300);
    const desborde = await tv
      .locator("div.fixed.inset-0")
      .first()
      .evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(desborde, `unidad ${nombre} sin scroll`).toBeLessThanOrEqual(1);
    if (process.env.CAPTURAS_TV) {
      await tv.screenshot({ path: `${process.env.CAPTURAS_TV}/unidad-${nombre}.png` });
    }
  }
  await tv.setViewportSize({ width: 1920, height: 1080 });
  // «TV central» vuelve al tablero de todas las unidades.
  await tv.getByRole("button", { name: "TV central" }).click();
  await expect(tv.getByText("Flota en operación")).toBeVisible();
  expect(tv.url()).not.toContain("unidad=");

  // El Resumen de escritorio son gráficos (no las seis tarjetas de colores); el consumo sale una sola
  // vez, arriba, y el panel de abajo ya no lo repite.
  await expect(tv.getByRole("heading", { name: "Autonomía y urea" })).toBeVisible();
  await expect(tv.getByRole("heading", { name: /^Consumo por (hora|día)$/ })).toHaveCount(1);
  await expect(tv.getByText("Combustible en la empresa")).toHaveCount(0);
  // En un monitor grande y en una laptop no hay desborde lateral ni vertical-lateral raro.
  for (const [ancho, alto] of [
    [1920, 1080],
    [1366, 768],
  ]) {
    await tv.setViewportSize({ width: ancho, height: alto });
    await expect(tv.getByText("Flota en operación")).toBeVisible();
    const lat = await tv
      .locator("div.fixed.inset-0")
      .first()
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(lat, `${ancho}×${alto}`).toBeLessThanOrEqual(0);
    if (process.env.CAPTURAS_TV) {
      await tv.screenshot({ path: `${process.env.CAPTURAS_TV}/escritorio-${ancho}.png` });
    }
  }
  // La TV cabe en la pantalla de un navegador común sin bajar: 1920×990, con el mapa y los paneles de abajo.
  await tv.setViewportSize({ width: 1920, height: 990 });
  await expect(tv.getByRole("heading", { name: "Últimos eventos" })).toBeVisible();
  const desborde990 = await tv
    .locator("div.fixed.inset-0")
    .first()
    .evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(desborde990, "1920×990 sin scroll").toBeLessThanOrEqual(1);
  if (process.env.CAPTURAS_TV) {
    await tv.screenshot({ path: `${process.env.CAPTURAS_TV}/tv-1920x990.png` });
  }
  await tv.setViewportSize({ width: 1920, height: 1080 });

  // El mapa en pantalla completa: la lista lateral sale y se puede volver.
  await tv.getByRole("button", { name: "Mapa en pantalla completa" }).click();
  await expect(
    tv.getByRole("button", { name: "Salir de pantalla completa del mapa" })
  ).toBeVisible();
  await expect(tv.getByText(`TV-${marca}`).first()).toBeVisible();
  if (process.env.CAPTURAS_TV) {
    await tv.screenshot({ path: `${process.env.CAPTURAS_TV}/mapa-completa.png` });
  }
  // El satélite es la segunda opción: se pide y se carga solo entonces (necesita internet para las
  // imágenes, así que aquí solo se comprueba que el mapa se arma y que se puede volver a Digital).
  await tv.getByRole("button", { name: "Satélite", exact: true }).click();
  await expect(tv.locator(".leaflet-container")).toBeVisible();
  if (process.env.CAPTURAS_TV) {
    await tv.waitForTimeout(2500);
    await tv.screenshot({ path: `${process.env.CAPTURAS_TV}/mapa-satelite.png` });
  }
  await tv.getByRole("button", { name: "Digital", exact: true }).click();
  await expect(tv.locator(".leaflet-container")).toHaveCount(0);
  await expect(tv.getByRole("img", { name: /Mapa de las unidades en ruta/ })).toBeVisible();
  await tv.keyboard.press("Escape");
  await expect(tv.getByRole("button", { name: "Mapa en pantalla completa" })).toBeVisible();

  // Los paneles de abajo: tanquetas y la franja de últimos eventos (la salida del viaje recién
  // preparado no es un evento, pero la franja siempre está).
  await expect(tv.getByRole("heading", { name: "Tanquetas" })).toBeVisible();
  await expect(tv.getByRole("heading", { name: "Últimos eventos" })).toBeVisible();
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
  await expect(tv.getByRole("button", { name: "Pantalla completa", exact: true })).toBeHidden();
  // En el celular, el Resumen son gráficos (no las tarjetas de escritorio), de a dos por fila.
  await expect(tv.getByRole("heading", { name: "Duración de los viajes" })).toBeVisible();
  // Lo primero que ve la gerencia: la flota (y, si hay, las unidades detenidas y el tanque).
  await expect(tv.getByRole("heading", { name: "Flota en operación" })).toBeVisible();
  // Los gráficos van en dos columnas: entre los que haya (según los datos), unos quedan a la izquierda
  // y otros a la derecha, y los de una misma fila están a la misma altura.
  const cajas = [];
  for (const nombre of [
    "Autonomía y urea",
    "De dónde llegó el combustible",
    /^Consumo por (hora|día)$/,
    "Duración de los viajes",
    "Unidades que más se desvían",
  ]) {
    const encabezado = tv.getByRole("heading", { name: nombre });
    if ((await encabezado.count()) === 0) continue;
    const c = await encabezado.boundingBox();
    if (c) cajas.push(c);
  }
  expect(cajas.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...cajas.map((c) => c.x)) - Math.min(...cajas.map((c) => c.x))).toBeGreaterThan(
    100
  );
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
  const tiempos = tv.locator("details", { hasText: "Tiempos del viaje" });
  await expect(tiempos).toHaveAttribute("open", "");
  await tiempos.locator("summary").click();
  await expect(tiempos).not.toHaveAttribute("open", "");
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
