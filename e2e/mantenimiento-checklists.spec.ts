/** e2e/mantenimiento-checklists.spec.ts
 *
 * Checklists → Registros dentro del ecosistema «Gestión de mantenimiento» (M7):
 *
 * 1. Otra persona con el permiso decide la salida desde el panel; Lectura mira y no decide.
 * 2. Búsqueda, filtro y páginas; una respuesta lenta no pisa a la nueva y un fallo no parece «sin resultados».
 * 3. Sin el módulo Checklists no hay entrada ni pantalla; sin Órdenes de trabajo no hay órdenes.
 * 4. En el celular, con textos largos, nada se sale.
 * 5. Formatos: crear, editar, volver a una versión y desactivar; un cambio ajeno no se pisa; Lectura mira.
 *
 * Cada test crea su propia empresa (no hay API para borrarlas: la base de los e2e es efímera en CI).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

const BASE = ["mantenimiento", "checklists"];
const LISTA = /\/api\/erp\/checklists\?/;

const menu = (page: Page) =>
  page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
const entradaDelMenu = (page: Page, nombre: string) =>
  menu(page).getByRole("button", { name: new RegExp(`^${nombre}`) });
const filas = (page: Page) => page.locator("tbody tr");
const buscador = (page: Page) => page.getByPlaceholder(/Buscar por número/);
const panel = (page: Page) => page.getByRole("dialog", { name: "Detalle del checklist" });
/** Abre la primera fila por su botón: la fila «Cargando…» no lo tiene, así que espera a los datos. */
const abrirChecklist = (page: Page) =>
  page
    .getByRole("button", { name: /^Ver el checklist/ })
    .first()
    .click();
const abrirFormato = (page: Page) =>
  page
    .getByRole("button", { name: /^Ver el formato/ })
    .first()
    .click();
const marca = () => randomBytes(2).toString("hex").toUpperCase();

async function crear(page: Page, url: string, data: unknown) {
  const r = await page.request.post(url, { data });
  expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
}
async function sembrar(page: Page) {
  const formato = await crear(page, "/api/erp/checklists/plantillas", {
    nombre: "Pre-uso",
    items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
  });
  return (activo_texto: string, mala?: string) =>
    crear(page, "/api/erp/checklists", {
      plantilla_id: formato.id,
      activo_texto,
      items: ["Frenos", "Luces"].map((descripcion) => ({
        descripcion,
        estado: descripcion === mala ? "malo" : "bien",
      })),
    }) as Promise<{ id: number }>;
}

/** Entra como administrador, siembra y deja abierto Registros. */
async function aRegistros(
  page: Page,
  empresa: Awaited<ReturnType<typeof crearEmpresaSola>>,
  datos: () => Promise<void>
) {
  const entrada = page.getByRole("button", { name: /^Gestión de mantenimiento/ }).first();
  await entrarPorPrimeraVez(page, empresa, entrada);
  await datos();
  await entrada.click();
  if (!(await menu(page).isVisible())) {
    await page
      .getByRole("button", { name: /Centro de mantenimiento/ })
      .first()
      .click();
  }
  await entradaDelMenu(page, "Checklists").click();
  await expect(page.getByRole("heading", { name: "Checklists pre-uso", level: 1 })).toBeVisible();
}

