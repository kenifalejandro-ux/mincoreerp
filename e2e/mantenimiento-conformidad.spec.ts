/** e2e/mantenimiento-conformidad.spec.ts
 *
 * Estados y conformidad de las órdenes dentro del ecosistema «Gestión de mantenimiento» (M8):
 *
 * 1. El administrador marca la casilla en Administración; el aviso de Configuración se va, el Centro lleva a
 *    las pendientes y quien la tiene libera la unidad.
 * 2. Iniciar, completar y cancelar desde el panel; un rechazo se dice y se relee; sin señal no cambia nada.
 * 3. Sin casilla, siendo el mecánico o con perfil Lectura no hay botón; quitada la casilla con la pantalla abierta, no firma.
 * 4. Con la regla apagada no aparece nada de conformidad; sin Órdenes de trabajo no se pregunta por ella.
 * 5. En el celular, con textos largos, nada se sale.
 *
 * Cada test crea su propia empresa (no hay API para borrarlas: la base de los e2e es efímera en CI).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez, type EmpresaSola } from "./fixtures/empresaSola";

const BASE = ["mantenimiento", "ordenes_trabajo"];
const API = "/api/erp/ordenes_trabajo";

const menu = (page: Page) =>
  page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
const irA = (page: Page, nombre: string) =>
  menu(page)
    .getByRole("button", { name: new RegExp(`^${nombre}`) })
    .click();
const filas = (page: Page) => page.locator("tbody tr");
const panel = (page: Page) => page.getByRole("dialog", { name: "Detalle de la orden" });
const boton = (page: Page, name: string) => panel(page).getByRole("button", { name, exact: true });
const verOrden = (page: Page, id: number) =>
  page.getByRole("button", { name: `Ver la orden ${id}`, exact: true }).click();
const porConformar = (page: Page) => page.getByRole("button", { name: /^Por conformar/ });
const avisoSinFirmante = (page: Page) => page.getByText(/Nadie puede dar la conformidad/);
const marca = () => randomBytes(2).toString("hex").toUpperCase();
const dni = () => `91${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;

async function pedir(page: Page, metodo: "post" | "put" | "patch", url: string, data?: unknown) {
  const r = await page.request[metodo](url, { data });
  expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
}
const orden = async (page: Page, data: Record<string, unknown> = {}) =>
  Number(
    (await pedir(page, "post", API, { activo_texto: "Horno 4", titulo: "Engrase", ...data })).id
  );
const estado = (page: Page, id: number, nuevo: string) =>
  pedir(page, "patch", `${API}/${id}/estado`, { estado: nuevo });
const completar = async (page: Page, id: number) => {
  await estado(page, id, "en_progreso");
  await estado(page, id, "completada");
};
const leer = async (page: Page, id: number) => (await page.request.get(`${API}/${id}`)).json();
const regla = (page: Page, exige_conformidad: boolean) =>
  pedir(page, "put", "/api/erp/mantenimiento/config", { exige_conformidad });

interface Persona {
  id: string;
  nombre: string;
  dni: string;
  password: string;
}
async function persona(page: Page, nombre: string, rol = "operador"): Promise<Persona> {
  const datos = { nombre, dni: dni(), password: `Persona-${marca()}-9x`, rol };
  await pedir(page, "post", "/api/erp/usuarios", datos);
  const lista = await (await page.request.get("/api/erp/usuarios")).json();
  const { id } = (lista.data as { id: string; nombre: string }[]).find((u) => u.nombre === nombre)!;
  return { id, ...datos };
}
const casilla = (page: Page, p: Persona, permitido: boolean) =>
  pedir(page, "put", `/api/erp/usuarios/${p.id}/permisos`, {
    modulos: BASE.map((modulo) => ({ modulo, asignado: true, nivel: "operar" })),
    pestanas: [{ modulo: "ordenes_trabajo", pestana: "conformidad:dar", permitido }],
  });

/** Entra con una persona recién creada (cambio de clave obligatorio incluido). */
async function entrarComo(page: Page, p: Persona) {
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: p.dni, password: p.password },
  });
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/mantenimiento/ordenes");
  await page.getByLabel("Contraseña temporal").fill(p.password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(`Nueva-${p.password}`);
  await page.getByLabel("Confirmar nueva contraseña").fill(`Nueva-${p.password}`);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();
  await expect(page.getByRole("heading", { name: "Órdenes de trabajo", level: 1 })).toBeVisible({
    timeout: 20_000,
  });
}

