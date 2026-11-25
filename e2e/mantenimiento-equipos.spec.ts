/** e2e/mantenimiento-equipos.spec.ts
 *
 * Equipos y áreas del ecosistema «Gestión de mantenimiento» (M1, etapa 2), por navegador, con una empresa que
 * tiene SOLO el módulo `mantenimiento`.
 *
 * 1. Áreas (en Configuración): se agrega una, un nombre repetido se rechaza con su mensaje.
 * 2. Registrar un equipo: valida lo obligatorio, se guarda con su área y aparece en la lista; una placa repetida
 *    (aunque cambien las mayúsculas) se rechaza.
 * 3. Editar un equipo cambia lo que se manda; la lectura se ve pero no se edita.
 * 4. Un área con equipos no se puede quitar; quitar el equipo pide el motivo y lo saca de la lista; después el
 *    área sí se puede quitar.
 * 5. Lectura mira la lista pero no ve ninguno de los botones de escribir (y el servidor tampoco la deja).
 *
 * La empresa de cada test es nueva (no hay API para borrarlas): la base de los e2e es efímera en CI.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

/** Cambia de sección por el menú del ecosistema (recargar tras el cambio de clave la volvería a pedir). */
async function irA(page: Page, seccion: "Equipos" | "Configuración") {
  await page
    .getByRole("complementary", { name: "Menú de Gestión de mantenimiento" })
    .getByRole("button", { name: new RegExp(`^${seccion}`) })
    .click();
}

async function alEquipos(page: Page, empresa: Awaited<ReturnType<typeof crearEmpresaSola>>) {
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
  await entrarPorPrimeraVez(page, empresa, menu);
  await menu.getByRole("button", { name: "Equipos" }).click();
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();
}

