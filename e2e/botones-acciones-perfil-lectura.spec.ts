/** e2e/botones-acciones-perfil-lectura.spec.ts
 *
 * Los botones de acciones de las tablas de Órdenes de Trabajo (Iniciar, Completar, Cancelar) y de
 * IPERC (Aprobar, Rechazar, en evaluaciones y en líneas base) se OCULTAN al perfil Lectura, como
 * pide `usePuedeEscribir`. Hubo un error de JSX (`puedeEscribir &&{" "}` fuera de las llaves) que
 * dibujaba ese texto en la celda y dejaba los botones siempre visibles: este spec lo fija.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("el perfil Lectura no ve los botones de acciones de Órdenes de Trabajo ni de IPERC; el admin sí", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // Datos de prueba, por API: una orden abierta, un IPERC en borrador y una línea base en borrador.
  const activo = `Horno ${marca}`;
  const orden = await page.request.post("/api/erp/ordenes_trabajo", {
    data: { activo_texto: activo, titulo: `Cambiar faja ${marca}` },
  });
  expect(orden.status(), await orden.text()).toBe(201);
  const ordenId = (await orden.json()).id as number;

  const areaIperc = `Area ${marca}`;
  const item = {
    etapa_actividad: "Carga",
    peligro: "Caída de material",
    riesgo: "Golpe",
    probabilidad: 2,
    severidad: 3,
    medidas_control: "Casco y barreras",
  };
  const iperc = await page.request.post("/api/erp/iperc", {
    data: { tipo: "continuo", area_frente: areaIperc, items: [item] },
  });
  expect(iperc.status(), await iperc.text()).toBe(201);
  const ipercId = (await iperc.json()).id as number;

  const procesoLb = `Proceso ${marca}`;
  const lineaBase = await page.request.post("/api/erp/iperc/lineas-base", {
    data: { proceso_actividad: procesoLb, area_frente: `Frente ${marca}`, items: [item] },
  });
  expect(lineaBase.status(), await lineaBase.text()).toBe(201);
  const lineaBaseId = (await lineaBase.json()).id as number;

  // Usuario Lectura con acceso a los dos módulos.
  const email = `lectura-acciones-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Lectura ${marca}`, email, password: temporal, rol: "lectura" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  const usuarioId = (await alta.json()).id as string;
  const actuales = await (await page.request.get(`/api/erp/usuarios/${usuarioId}/permisos`)).json();
  const habilitar = await page.request.put(`/api/erp/usuarios/${usuarioId}/permisos`, {
    data: {
      modulos: actuales.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: ["ordenes_trabajo", "iperc"].includes(m.modulo) ? true : m.asignado,
        nivel: m.nivel,
      })),
      motivo: "spec e2e: Lectura con Órdenes de Trabajo e IPERC",
    },
  });
  expect(habilitar.status(), await habilitar.text()).toBe(200);

  const irAOrdenes = (p: Page) =>
    p
      .getByRole("button", { name: /^Órdenes de Trabajo$/ })
      .first()
      .click();
  const irAIperc = (p: Page) =>
    p
      .getByRole("button", { name: /^IPERC$/ })
      .first()
      .click();

  const contexto = await browser.newContext();
  const lectura = await contexto.newPage();
  try {
    // ── Admin: ve los botones ──
    await irAOrdenes(page);
    const filaOrden = page.getByRole("row", { name: new RegExp(activo) });
    await expect(filaOrden).toBeVisible({ timeout: 20_000 });
    await expect(filaOrden.getByRole("button", { name: "Iniciar" })).toBeVisible();
    await expect(filaOrden.getByRole("button", { name: "Cancelar" })).toBeVisible();

    await irAIperc(page);
    const filaIperc = page.getByRole("row", { name: new RegExp(areaIperc) });
    await expect(filaIperc.getByRole("button", { name: "Aprobar" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Líneas Base" }).click();
    const filaLb = page.getByRole("row", { name: new RegExp(procesoLb) });
    await expect(filaLb.getByRole("button", { name: "Aprobar" })).toBeVisible();

    // ── Lectura: ve las filas, pero ningún botón de acciones ni el texto suelto ──
    await lectura.goto("/");
    await lectura.getByLabel("Correo").fill(email);
    await lectura.getByLabel("Contraseña").fill(temporal);
    await lectura.getByRole("button", { name: "Ingresar" }).click();
    await lectura.locator("#passwordActual").fill(temporal);
    await lectura.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await lectura.locator("#confirmacion").fill(`${temporal}Nueva`);
    await lectura.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(lectura.getByRole("button", { name: "Dashboard" })).toBeVisible();

    await irAOrdenes(lectura);
    const ordenLectura = lectura.getByRole("row", { name: new RegExp(activo) });
    await expect(ordenLectura).toBeVisible({ timeout: 20_000 });
    for (const boton of ["Iniciar", "Completar", "Cancelar"]) {
      await expect(ordenLectura.getByRole("button", { name: boton })).toHaveCount(0);
    }
    await expect(lectura.getByText("puedeEscribir")).toHaveCount(0);

    await irAIperc(lectura);
    const ipercLectura = lectura.getByRole("row", { name: new RegExp(areaIperc) });
    await expect(ipercLectura).toBeVisible({ timeout: 20_000 });
    for (const boton of ["Aprobar", "Rechazar"]) {
      await expect(ipercLectura.getByRole("button", { name: boton })).toHaveCount(0);
    }
    await lectura.getByRole("button", { name: "Líneas Base" }).click();
    const lbLectura = lectura.getByRole("row", { name: new RegExp(procesoLb) });
    await expect(lbLectura).toBeVisible();
    for (const boton of ["Aprobar", "Rechazar"]) {
      await expect(lbLectura.getByRole("button", { name: boton })).toHaveCount(0);
    }
    await expect(lectura.getByText("puedeEscribir")).toHaveCount(0);
  } finally {
    await contexto.close();
    await page.request.delete(`/api/erp/ordenes_trabajo/${ordenId}`);
    await page.request.delete(`/api/erp/iperc/${ipercId}`);
    await page.request.delete(`/api/erp/iperc/lineas-base/${lineaBaseId}`);
    await page.request.patch(`/api/erp/usuarios/${usuarioId}/estado`, {
      data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
    });
  }
});
