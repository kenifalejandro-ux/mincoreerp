/** e2e/mantenimiento-centro.spec.ts
 *
 * El Centro de control de Mantenimiento (M6):
 *
 * 1. Con Checklists y Órdenes de trabajo: las cifras, lo que requiere atención y las áreas salen de datos
 *    reales; cada botón lleva a donde dice y, al volver, el Centro se actualiza.
 * 2. Autonomía: con solo Mantenimiento, con Checklists o con Órdenes, lo del módulo que falta no aparece y
 *    ninguna petición falla.
 * 3. Una lectura fallida no muestra ceros, y una lectura lenta de antes no pisa a la nueva.
 * 4. Lectura mira y no recibe «Asignar».
 * 5. En el celular, con textos largos y muchas unidades, nada se sale de la pantalla.
 *
 * 6. «Actividad del turno» cuenta cada paso con su efecto; si su lectura falla, avisa y deja reintentar.
 *
 * Cada test crea su propia empresa (no hay API para borrarlas: la base de los e2e es efímera en CI).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

const TODO = ["mantenimiento", "checklists", "ordenes_trabajo"];
const RESUMEN = "**/api/erp/mantenimiento/resumen";

const menu = (page: Page) =>
  page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
const irA = (page: Page, seccion: string) =>
  menu(page)
    .getByRole("button", { name: new RegExp(`^${seccion}`) })
    .click();
const cifras = (page: Page) => page.getByRole("region", { name: "Resumen del mantenimiento" });
const panel = (page: Page, titulo: string) =>
  page.getByRole("heading", { name: titulo }).locator("xpath=ancestor::section[1]");
const actividad = (page: Page) => panel(page, "Actividad del turno");
const area = (page: Page, nombre: string) =>
  page.getByRole("button", { name: new RegExp(`^${nombre} \\d+ %`) });
/** La lista se lee al abrir la sección: se sale y se vuelve (recargar pediría otra vez la clave). */
async function releerCentro(page: Page) {
  await irA(page, "Equipos");
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();
  await irA(page, "Centro de mantenimiento");
}

async function crear(page: Page, url: string, data: unknown) {
  const r = await page.request.post(url, { data });
  expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
}
const equipo = (page: Page, placa_codigo: string, extra: Record<string, unknown> = {}) =>
  crear(page, "/api/erp/mantenimiento/equipos", { placa_codigo, tipo: "Volquete", ...extra });
const formato = (page: Page) =>
  crear(page, "/api/erp/checklists/plantillas", {
    nombre: "Pre-uso",
    items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
  });
const llenar = (page: Page, plantilla_id: number, unidad: Record<string, unknown>, mala?: string) =>
  crear(page, "/api/erp/checklists", {
    plantilla_id,
    ...unidad,
    items: ["Frenos", "Luces"].map((descripcion) => ({
      descripcion,
      estado: descripcion === mala ? "malo" : "bien",
    })),
  });

