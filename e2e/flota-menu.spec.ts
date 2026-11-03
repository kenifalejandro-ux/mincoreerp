/** e2e/flota-menu.spec.ts
 *
 * El grupo "Gestión operacional de flota" del menú lateral: Registro de unidades
 * (lo que antes era Equipos) y Viajes, que salió del submenú de Combustible.
 *
 * Lo que se fija:
 *   - el administrador ve el grupo con sus dos ítems, y cada uno abre su pantalla;
 *   - Viajes ya no está dentro del submenú de Combustible;
 *   - quien tiene solo el módulo Viajes (sin Registro de unidades) ve el grupo con
 *     un único ítem, y tocar el grupo lo lleva a Viajes;
 *   - el conductor no ve el grupo: sus pantallas (Mi viaje, Compra en ruta, Tanquetas) van sueltas, sin el encabezado Combustible.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";
import { adminA } from "./fixtures/entorno";

const grupoFlota = (page: Page) =>
  page.getByRole("button", { name: /^Gestión operacional de flota Abrir submenú$/ });
const grupoCombustible = (page: Page) =>
  page.getByRole("button", { name: /^Combustible Abrir submenú$/ });

test("el administrador ve el grupo de Flota con Registro de unidades y Viajes, y cada ítem abre lo suyo", async ({
  page,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await grupoFlota(page).click();
  await expect(page.getByRole("button", { name: "Registro de unidades" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Viajes", exact: true })).toBeVisible();
  // Al tocar el grupo se abre su primer ítem: la pantalla de siempre de Equipos, con su título nuevo.
  await expect(page.getByRole("heading", { name: "Registro de unidades" })).toBeVisible();

  await page.getByRole("button", { name: "Viajes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Viajes" })).toBeVisible();

  await page.getByRole("button", { name: "Registro de unidades" }).click();
  await expect(page.getByRole("heading", { name: "Registro de unidades" })).toBeVisible();
});

test("Viajes ya no está en el submenú de Combustible (solo en Flota) y Combustible sigue completo", async ({
  page,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  await grupoCombustible(page).click();
  await expect(page.getByRole("button", { name: "Tanquetas" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Histórico" })).toBeVisible();
  // Con los dos grupos abiertos, un solo botón "Viajes" en todo el menú: el del grupo de Flota.
  await grupoFlota(page).click();
  await expect(page.getByRole("button", { name: "Viajes", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Tanquetas" }).click();
  await expect(page.getByRole("heading", { name: "Control de Combustible" })).toBeVisible();
});

/** Un operador nuevo al que se le asignan solo los módulos pedidos (el resto se apaga). */
async function operadorConModulos(
  page: Page,
  asignados: string[]
): Promise<{ usuarioId: string; email: string; temporal: string }> {
  const marca = randomBytes(3).toString("hex");
  const email = `operador-flota-${marca}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Operador ${marca}`, email, password: temporal, rol: "operador" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  const usuarioId = (await alta.json()).id as string;
  const actuales = await (await page.request.get(`/api/erp/usuarios/${usuarioId}/permisos`)).json();
  const cambiar = await page.request.put(`/api/erp/usuarios/${usuarioId}/permisos`, {
    data: {
      modulos: actuales.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: asignados.includes(m.modulo),
        nivel: m.nivel,
      })),
      pestanas: [],
      motivo: "spec e2e: módulos acotados",
    },
  });
  expect(cambiar.status(), await cambiar.text()).toBe(200);
  return { usuarioId, email, temporal };
}

/** Entra por la interfaz con la clave temporal (que obliga a cambiarla). */
async function entrarConClaveTemporal(
  browser: Browser,
  email: string,
  temporal: string
): Promise<{ contexto: BrowserContext; pagina: Page }> {
  const contexto = await browser.newContext();
  const pagina = await contexto.newPage();
  await pagina.goto("/");
  await pagina.getByLabel("Correo").fill(email);
  await pagina.getByLabel("Contraseña").fill(temporal);
  await pagina.getByRole("button", { name: "Ingresar" }).click();
  await pagina.locator("#passwordActual").fill(temporal);
  await pagina.locator("#passwordNueva").fill(`${temporal}Nueva`);
  await pagina.locator("#confirmacion").fill(`${temporal}Nueva`);
  await pagina.getByRole("button", { name: "Guardar y continuar" }).click();
  return { contexto, pagina };
}