/** Crea una persona y entra con ella (cambio de clave obligatorio incluido). */
async function entrarComo(page: Page, rol: string, autoriza: boolean) {
  const m = marca();
  const dni = `97${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const password = `Persona-${m}-9x`;
  await crear(page, "/api/erp/usuarios", { nombre: `Persona ${m}`, dni, password, rol });
  if (autoriza) {
    const lista = await (await page.request.get("/api/erp/usuarios")).json();
    const { id } = (lista.data as { id: string; nombre: string }[]).find(
      (u) => u.nombre === `Persona ${m}`
    )!;
    const permisos = await page.request.put(`/api/erp/usuarios/${id}/permisos`, {
      data: {
        modulos: BASE.map((modulo) => ({ modulo, asignado: true, nivel: "operar" })),
        pestanas: [{ modulo: "checklists", pestana: "salida:autorizar", permitido: true }],
      },
    });
    expect(permisos.status(), await permisos.text()).toBe(200);
  }
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: dni, password },
  });
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/mantenimiento/checklists");
  await page.getByLabel("Contraseña temporal").fill(password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(`Nueva-${m}-7y`);
  await page.getByLabel("Confirmar nueva contraseña").fill(`Nueva-${m}-7y`);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();
  await expect(page.getByRole("heading", { name: "Checklists pre-uso", level: 1 })).toBeVisible({
    timeout: 20_000,
  });
}

test("otra persona con el permiso decide la salida desde el panel", async ({ page, request }) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, BASE, "ck-decide");
  const activo = `Faja ${marca()}`;
  await aRegistros(page, empresa, async () => {
    await (
      await sembrar(page)
    )(activo, "Luces");
  });
  // Quien lo llenó no decide.
  await abrirChecklist(page);
  await expect(panel(page)).toContainText("Lo llenaste tú: lo decide otra persona.");
  await expect(panel(page).getByRole("button", { name: "Decidir salida" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await entrarComo(page, "operador", true);
  const pendientes = page.getByRole("button", { name: "Por autorizar" });
  await pendientes.click();
  await expect(filas(page)).toContainText([activo]);
  await abrirChecklist(page);
  await panel(page).getByRole("button", { name: "Decidir salida" }).click();
  const ventana = page.getByRole("dialog", { name: `Decidir la salida de ${activo}` });
  await expect(ventana).toContainText("Luces");
  // Escape no cierra el panel que está detrás de la ventana.
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();
  await ventana.getByLabel("Motivo").fill("Viaja de día");
  await ventana.getByRole("button", { name: "Autorizar salida" }).click();
  await expect(ventana).toBeHidden();
  await expect(panel(page)).toContainText("Salida autorizada: la unidad sale");
  await expect(panel(page)).toContainText("Viaja de día");
  await expect(panel(page).getByRole("button", { name: "Decidir salida" })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  // Ya no está pendiente.
  await expect(filas(page)).toContainText(["Sin resultados"]);
});

test("Lectura ve los registros y el panel, sin poder decidir", async ({ page, request }) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, BASE, "ck-lectura");
  const activo = `Bomba ${marca()}`;
  await aRegistros(page, empresa, async () => {
    await (
      await sembrar(page)
    )(activo, "Luces");
  });
  await entrarComo(page, "lectura", false);
  await abrirChecklist(page);
  await expect(panel(page)).toContainText("espera autorización");
  await expect(panel(page).getByRole("button", { name: "Decidir salida" })).toHaveCount(0);
  // Sin Órdenes de trabajo no hay nada de órdenes.
  await expect(panel(page)).not.toContainText("Orden generada");
  await expect(page.getByRole("columnheader", { name: "Orden generada" })).toHaveCount(0);
});

test("busca, pagina y aguanta fallos y respuestas lentas", async ({ page, request }) => {
  test.setTimeout(240_000);
  const m = marca();
  const empresa = await crearEmpresaSola(request, BASE, "ck-lista");
  await aRegistros(page, empresa, async () => {
    const llenar = await sembrar(page);
    await llenar(`Primero ${m}`, "Frenos");
    for (let i = 0; i < 26; i++) await llenar(`Relleno ${i}`);
  });
  const siguiente = page.getByRole("button", { name: "Siguiente" });
  const anterior = page.getByRole("button", { name: "Anterior" });
  await expect(filas(page)).toHaveCount(25);
  await expect(anterior).toBeDisabled();
  await siguiente.click();
  await expect(filas(page)).toHaveCount(2);
  await expect(siguiente).toBeDisabled();
  // Buscar desde la segunda página vuelve a la primera y encuentra lo de cualquier página.
  await buscador(page).fill(`primero ${m.toLowerCase()}`);
  await expect(filas(page)).toHaveCount(1);
  await expect(anterior).toBeDisabled();
  await buscador(page).fill("no-existe");
  await expect(filas(page)).toContainText(["Sin resultados"]);

  // Una respuesta lenta de una búsqueda anterior no pisa a la nueva.
  let soltar = () => {};
  const retenida = new Promise<void>((r) => (soltar = r));
  await page.route(LISTA, async (ruta) => {
    if (!ruta.request().url().includes("q=relleno")) return ruta.continue();
    const vieja = await ruta.fetch();
    await retenida;
    await ruta.fulfill({ response: vieja });
  });
  const pedida = page.waitForRequest(/q=relleno/);
  await buscador(page).fill("relleno");
  await pedida;
  await buscador(page).fill("primero");
  await expect(filas(page)).toHaveCount(1);
  await expect(filas(page)).toContainText([`Primero ${m}`]);
  const llega = page.waitForResponse(/q=relleno/);
  soltar();
  await (await llega).finished();
  await page.waitForTimeout(500);
  await expect(filas(page)).toHaveCount(1);
  await page.unroute(LISTA);

  // Un fallo se dice y se puede reintentar.
  await page.route(LISTA, (ruta) => ruta.fulfill({ status: 500, body: "{}" }));
  await page.getByRole("combobox", { name: "Resultado" }).selectOption("no_apta");
  await expect(page.getByRole("alert")).toContainText("No se pudo leer la lista");
  await expect(page.getByText("Sin resultados")).toHaveCount(0);
  await page.unroute(LISTA);
  await page.getByRole("button", { name: "Reintentar" }).click();
  await expect(filas(page)).toHaveCount(1);
});

test("sin el módulo Checklists no hay entrada ni pantalla", async ({ page, request }) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "ck-sin");
  await entrarPorPrimeraVez(page, empresa, menu(page));
  await expect(entradaDelMenu(page, "Checklists")).toHaveCount(0);
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: empresa.email, password: `${empresa.password}Nueva` },
  });
  expect(login.status()).toBe(200);
  const pedidas: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/erp/checklists")) pedidas.push(r.url());
  });
  await page.goto("/mantenimiento/checklists");
  await expect(menu(page)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("heading", { name: /^(Buenos días|Buenas tardes|Buenas noches)$/ })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Checklists pre-uso" })).toHaveCount(0);
  expect(pedidas).toEqual([]);
});

test("en el celular, con textos largos, nada se sale", async ({ page, request }) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, BASE, "ck-celular");
  await aRegistros(page, empresa, async () => {
    await (
      await sembrar(page)
    )("G".repeat(150), "Frenos");
  });
  const sobra = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
  await page.setViewportSize({ width: 393, height: 850 });
  await expect(filas(page)).toHaveCount(1);
  await expect.poll(sobra).toBe(0);
  await page.getByRole("button", { name: /^Ver el checklist/ }).click();
  await expect(panel(page)).toContainText("Lo que respondió");
  const salidos = await panel(page).evaluate((hoja) => {
    const borde = hoja.getBoundingClientRect().right + 1;
    return [...hoja.querySelectorAll("p, b, span, h2, button")]
      .filter((el) => el.getBoundingClientRect().right > borde)
      .map((el) => el.textContent?.slice(0, 30));
  });
  expect(salidos).toEqual([]);
});

const aFormatos = (page: Page) => page.getByRole("tab", { name: /^Formatos/ }).click();
const panelDeFormato = (page: Page) => page.getByRole("dialog", { name: "Detalle del formato" });
const crearFormato = (page: Page, nombre: string, tipo_equipo?: string) =>
  crear(page, "/api/erp/checklists/plantillas", {
    nombre,
    tipo_equipo,
    items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
  }) as Promise<{ id: number }>;

test("formatos: crear, editar, volver a una versión y desactivar", async ({ page, request }) => {
  test.setTimeout(240_000);
  const m = marca();
  const nombre = `Pre-uso ${m}`;
  const empresa = await crearEmpresaSola(request, BASE, "ck-formatos");
  await aRegistros(page, empresa, async () => {
    await crear(page, "/api/erp/mantenimiento/equipos", {
      placa_codigo: `VOL-${m}`,
      tipo: "Volquete",
    });
    await crear(page, "/api/erp/mantenimiento/equipos", {
      placa_codigo: `PAL-${m}`,
      tipo: "Excavadora",
    });
  });
  await aFormatos(page);
  await expect(filas(page)).toContainText(["Todavía no hay formatos."]);

  // ── Crear ─────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Nuevo formato" }).click();
  const nuevo = page.getByRole("dialog", { name: "Nueva Plantilla" });
  await nuevo.getByLabel("Nombre").fill(nombre);
  await nuevo.getByLabel(/Tipo de equipo/).fill("volquete");
  await nuevo.getByPlaceholder("Ítem 1").fill("Frenos");
  await nuevo.getByRole("button", { name: "Crear Plantilla" }).click();
  await expect(nuevo).toBeHidden();
  await expect(filas(page)).toHaveCount(1);
  await expect(filas(page)).toContainText(["1 unidad lo usa"]);

  // ── Panel: solo las unidades de su tipo ───────────────────────────────
  await abrirFormato(page);
  const hoja = panelDeFormato(page);
  const usan = hoja.getByRole("region", { name: "Unidades que lo usan" });
  await expect(usan).toContainText(`VOL-${m}`);
  await expect(usan).not.toContainText(`PAL-${m}`);
  await expect(hoja).toContainText("1 pregunta · 0 críticas");

  // ── Editar: versión nueva, visible en el panel y en la lista ──────────
  await hoja.getByRole("button", { name: "Editar formato" }).click();
  const editor = page.getByRole("dialog", { name: "Editar formato (versión 1)" });
  await editor.getByRole("button", { name: "+ Agregar ítem" }).click();
  await editor.getByPlaceholder("Ítem 2").fill("Bocina");
  await editor.getByRole("checkbox", { name: "Ítem 2 es crítico" }).check();
  await editor.getByLabel(/cambió/i).fill("Se agrega la bocina");
  await editor.getByRole("button", { name: "Guardar versión" }).click();
  await expect(editor).toBeHidden();
  await expect(hoja).toContainText("2 preguntas · 1 crítica");
  await expect(hoja.getByRole("region", { name: "Historial de versiones" })).toContainText(
    "Se agrega la bocina"
  );

  // ── Volver a la versión 1: crea la 3 ──────────────────────────────────
  page.once("dialog", (d) => d.accept());
  await hoja.getByRole("button", { name: "Versiones" }).click();
  const versiones = page.getByRole("dialog", { name: "Versiones del formato" });
  await versiones
    .getByRole("region", { name: "Versión 1" })
    .getByRole("button", { name: "Volver a esta versión" })
    .click();
  await expect(versiones.getByRole("region", { name: "Versión 3" })).toBeVisible();
  await versiones.getByRole("button", { name: "Cerrar" }).click();
  await expect(hoja).toContainText("v3 · vigente");
  await expect(hoja.getByRole("region", { name: "Preguntas" })).not.toContainText("Bocina");

  // ── Desactivar y activar ──────────────────────────────────────────────
  await hoja.getByRole("button", { name: "Desactivar" }).click();
  await expect(hoja.getByRole("button", { name: "Activar", exact: true })).toBeVisible();
  await hoja.getByRole("button", { name: "Cerrar el panel" }).click();
  await expect(filas(page)).toContainText(["Desactivado"]);
  await abrirFormato(page);
  await hoja.getByRole("button", { name: "Activar", exact: true }).click();
  await expect(hoja.getByRole("button", { name: "Desactivar" })).toBeVisible();
});

// La lista de formatos se guarda para llenar checklists sin señal: el service worker la pide por su cuenta y la
// interceptación de la prueba no la vería. Aquí se apaga para poder simular el fallo.
test.describe("formatos sin caché", () => {
  test.use({ serviceWorkers: "block" });

  test("formatos: no pisa un cambio ajeno y aguanta un fallo de lectura", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const nombre = `Choque ${marca()}`;
    const empresa = await crearEmpresaSola(request, BASE, "ck-choque");
    let id = 0;
    await aRegistros(page, empresa, async () => {
      id = (await crearFormato(page, nombre)).id;
    });
    const ruta = "**/api/erp/checklists/plantillas?*";
    await page.route(ruta, (r) => r.fulfill({ status: 500, body: "{}" }));
    await aFormatos(page);
    await expect(page.getByRole("alert")).toContainText("No se pudieron leer los formatos");
    await expect(page.getByText("Todavía no hay formatos.")).toHaveCount(0);
    await page.unroute(ruta);
    await page.getByRole("button", { name: "Reintentar" }).click();
    await expect(filas(page)).toContainText([nombre]);

    await abrirFormato(page);
    const hoja = panelDeFormato(page);
    await hoja.getByRole("button", { name: "Editar formato" }).click();
    const editor = page.getByRole("dialog", { name: "Editar formato (versión 1)" });
    // Otra persona guarda mientras la ventana está abierta.
    const otro = await page.request.put(`/api/erp/checklists/plantillas/${id}`, {
      data: {
        nombre,
        items: [{ descripcion: "Cambio ajeno", critica: false }],
        cambio: "Desde otro lado",
        version_base: 1,
      },
    });
    expect(otro.status(), await otro.text()).toBe(200);
    await editor.getByLabel(/cambió/i).fill("Mi cambio");
    await editor.getByRole("button", { name: "Guardar versión" }).click();
    await expect(editor.getByRole("alert")).toContainText("Alguien cambió este formato");
    await editor.getByRole("button", { name: "Cerrar" }).click();
    await expect(hoja.getByRole("region", { name: "Preguntas" })).toContainText("Cambio ajeno");
    await expect(hoja).toContainText("v2 · vigente");
  });
});

test("formatos: Lectura mira sin botones y en el celular nada se sale", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, BASE, "ck-fmt-lectura");
  await aRegistros(page, empresa, async () => {
    await crearFormato(page, "N".repeat(140), "T".repeat(90));
  });
  await entrarComo(page, "lectura", false);
  await aFormatos(page);
  await expect(filas(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Nuevo formato" })).toHaveCount(0);
  await page.setViewportSize({ width: 393, height: 850 });
  const sobra = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
  await expect.poll(sobra).toBe(0);
  await page.getByRole("button", { name: /^Ver el formato/ }).click();
  const hoja = panelDeFormato(page);
  await expect(hoja.getByRole("region", { name: "Preguntas" })).toContainText("Frenos");
  await expect(hoja.getByRole("button", { name: "Editar formato" })).toHaveCount(0);
  await expect(hoja.getByRole("button", { name: "Desactivar" })).toHaveCount(0);
  const salidos = await hoja.evaluate((el) => {
    const borde = el.getBoundingClientRect().right + 1;
    return [...el.querySelectorAll("p, b, span, h2, button")]
      .filter((x) => x.getBoundingClientRect().right > borde)
      .map((x) => x.textContent?.slice(0, 30));
  });
  expect(salidos).toEqual([]);
  await hoja.getByRole("button", { name: "Versiones" }).click();
  const versiones = page.getByRole("dialog", { name: "Versiones del formato" });
  await expect(versiones).toBeVisible();
  await expect(versiones.getByRole("button", { name: "Volver a esta versión" })).toHaveCount(0);
});
