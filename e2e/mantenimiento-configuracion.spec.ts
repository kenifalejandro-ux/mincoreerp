/** e2e/mantenimiento-configuracion.spec.ts
 *
 * M2: la pantalla «Configuración» del ecosistema «Gestión de mantenimiento», con una empresa que tiene SOLO el
 * módulo `mantenimiento`.
 *
 * 1. Salen las reglas y las metas de la maqueta con sus valores por defecto; cada regla avisa que aún no actúa.
 * 2. Cada cambio se guarda al momento y sigue ahí al volver; una meta inválida no se guarda y dice por qué.
 * 3. Si el guardado falla, el valor vuelve atrás; si la carga falla, no hay controles hasta reintentar.
 * 4. Quien no es admin ve las reglas y metas apagadas, pero un operador sí maneja las áreas.
 * 5. En un celular la pantalla no se sale de ancho.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

// Sin service worker: así `page.route` puede simular los fallos del servidor.
test.use({ serviceWorkers: "block" });

const menuDe = (page: Page) =>
  page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
const abrirSeccion = (page: Page, nombre: string) =>
  menuDe(page)
    .getByRole("button", { name: new RegExp(`^${nombre}`) })
    .click();
const regla = (page: Page, nombre: RegExp) => page.getByRole("switch", { name: nombre });
const meta = (page: Page, nombre: RegExp) => page.getByRole("textbox", { name: nombre });

test("las reglas y las metas se ven, se guardan solas y aguantan los fallos", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "config");
  await entrarPorPrimeraVez(page, empresa, menuDe(page));
  await expect(menuDe(page).getByRole("button", { name: /^Configuración.*Nuevo/ })).toBeVisible();
  await abrirSeccion(page, "Configuración");
  await expect(
    page.getByRole("heading", { name: "Configuración del ecosistema", level: 1 })
  ).toBeVisible();

  // ── 1. Valores por defecto de la maqueta ──────────────────────────────
  const hallazgo = regla(page, /hallazgo crítico/);
  const conformidad = regla(page, /Exigir conformidad/);
  await expect(hallazgo).toHaveAttribute("aria-checked", "true");
  await expect(regla(page, /sin IPERC/)).toHaveAttribute("aria-checked", "true");
  await expect(regla(page, /falten repuestos/)).toHaveAttribute("aria-checked", "true");
  await expect(conformidad).toHaveAttribute("aria-checked", "false");
  await expect(meta(page, /Disponibilidad mínima/)).toHaveValue("90");
  await expect(meta(page, /Cumplimiento del preventivo/)).toHaveValue("90");
  await expect(meta(page, /MTTR/)).toHaveValue("24");
  await expect(meta(page, /MTBF/)).toHaveValue("300");
  await expect(page.getByText(/Aún no actúa/)).toHaveCount(4);
  await expect(page.getByText(/Necesita el módulo Almacén/).first()).toBeVisible();

  // ── 2. Se guarda al momento y sigue al volver ─────────────────────────
  await conformidad.click();
  await expect(conformidad).toHaveAttribute("aria-checked", "true");
  await expect(conformidad).toBeEnabled();
  const disponibilidad = meta(page, /Disponibilidad mínima/);
  await disponibilidad.fill("85");
  await disponibilidad.press("Enter");
  await expect(disponibilidad).toBeEnabled();

  // Una meta inválida no se guarda: dice por qué y vuelve a lo guardado.
  await disponibilidad.fill("101");
  await disponibilidad.press("Enter");
  await expect(page.getByRole("alert")).toContainText("entre 1 y 100");
  await expect(disponibilidad).toHaveValue("85");

  await abrirSeccion(page, "Centro de mantenimiento");
  await abrirSeccion(page, "Configuración");
  await expect(conformidad).toHaveAttribute("aria-checked", "true");
  await expect(disponibilidad).toHaveValue("85");
  const guardado = await (await page.request.get("/api/erp/mantenimiento/config")).json();
  expect(guardado).toMatchObject({ exige_conformidad: true, meta_disponibilidad: 85 });

  // El Centro se vuelve a leer al entrar: un equipo registrado por otro lado aparece sin recargar.
  const equipo = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: { placa_codigo: "CTR-001", tipo: "Volquete" },
  });
  expect(equipo.status(), await equipo.text()).toBe(201);
  await abrirSeccion(page, "Centro de mantenimiento");
  const resumen = page.getByRole("region", { name: "Resumen del mantenimiento" });
  await expect(resumen).toContainText("Equipos registrados1");
  await expect(resumen).toContainText("1 propio · 0 alquilados");
  await abrirSeccion(page, "Configuración");

  // ── 3. Fallos ─────────────────────────────────────────────────────────
  const fallar = (metodo: string) =>
    page.route("**/api/erp/mantenimiento/config", (ruta) =>
      ruta.request().method() === metodo
        ? ruta.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "Fallo simulado" }),
          })
        : ruta.continue()
    );
  await fallar("PUT");
  await hallazgo.click();
  await expect(page.getByRole("alert")).toContainText("Fallo simulado");
  await expect(hallazgo).toHaveAttribute("aria-checked", "true");
  await page.unroute("**/api/erp/mantenimiento/config");

  await fallar("GET");
  await abrirSeccion(page, "Centro de mantenimiento");
  await abrirSeccion(page, "Configuración");
  await expect(page.getByRole("alert")).toContainText("No se pudieron leer las reglas y metas");
  await expect(page.getByRole("switch")).toHaveCount(0);
  await page.unroute("**/api/erp/mantenimiento/config");
  await page.getByRole("button", { name: "Reintentar" }).click();
  await expect(page.getByRole("switch")).toHaveCount(4);

  // ── 5. En un celular no se sale de ancho ──────────────────────────────
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(disponibilidad).toBeVisible();
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(ancho).toBeLessThanOrEqual(393);
});

test("un operador ve las reglas apagadas y sí maneja las áreas", async ({ page, request }) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const empresa = await crearEmpresaSola(request, "mantenimiento", "config-op");
  await entrarPorPrimeraVez(page, empresa, menuDe(page));

  const dni = `94${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const password = `Operador-${marca}-9x`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Operador ${marca}`, dni, password, rol: "operador" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: dni, password },
  });
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/mantenimiento/configuracion");
  const nueva = `Nueva-${marca}-7y`;
  await page.getByLabel("Contraseña temporal").fill(password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
  await page.getByLabel("Confirmar nueva contraseña").fill(nueva);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();

  await expect(
    page.getByRole("heading", { name: "Configuración del ecosistema", level: 1 })
  ).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText("Solo el administrador puede cambiar")).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(4);
  for (const interruptor of await page.getByRole("switch").all()) {
    await expect(interruptor).toBeDisabled();
  }
  await expect(meta(page, /Disponibilidad mínima/)).toBeDisabled();

  const areas = page.getByRole("region", { name: "Áreas" });
  await areas.getByPlaceholder("Nueva área (ej. Cantera Sur)").fill("Taller");
  await areas.getByRole("button", { name: "Agregar" }).click();
  await expect(areas.getByRole("listitem")).toContainText("Taller");
});
