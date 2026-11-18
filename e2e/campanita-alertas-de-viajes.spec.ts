/** e2e/campanita-alertas-de-viajes.spec.ts
 *
 * La campanita de alertas lee de cada Bandeja que la persona ve: Combustible y Viajes (0188, otra
 * tabla y otro endpoint). Antes leía solo Combustible: las alertas de viaje no salían nunca en ella
 * y un admin con Viajes pero sin Combustible ni la veía. Lo que se fija:
 *
 * 1. Con Combustible y Viajes, una alerta de viaje sale en la campanita bajo «Flota»; al abrirla se
 *    marca leída en SU fuente (Viajes, no Combustible) y la Bandeja abre la pestaña Viajes.
 * 2. Un admin solo con Viajes ve la campanita, con su alerta, y no pide nunca las de Combustible
 *    (sería un 403).
 *
 * Las respuestas de /api/erp/viajes/alertas se simulan con `page.route`: generar una alerta real de
 * viaje pide un viaje en curso. (Que el servidor las entrega y a quién lo cubre
 * tests/alertas-por-modulo.test.ts.)
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

/** Una alerta de viaje con la forma que devuelve el servidor (el id BIGINT llega como texto). */
function alertaDeViaje(unidad: string) {
  return {
    id: "7",
    tipo: "viaje_demorado",
    critica: false,
    serie_talonario: null,
    n_vale: null,
    despacho_id: null,
    combustible_id: null,
    recepcion_id: null,
    detalle: { viajeNumero: 12, unidad },
    creado_en: new Date().toISOString(),
    leida_en: null,
    resuelta_en: null,
    resuelta_por: null,
    grifo_interno_id: null,
    grifo_nombre: null,
    sede_nombre: null,
    revisable: true,
    congelada_en: null,
  };
}

/** Simula las tres rutas de la Bandeja de Viajes y anota las peticiones de alertas que se hacen. */
async function simularAlertasDeViajes(page: Page, unidad: string) {
  const alerta = alertaDeViaje(unidad);
  const pedidas: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/erp/viajes/alertas")) {
      pedidas.push(`${r.method()} viajes ${url.pathname}`);
    }
    if (url.pathname.startsWith("/api/erp/combustible/alertas")) {
      pedidas.push(`${r.method()} combustible ${url.pathname}`);
    }
  });
  await page.route(
    (url) => url.pathname === "/api/erp/viajes/alertas",
    (ruta) =>
      ruta.fulfill({ json: { data: [alerta], pagination: { total: 1, page: 1, totalPages: 1 } } })
  );
  await page.route(
    (url) => url.pathname === "/api/erp/viajes/alertas/resumen",
    (ruta) =>
      ruta.fulfill({
        json: {
          sinLeer: 1,
          pendientes: 1,
          porRevisar: 0,
          resueltas: 0,
          congeladas: 0,
          criticasPendientes: 0,
          total: 1,
        },
      })
  );
  await page.route(
    (url) => url.pathname === "/api/erp/viajes/alertas/leidas",
    (ruta) => ruta.fulfill({ json: { ok: true } })
  );
  return pedidas;
}

test("con Combustible y Viajes la campanita muestra la alerta de viaje, la marca leída en Viajes y abre su pestaña", async ({
  page,
}) => {
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const unidad = `U${marca}`;
  const pedidas = await simularAlertasDeViajes(page, unidad);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // La campanita lee de las dos fuentes.
  await page.getByTitle("Alertas", { exact: true }).click();
  const flota = page.getByRole("region", { name: "Flota" });
  const fila = flota.getByRole("button", { name: new RegExp(`Viaje demorado: V-12 · ${unidad}`) });
  await expect(fila).toBeVisible({ timeout: 20_000 });
  expect(pedidas.some((p) => p.includes("GET combustible"))).toBe(true);
  expect(pedidas.some((p) => p.includes("GET viajes"))).toBe(true);

  // Abrirla la marca leída en SU fuente (Viajes) y lleva a la pestaña Viajes de la Bandeja.
  const marcada = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().includes("/api/erp/viajes/alertas/leidas")
  );
  const traida = page.waitForRequest(
    (r) => r.url().includes("/api/erp/viajes/alertas") && r.url().includes("id=7")
  );
  await fila.click();
  expect(((await marcada).postDataJSON() as { ids: (number | string)[] }).ids.map(Number)).toEqual([
    7,
  ]);
  await traida;

  await expect(page.getByRole("heading", { name: "Bandeja de alertas" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Viajes", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  // Y no se marcó nada en Combustible: el id 7 de una tabla no es el id 7 de la otra.
  expect(pedidas.some((p) => p.startsWith("PATCH combustible"))).toBe(false);
});

test("un admin solo con Viajes ve la campanita con su alerta y no pide las de Combustible", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const unidad = `V${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // Un admin al que solo le dieron Viajes (y el Dashboard, para tener dónde aterrizar).
  const email = `viajes-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Admin solo viajes ${marca}`, email, password: temporal, rol: "admin" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  const usuarioId = (await alta.json()).id as string;
  const actuales = await (await page.request.get(`/api/erp/usuarios/${usuarioId}/permisos`)).json();
  const soloViajes = await page.request.put(`/api/erp/usuarios/${usuarioId}/permisos`, {
    data: {
      modulos: actuales.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: ["dashboard", "viajes"].includes(m.modulo),
        nivel: m.nivel,
      })),
      motivo: "spec e2e: admin solo con Viajes",
    },
  });
  expect(soloViajes.status(), await soloViajes.text()).toBe(200);

  const contexto = await browser.newContext();
  const otro = await contexto.newPage();
  try {
    const pedidas = await simularAlertasDeViajes(otro, unidad);
    await otro.goto("/");
    await otro.getByLabel("Correo").fill(email);
    await otro.getByLabel("Contraseña").fill(temporal);
    await otro.getByRole("button", { name: "Ingresar" }).click();
    await otro.locator("#passwordActual").fill(temporal);
    await otro.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await otro.locator("#confirmacion").fill(`${temporal}Nueva`);
    await otro.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(otro.getByRole("button", { name: "Dashboard" })).toBeVisible();

    // Antes no tenía campanita (se exigía Combustible): ahora sí, con la alerta de viaje.
    await otro.getByTitle("Alertas", { exact: true }).click();
    await expect(
      otro
        .getByRole("region", { name: "Flota" })
        .getByRole("button", { name: new RegExp(`Viaje demorado: V-12 · ${unidad}`) })
    ).toBeVisible({ timeout: 20_000 });

    // Sin el módulo Combustible no se pide nada a su fuente (sería un 403).
    expect(pedidas.some((p) => p.includes("viajes"))).toBe(true);
    expect(pedidas.filter((p) => p.includes("combustible"))).toEqual([]);
  } finally {
    await contexto.close();
    await page.request.patch(`/api/erp/usuarios/${usuarioId}/estado`, {
      data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
    });
  }
});