async function aEcosistema(page: Page, empresa: EmpresaSola, sembrar: () => Promise<void>) {
  const entrada = page.getByRole("button", { name: /^Gestión de mantenimiento/ }).first();
  await entrarPorPrimeraVez(page, empresa, entrada);
  await sembrar();
  await entrada.click();
  if (!(await menu(page).isVisible())) {
    await page
      .getByRole("button", { name: /Centro de mantenimiento/ })
      .first()
      .click();
  }
}

function vigilar(page: Page) {
  const fallos: string[] = [];
  page.on("pageerror", (e) => fallos.push(e.message));
  page.on("response", (r) => {
    if (r.url().includes("/api/erp/") && r.status() >= 400) fallos.push(`${r.status()} ${r.url()}`);
  });
  return fallos;
}

test("la casilla se marca en Administración y quien la tiene libera la unidad", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const m = marca();
  const empresa = await crearEmpresaSola(request, BASE, "conf-firma");
  const fallos = vigilar(page);
  let id = 0;
  let ssoma!: Persona;
  await aEcosistema(page, empresa, async () => {
    const u = await pedir(page, "post", "/api/erp/mantenimiento/equipos", {
      placa_codigo: `CNF-${m}`,
      tipo: "Volquete",
    });
    await regla(page, true);
    ssoma = await persona(page, `Ssoma ${m}`);
    id = await orden(page, {
      equipo_id: Number(u.id),
      activo_texto: undefined,
      prioridad: "urgente",
    });
    await completar(page, id);
  });

  await irA(page, "Configuración");
  await expect(avisoSinFirmante(page)).toBeVisible();

  // ── En Administración del ERP ─────────────────────────────────────────
  await page.getByRole("button", { name: "Volver al ERP" }).click();
  await page.getByRole("button", { name: "Administración" }).click();
  await page.getByRole("button", { name: "Configuración" }).click();
  await page.getByRole("button", { name: new RegExp(ssoma.nombre) }).click();
  const seccion = page.getByRole("region", { name: "Conformidad" });
  await expect(seccion.getByRole("checkbox")).not.toBeChecked();
  await seccion.getByRole("checkbox").check();
  await page.getByLabel(/Motivo/).fill("Firma de SSOMA");
  const guardado = page.waitForResponse(
    (r) => r.url().includes("/permisos") && r.request().method() === "PUT"
  );
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  expect((await guardado).status()).toBe(200);

  await page
    .getByRole("button", { name: /^Gestión de mantenimiento/ })
    .first()
    .click();
  if (!(await menu(page).isVisible())) {
    await page
      .getByRole("button", { name: /Centro de mantenimiento/ })
      .first()
      .click();
  }
  await irA(page, "Configuración");
  await expect(page.getByRole("switch", { name: /Exigir conformidad/ })).toBeVisible();
  await expect(avisoSinFirmante(page)).toHaveCount(0);

  // ── El Centro lleva a las pendientes; el administrador sin casilla no firma ─
  await irA(page, "Equipos");
  await expect(filas(page)).toContainText([/Detenida.*falta conformidad/]);
  await irA(page, "Centro de mantenimiento");
  const atencion = page
    .getByRole("heading", { name: "Requieren tu atención" })
    .locator("xpath=ancestor::section[1]");
  await expect(atencion).toContainText("1 orden espera conformidad");
  await atencion
    .getByRole("listitem")
    .filter({ hasText: "espera conformidad" })
    .getByRole("button", { name: "Ver órdenes" })
    .click();
  await expect(porConformar(page)).toHaveAttribute("aria-pressed", "true");
  await expect(filas(page)).toContainText(["Sin conformidad"]);
  await verOrden(page, id);
  await expect(panel(page)).toContainText("Pendiente de conformidad");
  await expect(boton(page, "Dar conformidad")).toHaveCount(0);
  await expect(boton(page, "Cancelar orden")).toHaveCount(0);
  expect(fallos).toEqual([]);

  // ── Quien tiene la casilla la da; doble clic no estorba ───────────────
  await entrarComo(page, ssoma);
  await verOrden(page, id);
  await boton(page, "Dar conformidad").dblclick();
  await expect(panel(page)).toContainText("Orden completada");
  await expect(boton(page, "Dar conformidad")).toHaveCount(0);
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await expect(panel(page).getByRole("region", { name: "Cómo avanza" })).toContainText(
    `Prueba y liberación${ssoma.nombre}`
  );
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  await expect(page.getByText("Sin conformidad")).toHaveCount(0);
  await porConformar(page).click();
  await expect(filas(page)).toContainText(["Sin resultados"]);
  await irA(page, "Equipos");
  await expect(filas(page)).toContainText([/Operativa/]);
});

