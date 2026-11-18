/** e2e/dashboard-por-modulo.spec.ts
 *
 * El Dashboard muestra solo las tarjetas, los gráficos y las secciones de los módulos que tiene
 * quien lo mira (Repuestos, Combustible, Documentos). Un usuario al que solo le dieron Checklists no
 * ve ninguno y recibe un aviso en vez de una pantalla vacía; el admin, que tiene todo, sí los ve.
 */
import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("un usuario sin Repuestos, Combustible ni Documentos no ve sus tarjetas y ve un aviso; el admin las ve", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  // ── Admin: ve las tarjetas y secciones de los tres módulos ──
  await expect(page.getByText("Documentación Legal", { exact: true })).toBeVisible();
  await expect(page.getByText("Stock Crítico", { exact: true })).toBeVisible();
  await expect(page.getByText("Nivel del tanque principal", { exact: true })).toBeVisible();
  await expect(page.getByText("Aún no hay indicadores")).toHaveCount(0);

  // ── Usuario con solo Checklists ──
  const email = `dash-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Solo checklists ${marca}`, email, password: temporal, rol: "operador" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  const usuarioId = (await alta.json()).id as string;
  const actuales = await (await page.request.get(`/api/erp/usuarios/${usuarioId}/permisos`)).json();
  const soloChecklists = await page.request.put(`/api/erp/usuarios/${usuarioId}/permisos`, {
    data: {
      modulos: actuales.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: ["dashboard", "checklists"].includes(m.modulo),
        nivel: m.nivel,
      })),
      motivo: "spec e2e: usuario solo con Checklists",
    },
  });
  expect(soloChecklists.status(), await soloChecklists.text()).toBe(200);

  const contexto = await browser.newContext();
  const otro = await contexto.newPage();
  try {
    await otro.goto("/");
    await otro.getByLabel("Correo").fill(email);
    await otro.getByLabel("Contraseña").fill(temporal);
    await otro.getByRole("button", { name: "Ingresar" }).click();
    await otro.locator("#passwordActual").fill(temporal);
    await otro.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await otro.locator("#confirmacion").fill(`${temporal}Nueva`);
    await otro.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(otro.getByRole("button", { name: "Dashboard" })).toBeVisible();

    await expect(
      otro.getByText("Aún no hay indicadores para los módulos de tu empresa.")
    ).toBeVisible({ timeout: 20_000 });
    for (const texto of [
      "Documentación Legal",
      "Stock Crítico",
      "Inventario en Riesgo",
      "Nivel del tanque principal",
    ]) {
      await expect(otro.getByText(texto, { exact: true }), texto).toHaveCount(0);
    }
  } finally {
    await contexto.close();
    await page.request.patch(`/api/erp/usuarios/${usuarioId}/estado`, {
      data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
    });
  }
});
