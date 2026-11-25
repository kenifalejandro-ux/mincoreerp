/** e2e/ordenes-trabajo-horas-tareas.spec.ts
 *
 * Horas, «la unidad no puede operar» y tareas de la orden de trabajo (E5-5), en el navegador:
 *
 * 1. La oficina crea una orden con todo, la completa, corrige las horas de un trabajo pasado y maneja las tareas.
 * 2. Sin señal: la orden con sus tareas queda en el equipo y entra una sola vez; cambiarla después pide señal.
 * 3. El perfil Lectura ve las horas y las tareas sin ningún botón para cambiarlas.
 *
 * Cada test crea su propia empresa, solo con Órdenes de trabajo.
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez, type EmpresaSola } from "./fixtures/empresaSola";

const API = "/api/erp/ordenes_trabajo";

/** El valor de un <input type="datetime-local"> de hace `horas` horas, en la hora del equipo. */
function hace(horas: number): string {
  const d = new Date(Date.now() - horas * 3_600_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** Acepta todos los avisos del navegador y los va guardando. */
function escucharAvisos(page: Page): string[] {
  const avisos: string[] = [];
  page.on("dialog", (d) => {
    avisos.push(d.message());
    void d.accept();
  });
  return avisos;
}

const botonNueva = (page: Page) => page.getByRole("button", { name: "+ Nueva Orden de Trabajo" });
const abrirDetalle = (page: Page) =>
  page.getByRole("button", { name: /^Horas y tareas de la orden/ }).click();
const ventana = (page: Page) => page.getByRole("dialog", { name: /^Horas y tareas/ });
const ordenes = async (page: Page) =>
  (await (await page.request.get(`${API}?pageSize=50`)).json()).data as Record<string, unknown>[];

async function entrar(page: Page, empresa: EmpresaSola, listo = botonNueva(page)): Promise<void> {
  await entrarPorPrimeraVez(page, empresa, listo);
}

async function llenarAlta(page: Page, titulo: string) {
  await botonNueva(page).click();
  await page.getByLabel(/^Activo o lugar/).fill("Horno 4");
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page.getByLabel("Hora de inicio").fill(hace(5));
  await page.getByLabel("La unidad no puede operar").check();
  await page.getByLabel("Nueva tarea").fill("Desmontar ruedas");
  // Enter agrega la tarea; no envía la orden.
  await page.getByLabel("Nueva tarea").press("Enter");
  // La segunda queda escrita sin «Agregar»: también cuenta.
  await page.getByLabel("Nueva tarea").fill("Cambiar pastillas");
}

test("la oficina anota las horas de un trabajo pasado y maneja las tareas", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, "ordenes_trabajo", "horas");
  await entrar(page, empresa);
  escucharAvisos(page);

  await llenarAlta(page, "Cambiar frenos");
  await page.getByRole("button", { name: "Registrar Orden de Trabajo" }).click();
  await expect(page.getByText("No puede operar")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("(0/2)")).toBeVisible();

  await page.getByRole("button", { name: "Iniciar" }).click();
  await page.getByRole("button", { name: "Completar" }).click();
  await expect(page.getByText(/Duración: 5 h/)).toBeVisible();

  await abrirDetalle(page);
  const d = ventana(page);
  await d.getByRole("checkbox", { name: "Desmontar ruedas" }).check();
  await expect(d.getByText("Tareas (1/2)")).toBeVisible();
  await d.getByLabel("Nueva tarea").fill("Probar frenado");
  await d.getByRole("button", { name: "Agregar" }).click();
  await expect(d.getByText("Tareas (1/3)")).toBeVisible();
  await d.getByRole("button", { name: "Quitar tarea: Cambiar pastillas" }).click();
  await expect(d.getByText("Tareas (1/2)")).toBeVisible();

  // Horas cruzadas: no se guardan.
  await d.getByLabel("Hora de inicio").fill(hace(1));
  await d.getByLabel("Hora de cierre").fill(hace(3));
  await d.getByRole("button", { name: "Guardar horas" }).click();
  await expect(d.getByRole("alert")).toContainText("posterior");
  await d.getByLabel("Hora de inicio").fill(hace(6));
  await d.getByLabel("La unidad no puede operar").uncheck();
  await d.getByRole("button", { name: "Guardar horas" }).click();
  await expect(d.getByRole("status")).toContainText("Guardado");
  await expect(d.getByText("Duración:")).toContainText("3 h");

  await d.getByRole("button", { name: "Cerrar" }).click();
  await expect(page.getByText("No puede operar")).toHaveCount(0);
  await expect(page.getByText("(1/2)")).toBeVisible();
  expect((await ordenes(page))[0]).toMatchObject({
    unidad_no_opera: false,
    duracion_minutos: 180,
    tareas_total: 2,
    tareas_hechas: 1,
  });
});

test("sin señal: la orden con sus tareas entra una sola vez; cambiarla pide señal", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, "ordenes_trabajo", "horas-off");
  await entrar(page, empresa);
  const avisos = escucharAvisos(page);

  await context.setOffline(true);
  await llenarAlta(page, `Sin señal ${randomBytes(2).toString("hex")}`);
  await page.getByRole("button", { name: "Registrar Orden de Trabajo" }).click();
  await expect.poll(() => avisos.join(" ")).toContain("Sin conexión");

  await context.setOffline(false);
  await expect(page.getByText("(0/2)")).toBeVisible({ timeout: 45_000 });
  const lista = await ordenes(page);
  expect(lista).toHaveLength(1);
  expect(lista[0]).toMatchObject({ unidad_no_opera: true, tareas_total: 2 });
  expect(lista[0].inicio_en).not.toBeNull();

  await abrirDetalle(page);
  const d = ventana(page);
  const casilla = d.getByRole("checkbox", { name: "Desmontar ruedas" });
  await expect(casilla).toBeVisible();
  await context.setOffline(true);
  await casilla.click();
  await expect(d.getByRole("alert")).toContainText("necesitan señal");
  // La casilla vuelve a como estaba.
  await expect(casilla).not.toBeChecked();
  await context.setOffline(false);
});

test("Lectura ve las horas y las tareas sin botones para cambiarlas", async ({ page, request }) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const empresa = await crearEmpresaSola(request, "ordenes_trabajo", "horas-lec");
  await entrar(page, empresa);
  const creada = await page.request.post(API, {
    data: { activo_texto: "Horno 4", titulo: "Solo mirar", tareas: [{ descripcion: "Revisar" }] },
  });
  expect(creada.status(), await creada.text()).toBe(201);

  const dni = `94${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
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
  await page.goto("/");
  const nueva = `Nueva-${marca}-7y`;
  await page.getByLabel("Contraseña temporal").fill(password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
  await page.getByLabel("Confirmar nueva contraseña").fill(nueva);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();

  await expect(page.getByRole("cell", { name: /Solo mirar/ })).toBeVisible({ timeout: 20_000 });
  await expect(botonNueva(page)).toHaveCount(0);
  await abrirDetalle(page);
  const d = ventana(page);
  await expect(d.getByRole("checkbox", { name: "Revisar" })).toBeDisabled();
  await expect(d.getByLabel("Hora de inicio")).toBeDisabled();
  await expect(d.getByRole("button", { name: "Guardar horas" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Agregar" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: /^Quitar tarea/ })).toHaveCount(0);
});