const darDeBaja = (page: Page, usuarioId: string) =>
  page.request.patch(`/api/erp/usuarios/${usuarioId}/estado`, {
    data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
  });

test("quien tiene Viajes y Combustible pero no Flota ve el grupo con un único ítem, y su lista de viajes CARGA", async ({
  page,
  browser,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const u = await operadorConModulos(page, ["dashboard", "combustible", "viajes"]);
  try {
    const { contexto, pagina } = await entrarConClaveTemporal(browser, u.email, u.temporal);
    try {
      await expect(pagina.getByRole("button", { name: "Dashboard" })).toBeVisible();
      // La lista de viajes responde 200 (no basta con que se pinte el título).
      const lista = pagina.waitForResponse(
        (r) => /\/api\/erp\/viajes(\?|$)/.test(r.url()) && r.request().method() === "GET"
      );
      await grupoFlota(pagina).click();
      expect((await lista).status()).toBe(200);
      await expect(pagina.getByRole("heading", { name: "Viajes" })).toBeVisible();
      await expect(pagina.getByRole("button", { name: "Viajes", exact: true })).toBeVisible();
      await expect(pagina.getByRole("button", { name: "Registro de unidades" })).toHaveCount(0);
    } finally {
      await contexto.close();
    }
  } finally {
    await darDeBaja(page, u.usuarioId);
  }
});

test("quien tiene Viajes pero NO Combustible no ve el grupo de Flota (el servidor le daría 403 en la lista)", async ({
  page,
  browser,
}) => {
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const u = await operadorConModulos(page, ["dashboard", "viajes"]);
  try {
    const { contexto, pagina } = await entrarConClaveTemporal(browser, u.email, u.temporal);
    try {
      await expect(pagina.getByRole("button", { name: "Dashboard" })).toBeVisible();
      await expect(grupoFlota(pagina)).toHaveCount(0);
      await expect(pagina.getByRole("button", { name: "Viajes", exact: true })).toHaveCount(0);
    } finally {
      await contexto.close();
    }
  } finally {
    await darDeBaja(page, u.usuarioId);
  }
});

test("el conductor no ve el grupo de Flota ni el de Combustible: sus pantallas van sueltas", async ({
  page,
  browser,
}) => {
  const v = await prepararViajeDeConductor(page);
  const contexto = await browser.newContext();
  const conductor = await contexto.newPage();
  try {
    await entrarAMiViaje(conductor, v);
    await expect(conductor.getByRole("heading", { name: "Mi viaje" })).toBeVisible();
    await expect(grupoFlota(conductor)).toHaveCount(0);
    await expect(conductor.getByRole("button", { name: "Registro de unidades" })).toHaveCount(0);
    // Sus pantallas van sueltas, sin el encabezado "Combustible" ni su submenú.
    await expect(grupoCombustible(conductor)).toHaveCount(0);
    for (const nombre of ["Mi viaje", "Compra en ruta", "Tanquetas"]) {
      await expect(conductor.getByRole("button", { name: nombre, exact: true })).toBeVisible();
    }
    await expect(conductor.getByRole("button", { name: "Tanques", exact: true })).toHaveCount(0);
    // El ítem de la pantalla abierta queda marcado (Mi viaje es con lo que abre).
    await expect(conductor.getByRole("button", { name: "Mi viaje", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    );
  } finally {
    await contexto.close();
    await darDeBajaAlConductor(page, v);
  }
});

test("un conductor cuya empresa no le da el módulo Viajes no ve Mi viaje (la pantalla daría 403)", async ({
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
  const quitar = await page.request.put(`/api/erp/usuarios/${conductorId}/permisos`, {
    data: {
      modulos: actuales.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: m.modulo === "viajes" ? false : m.asignado,
        nivel: m.nivel,
      })),
      pestanas: [],
      motivo: "spec e2e: conductor sin Viajes",
    },
  });
  expect(quitar.status(), await quitar.text()).toBe(200);

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

    await expect(conductor.getByRole("button", { name: "Tanquetas", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(conductor.getByRole("button", { name: "Compra en ruta" })).toBeVisible();
    await expect(conductor.getByRole("button", { name: "Mi viaje" })).toHaveCount(0);
  } finally {
    await contexto.close();
    await darDeBajaAlConductor(page, v);
  }
});