test("registrar, editar y quitar equipos, y manejar las áreas", async ({ page, request }) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const placa = `AKM-${marca}`;
  const empresa = await crearEmpresaSola(request, "mantenimiento", "equipos");
  await alEquipos(page, empresa);
  const fila = (texto: string) => page.getByRole("row", { name: new RegExp(texto) });

  // ── 1. Áreas (en Configuración, como en la maqueta) ──────────────────
  await expect(page.getByRole("button", { name: "Áreas" })).toHaveCount(0);
  await irA(page, "Configuración");
  const areas = page.getByRole("region", { name: "Áreas" });
  await expect(areas.getByText("Todavía no hay áreas")).toBeVisible();
  await areas.getByPlaceholder("Nueva área (ej. Cantera Sur)").fill("Cantera");
  await areas.getByRole("button", { name: "Agregar" }).click();
  await expect(areas.getByRole("listitem")).toContainText("0 equipos");
  await areas.getByPlaceholder("Nueva área (ej. Cantera Sur)").fill("cantera");
  await areas.getByRole("button", { name: "Agregar" }).click();
  await expect(areas.getByRole("alert")).toContainText("Ya hay un área llamada");
  await irA(page, "Equipos");

  // ── 2. Registrar un equipo ───────────────────────────────────────────
  await page.getByRole("button", { name: "Nuevo equipo" }).click();
  const formulario = page.getByRole("dialog", { name: "Registrar equipo" });
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario.getByRole("alert")).toContainText("Escribe la placa o el código");
  await formulario.getByLabel("Placa o código").fill(placa);
  await formulario.getByLabel("Tipo de equipo").fill("Volquete");
  await formulario.getByLabel("Marca").fill("VOLVO");
  await formulario.getByLabel("Lectura inicial").fill("1234.5");
  await formulario.getByLabel("Área").selectOption({ label: "Cantera" });
  await formulario.getByRole("button", { name: "Guardar" }).click();
  await expect(formulario).toBeHidden();
  await expect(fila(placa)).toContainText("Cantera");
  await expect(fila(placa)).toContainText("1,234.5 h");

  // Una placa repetida se rechaza aunque cambien las mayúsculas.
  await page.getByRole("button", { name: "Nuevo equipo" }).click();
  const repetido = page.getByRole("dialog", { name: "Registrar equipo" });
  await repetido.getByLabel("Placa o código").fill(placa.toLowerCase());
  await repetido.getByLabel("Tipo de equipo").fill("Volquete");
  await repetido.getByRole("button", { name: "Guardar" }).click();
  await expect(repetido.getByRole("alert")).toContainText("Ya hay un equipo con la placa");
  await repetido.getByRole("button", { name: "Cancelar" }).click();
  await expect(fila(placa)).toHaveCount(1);

  // ── 3. Editar ────────────────────────────────────────────────────────
  await page.getByRole("button", { name: `Editar el equipo ${placa}` }).click();
  const edicion = page.getByRole("dialog", { name: "Editar equipo" });
  await edicion.getByLabel("Tipo de equipo").fill("Camión");
  // La lectura no se edita aquí: se muestra la última, con la explicación de dónde se registra.
  await expect(edicion.getByText("1,234.5 h")).toBeVisible();
  await expect(edicion.getByText("Se registra al llenar un checklist")).toBeVisible();
  await expect(edicion.getByLabel("Lectura inicial")).toHaveCount(0);
  await edicion.getByRole("button", { name: "Guardar" }).click();
  await expect(edicion).toBeHidden();
  await expect(fila(placa)).toContainText("Camión");
  await expect(fila(placa)).toContainText("1,234.5 h");

  // ── 4. Un área con equipos no se quita; quitar el equipo pide motivo ─
  await irA(page, "Configuración");
  await expect(areas.getByRole("listitem")).toContainText("1 equipo");
  // Con equipos no se ofrece quitarla.
  await expect(areas.getByRole("button", { name: "Quitar el área Cantera" })).toHaveCount(0);
  await irA(page, "Equipos");

  await page.getByRole("button", { name: `Quitar el equipo ${placa}` }).click();
  const quitar = page.getByRole("dialog", { name: "Quitar equipo" });
  await quitar.getByRole("button", { name: "Quitar equipo" }).click();
  await expect(quitar.getByRole("alert")).toContainText("al menos 3 letras");
  await quitar.getByLabel("Motivo").fill("Se vendió");
  await quitar.getByRole("button", { name: "Quitar equipo" }).click();
  await expect(quitar).toBeHidden();
  await expect(page.getByText("Todavía no hay equipos registrados.")).toBeVisible();

  // Ahora el área sí se puede quitar.
  await irA(page, "Configuración");
  await areas.getByRole("button", { name: "Quitar el área Cantera" }).click();
  await expect(areas.getByText("Todavía no hay áreas")).toBeVisible();
});

test("Lectura ve los equipos pero ningún botón para escribir", async ({ page, request }) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const placa = `LEC-${marca}`;
  const empresa = await crearEmpresaSola(request, "mantenimiento", "lectura");
  await alEquipos(page, empresa);
  const creado = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: { placa_codigo: placa, tipo: "Volquete" },
  });
  expect(creado.status(), await creado.text()).toBe(201);

  const dni = `95${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const password = `Lectura-${marca}-9x`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Lectura ${marca}`, dni, password, rol: "lectura" },
  });
  expect(alta.status(), await alta.text()).toBe(201);

  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: dni, password },
  });
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/mantenimiento/equipos");
  const nueva = `Nueva-${marca}-7y`;
  await page.getByLabel("Contraseña temporal").fill(password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
  await page.getByLabel("Confirmar nueva contraseña").fill(nueva);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();

  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("row", { name: new RegExp(placa) })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuevo equipo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Editar el equipo ${placa}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Quitar el equipo ${placa}` })).toHaveCount(0);

  // En Configuración las áreas se ven, pero no se agregan ni se quitan; las reglas salen apagadas.
  await irA(page, "Configuración");
  const areas = page.getByRole("region", { name: "Áreas" });
  await expect(areas).toBeVisible();
  await expect(areas.getByRole("button", { name: "Agregar" })).toHaveCount(0);
  await expect(page.getByRole("switch").first()).toBeDisabled();

  // Y el servidor tampoco la deja escribir.
  const intento = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: { placa_codigo: `X-${marca}`, tipo: "Volquete" },
  });
  expect(intento.status()).toBe(403);
});