/** Entra a una empresa recién creada y deja abierto el Centro. Con un solo módulo se cae directo en él. */
async function alCentro(
  page: Page,
  empresa: Awaited<ReturnType<typeof crearEmpresaSola>>,
  modulos: string[],
  sembrar: () => Promise<void> = async () => {}
) {
  if (modulos.length === 1) {
    await entrarPorPrimeraVez(page, empresa, menu(page));
    await sembrar();
    await releerCentro(page);
    return;
  }
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

/** Lo que falló mientras se usaba la pantalla: errores de la página y respuestas de la API con error. */
function vigilar(page: Page) {
  const fallos: string[] = [];
  page.on("pageerror", (e) => fallos.push(e.message));
  page.on("response", (r) => {
    if (r.url().includes("/api/erp/") && r.status() >= 400) fallos.push(`${r.status()} ${r.url()}`);
  });
  return fallos;
}

test("las cifras y los avisos salen de datos reales y cada botón lleva a donde dice", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const [detenida, observada, sinCk] = [`DET-${marca}`, `OBS-${marca}`, `SIN-${marca}`];
  const empresa = await crearEmpresaSola(request, TODO, "centro");
  const fallos = vigilar(page);
  let orden = 0;
  await alCentro(page, empresa, TODO, async () => {
    const cantera = await crear(page, "/api/erp/mantenimiento/areas", { nombre: "Cantera" });
    const a = await equipo(page, detenida, { area_id: cantera.id });
    const b = await equipo(page, observada, { area_id: cantera.id });
    await equipo(page, sinCk);
    const f = await formato(page);
    orden = (await llenar(page, f.id, { equipo_id: a.id }, "Frenos")).orden_trabajo_id;
    await llenar(page, f.id, { equipo_id: b.id }, "Luces");
    await crear(page, "/api/erp/usuarios", {
      nombre: `Mecánico ${marca}`,
      dni: `95${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`,
      password: `Mecanico-${marca}-9x`,
      rol: "mecanico",
    });
  });

  // ── Cifras, atención, flota, órdenes y áreas ──────────────────────────
  await expect(cifras(page)).toContainText("Unidades operativas1 de 3");
  await expect(cifras(page)).toContainText("2 detenidas");
  await expect(cifras(page)).toContainText("Órdenes abiertas11 urgente");
  await expect(cifras(page)).toContainText("Checklists de hoy2 de 31 unidad sin checklist");
  const atencion = panel(page, "Requieren tu atención");
  await expect(atencion.getByRole("listitem")).toContainText([
    "1 orden sin mecánico asignado (1 urgente)",
    "1 checklist «No apta» hoy",
    "1 salida por autorizar",
    "1 unidad sin checklist hoy",
    "1 equipo sin área",
  ]);
  await expect(atencion).toContainText(`${detenida}: Frenos`);
  await expect(atencion).toContainText(`${observada}: Luces`);
  await expect(panel(page, "Estado de la flota")).toContainText("1 de 3 unidades operando");
  await expect(panel(page, "Estado de la flota")).toContainText("Checklists hechos hoy67%");
  await expect(panel(page, "Órdenes por tipo")).toContainText("1Este mes");
  await expect(area(page, "Cantera")).toContainText("0 %");
  await expect(area(page, "Cantera")).toContainText("2 equipos · 2 detenidos");

  const pasos = actividad(page).getByRole("listitem");
  await expect(pasos).toHaveCount(3);
  await expect(pasos).toContainText([
    "Espera autorización para salir",
    "Falta asignar mecánico: la unidad sigue detenida",
    `Generó la OT #${orden}`,
  ]);

  // ── Un área abre Equipos filtrado; «atrás» vuelve; por el menú, sin filtro ─
  const filas = page.locator("tbody tr");
  await area(page, "Cantera").click();
  await expect(page.getByRole("combobox", { name: "Área" })).toHaveValue("Cantera");
  await expect(filas).toHaveCount(2);
  await page.goBack();
  await expect(cifras(page)).toBeVisible();
  await irA(page, "Equipos");
  await expect(page.getByRole("combobox", { name: "Área" })).toHaveValue("Todas las áreas");
  await expect(filas).toHaveCount(3);
  await irA(page, "Centro de mantenimiento");
  await area(page, "Sin área").click();
  await expect(filas).toHaveCount(1);
  await expect(filas).toContainText(sinCk);
  await irA(page, "Centro de mantenimiento");
  await atencion.getByRole("button", { name: "Ver unidades" }).click();
  await expect(filas).toHaveCount(3);
  await irA(page, "Centro de mantenimiento");
  await cifras(page)
    .getByRole("button", { name: /Unidades operativas/ })
    .click();
  await expect(filas).toHaveCount(3);
  await irA(page, "Centro de mantenimiento");

  // ── «Asignar» abre las órdenes sin asignar; al asignar y volver, el aviso se va ─
  await atencion.getByRole("button", { name: "Asignar" }).click();
  await expect(page).toHaveURL(/\/mantenimiento\/ordenes$/);
  await expect(page.getByRole("combobox", { name: "Mecánico", exact: true })).toHaveValue(
    "sin_asignar"
  );
  await page.getByRole("button", { name: `Ver la orden ${orden}` }).click();
  const detalle = page.getByRole("dialog", { name: "Detalle de la orden" });
  await detalle.getByRole("button", { name: "Asignar mecánico" }).click();
  const ventana = page.getByRole("dialog", { name: "Asignar mecánico" });
  await ventana.getByRole("checkbox", { name: new RegExp(`Mecánico ${marca}`) }).click();
  await ventana.getByRole("button", { name: `Asignar a Mecánico ${marca}` }).click();
  await expect(detalle).toContainText("Lista para iniciar");
  await detalle.getByRole("button", { name: "Cerrar el panel" }).click();
  // Ya asignada, sale del filtro «Sin asignar».
  await expect(filas).toContainText(["Sin resultados"]);
  await page.goBack();
  await expect(cifras(page)).toBeVisible({ timeout: 20_000 });
  await expect(atencion).not.toContainText("sin mecánico");
  await expect(cifras(page)).toContainText("Órdenes abiertas1");
  await expect(actividad(page)).not.toContainText("Falta asignar mecánico");

  // ── Los botones de checklists abren Registros, ya filtrados ───────────
  const resultado = page.getByRole("combobox", { name: "Resultado" });
  await atencion.getByRole("button", { name: "Ver checklists" }).first().click();
  await expect(page).toHaveURL(/\/mantenimiento\/checklists$/);
  await expect(resultado).toHaveValue("no_apta");
  await expect(filas).toHaveCount(1);
  await expect(filas).toContainText(detenida);
  await irA(page, "Centro de mantenimiento");
  await atencion.getByRole("button", { name: "Ver checklists" }).last().click();
  await expect(page.getByRole("button", { name: "Por autorizar" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(filas).toHaveCount(1);
  await expect(filas).toContainText(observada);
  await irA(page, "Centro de mantenimiento");
  await cifras(page)
    .getByRole("button", { name: /Checklists de hoy/ })
    .click();
  await expect(resultado).toHaveValue("");
  await expect(filas).toHaveCount(2);
  expect(fallos).toEqual([]);
});

for (const caso of [
  { nombre: "solo Mantenimiento", modulos: ["mantenimiento"], ck: false, ot: false },
  { nombre: "con Checklists", modulos: ["mantenimiento", "checklists"], ck: true, ot: false },
  { nombre: "con Órdenes", modulos: ["mantenimiento", "ordenes_trabajo"], ck: false, ot: true },
]) {
  test(`autonomía, ${caso.nombre}: lo que falta no aparece y nada falla`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const placa = `AUT-${randomBytes(2).toString("hex").toUpperCase()}`;
    const empresa = await crearEmpresaSola(request, caso.modulos, "centro-aut");
    const fallos = vigilar(page);
    await alCentro(page, empresa, caso.modulos, async () => {
      const { id } = await equipo(page, placa);
      if (caso.ck) await llenar(page, (await formato(page)).id, { equipo_id: id }, "Frenos");
      if (caso.ot) {
        await crear(page, "/api/erp/ordenes_trabajo", {
          equipo_id: id,
          titulo: "Frenos",
          prioridad: "urgente",
        });
      }
    });

    const detenida = caso.ck || caso.ot;
    await expect(cifras(page)).toContainText(`Unidades operativas${detenida ? 0 : 1} de 1`);
    await expect(cifras(page).getByText("Checklists de hoy")).toHaveCount(caso.ck ? 1 : 0);
    await expect(cifras(page).getByText("Órdenes abiertas")).toHaveCount(caso.ot ? 1 : 0);
    await expect(page.getByText("Checklists hechos hoy")).toHaveCount(caso.ck ? 1 : 0);
    await expect(page.getByRole("button", { name: "Nueva OT" })).toHaveCount(caso.ot ? 1 : 0);
    await expect(page.getByRole("heading", { name: "Órdenes por tipo" })).toHaveCount(
      caso.ot ? 1 : 0
    );
    await expect(page.getByRole("heading", { name: "Por estado" })).toHaveCount(caso.ot ? 0 : 1);
    await expect(page.getByRole("button", { name: "Ver checklists" })).toHaveCount(caso.ck ? 1 : 0);
    await expect(page.getByRole("button", { name: "Asignar" })).toHaveCount(caso.ot ? 1 : 0);
    await expect(page.getByText("todas figuran operativas")).toHaveCount(detenida ? 0 : 1);
    await expect(actividad(page).getByRole("listitem")).toHaveCount(detenida ? 1 : 0);
    if (!detenida)
      await expect(actividad(page)).toContainText("Sin movimientos en los últimos 7 días.");
    if (caso.ck) await expect(actividad(page)).toContainText("La unidad no puede salir");
    if (caso.ot) await expect(actividad(page)).toContainText("OT #");
    if (!caso.ot) await expect(actividad(page)).not.toContainText("OT #");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(fallos).toEqual([]);
  });
}

test("una lectura fallida no muestra ceros y una lenta de antes no pisa a la nueva", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const empresa = await crearEmpresaSola(request, "mantenimiento", "centro-fallos");
  const caer = () =>
    page.route(RESUMEN, (ruta) =>
      ruta.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Fallo simulado" }),
      })
    );

  // ── La primera lectura falla: aviso, sin cifras ni «no hay equipos» ───
  await caer();
  await entrarPorPrimeraVez(page, empresa, menu(page));
  await expect(page.getByRole("alert")).toContainText("Fallo simulado");
  await expect(cifras(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Todavía no hay equipos" })).toHaveCount(0);
  await page.unroute(RESUMEN);
  await equipo(page, `UNO-${marca}`);
  await releerCentro(page);
  await expect(cifras(page)).toContainText("1 de 1");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // ── Falla una relectura: quedan los datos anteriores y se dice ────────
  await irA(page, "Equipos");
  await expect(page.getByRole("row", { name: new RegExp(`UNO-${marca}`) })).toBeVisible();
  await caer();
  await irA(page, "Centro de mantenimiento");
  await expect(page.getByRole("alert")).toContainText("ves los datos de la última lectura");
  await expect(cifras(page)).toContainText("1 de 1");
  await page.unroute(RESUMEN);

  // ── Una respuesta lenta con datos viejos llega después de la nueva ─────
  await irA(page, "Equipos");
  await expect(page.getByRole("row", { name: new RegExp(`UNO-${marca}`) })).toBeVisible();
  let soltar = () => {};
  const retenida = new Promise<void>((resolver) => (soltar = resolver));
  let avisar = () => {};
  const leida = new Promise<void>((resolver) => (avisar = resolver));
  let primera = true;
  await page.route(RESUMEN, async (ruta) => {
    if (!primera) return ruta.continue();
    primera = false;
    const vieja = await ruta.fetch();
    avisar();
    await retenida;
    await ruta.fulfill({ response: vieja });
  });
  await irA(page, "Centro de mantenimiento");
  await leida;
  await equipo(page, `DOS-${marca}`);
  await releerCentro(page);
  await expect(cifras(page)).toContainText("2 de 2");
  const llega = page.waitForResponse(RESUMEN);
  soltar();
  await (await llega).finished();
  await page.waitForTimeout(500);
  await expect(cifras(page)).toContainText("2 de 2");
});

test("si la actividad no se puede leer, avisa sin tumbar el Centro y deja reintentar", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const modulos = ["mantenimiento", "checklists"];
  const placa = `ACT-${randomBytes(2).toString("hex").toUpperCase()}`;
  const empresa = await crearEmpresaSola(request, modulos, "centro-actividad");
  const ruta = "**/api/erp/mantenimiento/actividad";
  await page.route(ruta, (r) => r.fulfill({ status: 500, body: "{}" }));
  await alCentro(page, empresa, modulos, async () => {
    const { id } = await equipo(page, placa);
    await llenar(page, (await formato(page)).id, { equipo_id: id });
  });

  await expect(actividad(page).getByRole("alert")).toContainText("No se pudo leer la actividad");
  await expect(actividad(page)).not.toContainText("Sin movimientos");
  await expect(cifras(page)).toContainText("1 de 1");
  await page.unroute(ruta);
  await actividad(page).getByRole("button", { name: "Reintentar" }).click();
  await expect(actividad(page).getByRole("listitem")).toContainText(["Checklist sin fallas"]);
  await expect(actividad(page).getByRole("listitem")).toContainText([placa]);
  await expect(actividad(page).getByText(/^Hoy \d{2}:\d{2}$/)).toBeVisible();
  await expect(actividad(page).getByRole("alert")).toHaveCount(0);
});

