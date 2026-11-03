/** e2e/flota-consumo-viaje.spec.ts
 *
 * "Consumo por viaje" dentro de Viajes (antes, una vista del Histórico de Combustible y
 * otra del de Urea). Lo que se fija:
 *   - quien ve Viajes ve la pestaña "Consumo por viaje", con su período y su selector de
 *     producto, y la consulta responde bien (combustible y urea);
 *   - el Histórico de Combustible ya no la ofrece;
 *   - a quien se le niega el permiso `viajes:consumo` le queda Viajes sin esa pestaña.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { darDeBajaAlConductor, prepararViajeDeConductor } from "./fixtures/conductorConViaje";
import { adminA } from "./fixtures/entorno";

const grupoFlota = (page: Page) =>
  page.getByRole("button", { name: /^Gestión operacional de flota Abrir submenú$/ });

const respuestaDeConsumo = (page: Page, producto: string) =>
  page.waitForResponse(
    (r) =>
      r.url().includes("/api/erp/viajes/consumo") &&
      r.url().includes(`producto=${producto}`) &&
      r.request().method() === "GET"
  );

test("el administrador ve Consumo por viaje dentro de Viajes y consulta combustible y urea", async ({
  page,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await grupoFlota(page).click();
  await page.getByRole("button", { name: "Viajes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Viajes" })).toBeVisible();

  const respuestaInicial = respuestaDeConsumo(page, "combustible");
  await page.getByRole("tab", { name: "Consumo por viaje" }).click();
  expect((await respuestaInicial).status()).toBe(200);
  await expect(page.getByLabel("Desde")).toBeVisible();
  await expect(page.getByLabel("Hasta")).toBeVisible();

  // El período se aplica con "Consultar" y vuelve a pedir el consumo.
  const alConsultar = respuestaDeConsumo(page, "combustible");
  await page.getByRole("button", { name: "Consultar" }).click();
  expect((await alConsultar).status()).toBe(200);

  // Cambiar el producto pide el de urea.
  const deUrea = respuestaDeConsumo(page, "urea");
  await page.getByLabel("Producto").selectOption("urea");
  expect((await deUrea).status()).toBe(200);

  // Y se puede volver a la lista de viajes.
  await page.getByRole("tab", { name: "Viajes" }).click();
  await expect(page.getByRole("heading", { name: "Viajes" })).toBeVisible();
});

test("el Histórico de Combustible ya no ofrece Consumo por viaje", async ({ page }) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Histórico" }).click();
  // Las vistas que sí siguen están (prueba que el selector se pintó)...
  await expect(page.getByRole("option", { name: /Ranking de consumo por conductor/ })).toHaveCount(
    1
  );
  // ...y la de viaje se fue.
  await expect(page.getByRole("option", { name: /Consumo por viaje/ })).toHaveCount(0);
});

test("a quien se le niega `viajes:consumo` le queda Viajes sin la pestaña de consumo", async ({
  page,
  browser,
}) => {
  const marca = randomBytes(3).toString("hex");
  const email = `sin-consumo-${marca}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Sin consumo ${marca}`, email, password: temporal, rol: "operador" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  const usuarioId = (await alta.json()).id as string;
  try {
    const actuales = await (
      await page.request.get(`/api/erp/usuarios/${usuarioId}/permisos`)
    ).json();
    const cambiar = await page.request.put(`/api/erp/usuarios/${usuarioId}/permisos`, {
      data: {
        modulos: actuales.modulos.map(
          (m: { modulo: string; asignado: boolean; nivel: string }) => ({
            modulo: m.modulo,
            asignado: m.asignado,
            nivel: m.nivel,
          })
        ),
        pestanas: [{ modulo: "combustible", pestana: "viajes:consumo", permitido: false }],
        motivo: "spec e2e: sin Consumo por viaje",
      },
    });
    expect(cambiar.status(), await cambiar.text()).toBe(200);

    const contexto = await browser.newContext();
    const operador = await contexto.newPage();
    try {
      await operador.goto("/");
      await operador.getByLabel("Correo").fill(email);
      await operador.getByLabel("Contraseña").fill(temporal);
      await operador.getByRole("button", { name: "Ingresar" }).click();
      await operador.locator("#passwordActual").fill(temporal);
      await operador.locator("#passwordNueva").fill(`${temporal}Nueva`);
      await operador.locator("#confirmacion").fill(`${temporal}Nueva`);
      await operador.getByRole("button", { name: "Guardar y continuar" }).click();
      await expect(operador.getByRole("button", { name: "Dashboard" })).toBeVisible();

      await grupoFlota(operador).click();
      await operador.getByRole("button", { name: "Viajes", exact: true }).click();
      await expect(operador.getByRole("heading", { name: "Viajes" })).toBeVisible();
      await expect(operador.getByRole("tab", { name: "Consumo por viaje" })).toHaveCount(0);
    } finally {
      await contexto.close();
    }
  } finally {
    await page.request.patch(`/api/erp/usuarios/${usuarioId}/estado`, {
      data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
    });
  }
});

test("un conductor al que se le dio `viajes:consumo` a mano ve Viajes con la pestaña de consumo", async ({
  page,
  browser,
}) => {
  const v = await prepararViajeDeConductor(page);
  const usuarios = (await (await page.request.get("/api/erp/usuarios")).json()).data as {
    id: string;
    dni: string;
  }[];
  const conductorId = usuarios.find((u) => u.dni === v.dni)!.id;
  const actuales = await (
    await page.request.get(`/api/erp/usuarios/${conductorId}/permisos`)
  ).json();
  const dar = await page.request.put(`/api/erp/usuarios/${conductorId}/permisos`, {
    data: {
      modulos: actuales.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: m.asignado,
        nivel: m.nivel,
      })),
      pestanas: [{ modulo: "combustible", pestana: "viajes:consumo", permitido: true }],
      motivo: "spec e2e: conductor con Consumo por viaje",
    },
  });
  expect(dar.status(), await dar.text()).toBe(200);

  const contexto = await browser.newContext();
  const conductor = await contexto.newPage();
  try {
    const login = await conductor.request.post("/api/auth/login", {
      data: { identificador: v.dni, password: v.password },
    });
    expect(login.status()).toBe(200);
    await conductor.goto("/");
    const nueva = `Nueva-${v.marca}-7y`;
    await conductor.getByLabel("Contraseña temporal").fill(v.password);
    await conductor.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
    await conductor.getByLabel("Confirmar nueva contraseña").fill(nueva);
    await conductor.getByRole("button", { name: "Guardar y continuar" }).click();

    // El menú y el servidor coinciden: aparece el grupo de Flota con Viajes y su consumo.
    await grupoFlota(conductor).click();
    await expect(conductor.getByRole("heading", { name: "Viajes" })).toBeVisible();
    const consumo = respuestaDeConsumo(conductor, "combustible");
    await conductor.getByRole("tab", { name: "Consumo por viaje" }).click();
    expect((await consumo).status()).toBe(200);
  } finally {
    await contexto.close();
    await darDeBajaAlConductor(page, v);
  }
});