test("inicia, completa y cancela; un rechazo se relee y sin señal no cambia nada", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(240_000);
  const empresa = await crearEmpresaSola(request, BASE, "conf-estados");
  let a = 0;
  let b = 0;
  let c = 0;
  await aEcosistema(page, empresa, async () => {
    a = await orden(page, { titulo: "Primera" });
    b = await orden(page, { titulo: "Segunda" });
    c = await orden(page, { titulo: "Tercera" });
  });
  await irA(page, "Órdenes de trabajo");

  await verOrden(page, a);
  await expect(boton(page, "Completar")).toHaveCount(0);
  await boton(page, "Iniciar").dblclick();
  await expect(boton(page, "Completar")).toBeVisible();
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await boton(page, "Completar").click();
  const cierre = page.getByRole("dialog", { name: "Completar la orden" });
  await page.keyboard.press("Escape");
  await expect(cierre).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await leer(page, a)).estado).toBe("en_progreso");
  await boton(page, "Completar").click();
  await cierre.getByLabel(/Observaciones/).fill("  Quedó bien  ");
  await cierre.getByRole("button", { name: "Completar orden" }).dblclick();
  await expect(cierre).toHaveCount(0);
  await expect(panel(page)).toContainText("Orden completada");
  await expect(panel(page)).toContainText("Quedó bien");
  await expect(boton(page, "Cancelar orden")).toHaveCount(0);
  // La regla está apagada: nada de conformidad.
  await expect(panel(page)).not.toContainText("conformidad");
  await expect(panel(page)).not.toContainText("Prueba y liberación");
  expect(await leer(page, a)).toMatchObject({
    estado: "completada",
    observaciones_cierre: "Quedó bien",
    requiere_conformidad: false,
  });
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  await expect(porConformar(page)).toHaveCount(0);

  // ── Otra persona la cambia antes ──────────────────────────────────────
  await verOrden(page, b);
  await expect(boton(page, "Iniciar")).toBeVisible();
  await estado(page, b, "cancelada");
  await boton(page, "Iniciar").click();
  await expect(panel(page).getByRole("alert")).toContainText("no admite esa transición");
  await expect(panel(page)).toContainText("Orden cancelada");
  await expect(boton(page, "Iniciar")).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();

  // ── Sin señal ─────────────────────────────────────────────────────────
  await verOrden(page, c);
  await expect(boton(page, "Iniciar")).toBeVisible();
  await context.setOffline(true);
  await boton(page, "Iniciar").click();
  await expect(panel(page).getByRole("alert")).toContainText("necesita señal");
  await expect(boton(page, "Iniciar")).toBeVisible();
  await boton(page, "Cancelar orden").click();
  const baja = page.getByRole("dialog", { name: "Cancelar la orden" });
  await baja.getByRole("button", { name: "Cancelar orden" }).click();
  await expect(baja.getByRole("alert")).toContainText("necesita señal");
  await context.setOffline(false);
  expect((await leer(page, c)).estado).toBe("abierta");
  await baja.getByLabel(/Motivo/).fill("Repetida");
  await baja.getByRole("button", { name: "Cancelar orden" }).click();
  await expect(baja).toHaveCount(0);
  await expect(panel(page)).toContainText("Orden cancelada");
  // El aviso de antes no se queda cuando la acción ya salió bien.
  await expect(panel(page).getByRole("alert"), "aviso viejo").toHaveCount(0);
  expect((await leer(page, c)).estado).toBe("cancelada");
});