test("Lectura ve el Centro y recibe «Ver órdenes», no «Asignar»", async ({ page, request }) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const empresa = await crearEmpresaSola(request, TODO, "centro-lectura");
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: /^Gestión de mantenimiento/ }).first()
  );
  const { id } = await equipo(page, `LEC-${marca}`);
  const orden = await crear(page, "/api/erp/ordenes_trabajo", {
    equipo_id: id,
    titulo: "Revisar faja",
  });
  const dni = `96${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const password = `Lectura-${marca}-9x`;
  await crear(page, "/api/erp/usuarios", {
    nombre: `Lectura ${marca}`,
    dni,
    password,
    rol: "lectura",
  });
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: dni, password },
  });
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/mantenimiento");
  await page.getByLabel("Contraseña temporal").fill(password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(`Nueva-${marca}-7y`);
  await page.getByLabel("Confirmar nueva contraseña").fill(`Nueva-${marca}-7y`);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();

  await expect(cifras(page)).toContainText("Órdenes abiertas1", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Asignar" })).toHaveCount(0);
  await page.getByRole("button", { name: "Ver órdenes", exact: true }).click();
  await page.getByRole("button", { name: `Ver la orden ${orden.id}` }).click();
  const detalle = page.getByRole("dialog", { name: "Detalle de la orden" });
  await expect(detalle).toContainText("Falta asignar un mecánico");
  await expect(detalle.getByRole("button", { name: "Asignar mecánico" })).toHaveCount(0);
});

test("en el celular, con textos largos y muchas unidades, nada se sale", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const largo = (letra: string, n: number) => letra.repeat(n);
  const empresa = await crearEmpresaSola(request, TODO, "centro-celular");
  await alCentro(page, empresa, TODO, async () => {
    await crear(
      page,
      "/api/erp/mantenimiento/equipos/bulk",
      Array.from({ length: 40 }, (_, i) => ({
        placa_codigo: `MUCHAS-${String(i).padStart(3, "0")}`,
        tipo: "Volquete",
        marca: "",
        modelo: "",
        medidor: "horometro",
        lectura: 0,
        propiedad: "propia",
        area: largo("A", 50),
      }))
    );
    const f = await formato(page);
    await llenar(page, f.id, { activo_texto: largo("G", 150) }, "Frenos");
    await crear(page, "/api/erp/ordenes_trabajo", {
      activo_texto: largo("C", 150),
      titulo: largo("T", 200),
    });
  });
  await expect(cifras(page)).toContainText("40 de 40");

  for (const width of [393, 1366]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(panel(page, "Requieren tu atención")).toBeVisible();
    await expect(actividad(page).getByRole("listitem")).toHaveCount(3);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      )
      .toBe(0);
    // Tampoco por dentro: ningún texto ni botón queda cortado por el borde de su panel.
    const salidos = await page.locator("main section").evaluateAll((secciones) =>
      secciones.flatMap((s) => {
        const borde = s.getBoundingClientRect().right + 1;
        return [...s.querySelectorAll("b, span, button, strong")]
          .filter((el) => !el.closest(".truncate"))
          .filter((el) => el.getBoundingClientRect().right > borde)
          .map((el) => `${el.tagName} ${el.textContent?.slice(0, 30)}`);
      })
    );
    expect(salidos, `a ${width}px`).toEqual([]);
  }
  // Con 40 unidades en un área las barras se juntan por color.
  await expect(page.getByTitle("40 operativas")).toHaveCount(1);
});