test("sin casilla, siendo el mecánico o con Lectura no se firma", async ({ page, request }) => {
  test.setTimeout(240_000);
  const m = marca();
  const empresa = await crearEmpresaSola(request, BASE, "conf-quien");
  let propia = 0;
  let ajena = 0;
  let firmante!: Persona;
  let mira!: Persona;
  await aEcosistema(page, empresa, async () => {
    await regla(page, true);
    firmante = await persona(page, `Firma ${m}`);
    mira = await persona(page, `Mira ${m}`, "lectura");
    await casilla(page, firmante, true);
    propia = await orden(page, { titulo: "Propia", asignado_a: firmante.id });
    ajena = await orden(page, { titulo: "Ajena" });
    await completar(page, propia);
    await completar(page, ajena);
  });

  await entrarComo(page, mira);
  const fallos = vigilar(page);
  await verOrden(page, ajena);
  await expect(panel(page)).toContainText("Pendiente de conformidad");
  for (const nombre of ["Dar conformidad", "Iniciar", "Completar", "Cancelar orden"]) {
    await expect(boton(page, nombre)).toHaveCount(0);
  }
  expect(fallos).toEqual([]);

  await entrarComo(page, firmante);
  await verOrden(page, propia);
  await expect(panel(page)).toContainText("no el mecánico de la orden");
  await expect(boton(page, "Dar conformidad")).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  await verOrden(page, ajena);
  await expect(boton(page, "Dar conformidad")).toBeVisible();

  // Se le quita la casilla con la pantalla abierta: el servidor manda.
  const admin = await page
    .context()
    .browser()!
    .newContext({ baseURL: new URL(page.url()).origin });
  const entrar = await admin.request.post("/api/auth/login", {
    data: { identificador: empresa.email, password: `${empresa.password}Nueva` },
  });
  expect(entrar.status(), await entrar.text()).toBe(200);
  const quitar = await admin.request.put(`/api/erp/usuarios/${firmante.id}/permisos`, {
    data: {
      modulos: BASE.map((modulo) => ({ modulo, asignado: true, nivel: "operar" })),
      pestanas: [{ modulo: "ordenes_trabajo", pestana: "conformidad:dar", permitido: false }],
    },
  });
  expect(quitar.status(), await quitar.text()).toBe(200);
  await boton(page, "Dar conformidad").click();
  // Cambiar sus permisos le cierra la sesión: vuelve a la entrada y la orden sigue pendiente.
  await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
  const quedo = await admin.request.get(`${API}/${ajena}`);
  expect((await quedo.json()).conformidad_en).toBeNull();
  await admin.close();
});

test("apagar la regla libera lo pendiente y sin Órdenes de trabajo no se pregunta", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, BASE, "conf-apaga");
  let id = 0;
  await aEcosistema(page, empresa, async () => {
    await regla(page, true);
    id = await orden(page);
    await completar(page, id);
  });
  await irA(page, "Órdenes de trabajo");
  await expect(filas(page)).toContainText(["Sin conformidad"]);
  await irA(page, "Configuración");
  const interruptor = page.getByRole("switch", { name: /Exigir conformidad/ });
  await expect(avisoSinFirmante(page)).toBeVisible();
  await interruptor.click();
  await expect(interruptor).toHaveAttribute("aria-checked", "false");
  await expect(avisoSinFirmante(page)).toHaveCount(0);
  await irA(page, "Órdenes de trabajo");
  await expect(filas(page)).toContainText(["Completada"]);
  await expect(porConformar(page)).toHaveCount(0);
  await expect(page.getByText("Sin conformidad")).toHaveCount(0);
  await verOrden(page, id);
  await expect(panel(page)).toContainText("Orden completada");
  await expect(panel(page)).not.toContainText("conformidad");

  const sola = await crearEmpresaSola(request, "mantenimiento", "conf-sola");
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  const fallos = vigilar(page);
  await entrarPorPrimeraVez(page, sola, menu(page));
  await regla(page, true);
  await irA(page, "Configuración");
  await expect(page.getByRole("switch", { name: /Exigir conformidad/ })).toBeVisible();
  await expect(page.getByText(/Necesita el módulo Órdenes de Trabajo/).first()).toBeVisible();
  await expect(avisoSinFirmante(page)).toHaveCount(0);
  expect(fallos).toEqual([]);
});

test("en el celular, con textos largos, nada se sale", async ({ page, request }) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, BASE, "conf-celular");
  let abierta = 0;
  let pendiente = 0;
  await aEcosistema(page, empresa, async () => {
    await regla(page, true);
    abierta = await orden(page, { activo_texto: "C".repeat(150), titulo: "T".repeat(200) });
    pendiente = await orden(page, { titulo: "P".repeat(200) });
    await estado(page, pendiente, "en_progreso");
    await pedir(page, "patch", `${API}/${pendiente}/estado`, {
      estado: "completada",
      observaciones_cierre: "O".repeat(600),
    });
  });
  await irA(page, "Órdenes de trabajo");
  await page.setViewportSize({ width: 393, height: 800 });
  const dentro = async (nombre: string) => {
    const sobra = await page
      .getByRole("dialog", { name: nombre })
      .evaluate((el) =>
        Math.max(
          ...[el, ...el.querySelectorAll("div, section, button, header, textarea, form")].map(
            (n) => n.getBoundingClientRect().right - window.innerWidth
          )
        )
      );
    expect(sobra, nombre).toBeLessThanOrEqual(1);
  };
  await expect(porConformar(page)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(0);
  await verOrden(page, abierta);
  await expect(boton(page, "Iniciar")).toBeInViewport();
  await dentro("Detalle de la orden");
  await boton(page, "Cancelar orden").click();
  await dentro("Cancelar la orden");
  await page.keyboard.press("Escape");
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  await verOrden(page, pendiente);
  await expect(panel(page)).toContainText("Pendiente de conformidad");
  await dentro("Detalle de la orden");
});
