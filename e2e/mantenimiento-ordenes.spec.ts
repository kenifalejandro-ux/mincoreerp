/** e2e/mantenimiento-ordenes.spec.ts
 *
 * Órdenes de trabajo dentro del ecosistema «Gestión de mantenimiento» (M8):
 *
 * 1. La lista busca y filtra; el panel asigna, cambia y quita el mecánico sin tocar el resto de la orden.
 * 2. Una lectura fallida no parece «sin resultados», una lenta no pisa a la nueva y las páginas avanzan.
 * 3. Sin señal: una orden nueva entra una sola vez; asignar pide señal.
 * 4. Con IPERC se ve si está autorizado; desde un checklist se abre su orden.
 * 5. Lectura mira y no cambia nada.
 * 6. Sin IPERC ni Almacén no aparecen; sin Órdenes de trabajo no hay pantalla.
 * 7. En el celular, con textos largos, nada se sale.
 *
 * Cada test crea su propia empresa (no hay API para borrarlas: la base de los e2e es efímera en CI).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

const BASE = ["mantenimiento", "ordenes_trabajo"];
const API = "/api/erp/ordenes_trabajo";
const LISTA = /\/api\/erp\/ordenes_trabajo\?/;

const menu = (page: Page) =>
  page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
const entradaDelMenu = (page: Page, nombre: string) =>
  menu(page).getByRole("button", { name: new RegExp(`^${nombre}`) });
const titulo = (page: Page) => page.getByRole("heading", { name: "Órdenes de trabajo", level: 1 });
const filas = (page: Page) => page.locator("tbody tr");
const cifras = (page: Page) => page.getByRole("region", { name: "Cifras de órdenes" });
const buscador = (page: Page) => page.getByPlaceholder(/Buscar por OT/);
const filtro = (page: Page, name: string) => page.getByRole("combobox", { name, exact: true });
const panel = (page: Page) => page.getByRole("dialog", { name: "Detalle de la orden" });
const ventana = (page: Page) => page.getByRole("dialog", { name: "Asignar mecánico" });
const verOrden = (page: Page, id: number) =>
  page.getByRole("button", { name: `Ver la orden ${id}`, exact: true });
const marca = () => randomBytes(2).toString("hex").toUpperCase();
const dni = () => `93${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;

async function crear(page: Page, url: string, data: unknown) {
  const r = await page.request.post(url, { data });
  expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
}
const orden = async (page: Page, data: Record<string, unknown>) =>
  Number((await crear(page, API, { activo_texto: "Horno 4", titulo: "Engrase", ...data })).id);
const mecanico = (page: Page, nombre: string) =>
  crear(page, "/api/erp/usuarios", {
    nombre,
    dni: dni(),
    password: "Mecanico-9x-clave",
    rol: "mecanico",
  });
const leer = async (page: Page, id: number) => (await page.request.get(`${API}/${id}`)).json();

/** Entra a una empresa recién creada, siembra y deja abierto Órdenes de trabajo. */
async function aOrdenes(
  page: Page,
  empresa: Awaited<ReturnType<typeof crearEmpresaSola>>,
  sembrar: () => Promise<void> = async () => {}
) {
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
  await entradaDelMenu(page, "Órdenes de trabajo").click();
  await expect(titulo(page)).toBeVisible();
}

function vigilar(page: Page) {
  const fallos: string[] = [];
  page.on("pageerror", (e) => fallos.push(e.message));
  page.on("response", (r) => {
    if (r.url().includes("/api/erp/") && r.status() >= 400) fallos.push(`${r.status()} ${r.url()}`);
  });
  return fallos;
}

test("busca, filtra y asigna, cambia y quita el mecánico sin tocar la orden", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const m = marca();
  const [ana, beto] = [`Ana ${m}`, `Beto ${m}`];
  const empresa = await crearEmpresaSola(request, BASE, "ot-asigna");
  const fallos = vigilar(page);
  let frenos = 0;
  let engrase = 0;
  await aOrdenes(page, empresa, async () => {
    const area = await crear(page, "/api/erp/mantenimiento/areas", { nombre: "Cantera" });
    const u = await crear(page, "/api/erp/mantenimiento/equipos", {
      placa_codigo: `VOL-${m}`,
      tipo: "Volquete",
      area_id: area.id,
    });
    await mecanico(page, beto);
    await mecanico(page, ana);
    frenos = await orden(page, {
      equipo_id: Number(u.id),
      activo_texto: undefined,
      titulo: "Frenos",
      descripcion: "Ruido al frenar",
      prioridad: "urgente",
      fecha_programada: "2026-01-15",
      tareas: [{ descripcion: "Cambiar pastillas" }],
    });
    engrase = await orden(page, { tipo: "preventivo" });
  });

  await expect(filas(page)).toHaveCount(2);
  await expect(cifras(page)).toContainText("Abiertas2");
  await expect(cifras(page)).toContainText("Urgentes1");
  await expect(filas(page).filter({ hasText: "Frenos" })).toContainText("Volquete · Cantera");
  await expect(filas(page).filter({ hasText: "Frenos" })).toContainText("programada 15/01/2026");

  await buscador(page).fill(`VOL-${m}`);
  await expect(filas(page)).toHaveCount(1);
  await buscador(page).fill("no existe");
  await expect(filas(page)).toContainText(["Sin resultados"]);
  await buscador(page).fill("");
  await filtro(page, "Tipo").selectOption("preventivo");
  await expect(filas(page)).toContainText(["Engrase"]);
  await expect(filas(page)).toHaveCount(1);
  await filtro(page, "Tipo").selectOption("");
  await filtro(page, "Área").selectOption({ label: "Cantera" });
  await expect(filas(page)).toHaveCount(1);
  await expect(filas(page)).toContainText(["Frenos"]);
  await filtro(page, "Área").selectOption("");
  await filtro(page, "Estado").selectOption("completada");
  await expect(filas(page)).toContainText(["Sin resultados"]);
  await filtro(page, "Estado").selectOption("");

  // ── Asignar: nada marcado, buscar, marcar y desmarcar; Escape no cierra el panel ─
  const antes = await leer(page, frenos);
  await verOrden(page, frenos).click();
  await panel(page).getByRole("button", { name: "Asignar mecánico" }).click();
  await expect(ventana(page).getByRole("button", { name: "Marca un mecánico" })).toBeDisabled();
  await expect(ventana(page).getByRole("checkbox")).toContainText([ana, beto]);
  await ventana(page).getByPlaceholder("Buscar mecánico...").fill("beto");
  await expect(ventana(page).getByRole("checkbox")).toHaveCount(1);
  await ventana(page).getByRole("checkbox").click();
  await ventana(page).getByRole("checkbox").click();
  await expect(ventana(page).getByRole("button", { name: "Marca un mecánico" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(ventana(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();

  await panel(page).getByRole("button", { name: "Asignar mecánico" }).click();
  await ventana(page)
    .getByRole("checkbox", { name: new RegExp(ana) })
    .click();
  await ventana(page)
    .getByRole("button", { name: `Asignar a ${ana}` })
    .dblclick();
  await expect(ventana(page)).toHaveCount(0);
  await expect(panel(page)).toContainText("Lista para iniciar");
  await expect(panel(page).getByRole("button", { name: "Asignar mecánico" })).toHaveCount(0);
  await expect(filas(page).filter({ hasText: "Frenos" })).toContainText(ana);
  const despues = await leer(page, frenos);
  for (const campo of ["titulo", "descripcion", "prioridad", "fecha_programada", "tareas"]) {
    expect(despues[campo], campo).toEqual(antes[campo]);
  }

  // Guardar horas no borra al mecánico.
  await panel(page).getByRole("button", { name: "Horas y tareas" }).click();
  const horas = page.getByRole("dialog", { name: /^Horas y tareas de la orden/ });
  await horas.getByRole("checkbox", { name: "Cambiar pastillas" }).check();
  await horas.getByLabel("La unidad no puede operar").check();
  await horas.getByRole("button", { name: "Guardar horas" }).click();
  await expect(horas.getByRole("status")).toContainText("Guardado");
  await horas.getByRole("button", { name: "Cerrar" }).click();
  await expect(panel(page)).toContainText("Tareas: 1 de 1");
  await expect(panel(page)).toContainText("La unidad no puede operar");
  expect((await leer(page, frenos)).asignado_a).toBe(despues.asignado_a);

  // La carga de Ana se ve al asignar otra orden y queda después de quien está libre.
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  await verOrden(page, engrase).click();
  await panel(page).getByRole("button", { name: "Asignar mecánico" }).click();
  await expect(ventana(page).getByRole("checkbox")).toContainText([beto, ana]);
  await expect(ventana(page).getByRole("checkbox").last()).toContainText("1 orden abierta");
  await ventana(page).getByRole("button", { name: "Cancelar" }).click();
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();

  // Cambiar y quitar.
  await verOrden(page, frenos).click();
  await panel(page)
    .getByRole("button", { name: new RegExp(`^${ana}\\s*Cambiar`) })
    .click();
  await expect(ventana(page).getByRole("button", { name: "Marca un mecánico" })).toBeDisabled();
  await ventana(page)
    .getByRole("checkbox", { name: new RegExp(beto) })
    .click();
  await ventana(page)
    .getByRole("button", { name: `Asignar a ${beto}` })
    .click();
  await expect(panel(page).getByRole("button", { name: new RegExp(`^${beto}`) })).toBeVisible();
  await panel(page)
    .getByRole("button", { name: new RegExp(`^${beto}`) })
    .click();
  await ventana(page).getByRole("button", { name: "Quitar mecánico" }).click();
  await expect(panel(page)).toContainText("Falta asignar un mecánico");
  expect((await leer(page, frenos)).asignado_a).toBeNull();

  // ── Otra persona cierra la orden mientras se asigna: se dice y no cambia ─
  await panel(page).getByRole("button", { name: "Asignar mecánico" }).click();
  await ventana(page)
    .getByRole("checkbox", { name: new RegExp(ana) })
    .click();
  const cierre = await page.request.patch(`${API}/${frenos}/estado`, {
    data: { estado: "cancelada" },
  });
  expect(cierre.status(), await cierre.text()).toBe(200);
  await ventana(page)
    .getByRole("button", { name: `Asignar a ${ana}` })
    .click();
  await expect(ventana(page).getByRole("alert")).toContainText("ya está cerrada");
  expect((await leer(page, frenos)).asignado_a).toBeNull();
  await ventana(page).getByRole("button", { name: "Cancelar" }).click();
  // Tras el rechazo, el panel debe mostrar cómo quedó la orden, sin cerrarlo.
  await expect(panel(page), "panel tras el rechazo").toContainText("Orden cancelada");
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  await verOrden(page, frenos).click();
  await expect(panel(page)).toContainText("Orden cancelada");
  await expect(panel(page).getByRole("button", { name: "Asignar mecánico" })).toHaveCount(0);
  expect(fallos.filter((f) => !f.startsWith("409 "))).toEqual([]);
});

test("pagina y aguanta fallos y respuestas lentas", async ({ page, request }) => {
  test.setTimeout(240_000);
  const m = marca();
  const empresa = await crearEmpresaSola(request, BASE, "ot-lista");
  let primera = 0;
  await aOrdenes(page, empresa, async () => {
    primera = await orden(page, { titulo: `Primera ${m}` });
    for (let i = 0; i < 25; i++) await orden(page, { titulo: `Relleno ${i}` });
  });

  await expect(filas(page)).toHaveCount(25);
  await expect(page.getByText("Página 1 de 2")).toBeVisible();
  await page.getByRole("button", { name: "Siguiente" }).click();
  await expect(filas(page)).toHaveCount(1);
  await expect(filas(page)).toContainText([`Primera ${m}`]);
  // Un filtro vuelve a la primera página.
  await filtro(page, "Estado").selectOption("abierta");
  await expect(page.getByText("Página 1 de 2")).toBeVisible();

  // La lista falla: aviso, nunca «Sin resultados»; Reintentar la recupera.
  await page.route(LISTA, (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: '{"message":"Fallo"}' })
  );
  await buscador(page).fill("Relleno");
  await expect(page.getByRole("alert")).toContainText("No se pudo leer la lista");
  await expect(page.getByText("Sin resultados")).toHaveCount(0);
  await page.unroute(LISTA);
  await page.getByRole("button", { name: "Reintentar" }).click();
  await expect(filas(page)).toHaveCount(25);

  // Una respuesta vieja que llega tarde no pisa a la nueva.
  let soltar = () => {};
  const retenida = new Promise<void>((r) => (soltar = r));
  let avisar = () => {};
  const leida = new Promise<void>((r) => (avisar = r));
  await page.route(/q=Relleno\+1(&|$)/, async (ruta) => {
    const vieja = await ruta.fetch();
    avisar();
    await retenida;
    await ruta.fulfill({ response: vieja });
  });
  await buscador(page).fill("Relleno 1");
  await leida;
  await buscador(page).fill(`Primera ${m}`);
  await expect(filas(page)).toHaveCount(1);
  const llega = page.waitForResponse(/q=Relleno\+1(&|$)/);
  soltar();
  await (await llega).finished();
  await page.waitForTimeout(500);
  await expect(filas(page)).toContainText([`Primera ${m}`]);
  await expect(filas(page)).toHaveCount(1);

  // El panel no se puede leer: avisa y deja volver a leer.
  const detalle = `**/api/erp/ordenes_trabajo/${primera}`;
  await page.route(detalle, (r) => r.fulfill({ status: 500, body: "{}" }));
  await verOrden(page, primera).click();
  await expect(panel(page).getByRole("alert")).toContainText("No se pudo leer la orden");
  await page.unroute(detalle);
  await panel(page).getByRole("button", { name: "Volver a leer" }).click();
  await expect(panel(page)).toContainText(`Primera ${m}`);
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
});

test("sin señal: la orden nueva entra una sola vez y asignar pide señal", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(240_000);
  const m = marca();
  const empresa = await crearEmpresaSola(request, BASE, "ot-off");
  const avisos: string[] = [];
  page.on("dialog", (d) => {
    avisos.push(d.message());
    void d.accept();
  });
  await aOrdenes(page, empresa, async () => {
    await mecanico(page, `Ana ${m}`);
  });
  await expect(filas(page)).toContainText(["Sin resultados"]);

  await context.setOffline(true);
  await page.getByRole("button", { name: "Nueva OT" }).click();
  const nueva = page.getByRole("dialog", { name: "Nueva Orden de Trabajo" });
  await nueva.getByLabel(/^Activo o lugar/).fill("Faja 2");
  await nueva.getByLabel("Título", { exact: true }).fill(`Rodillo ${m}`);
  // A quién asignar se leyó antes de perder la señal.
  await nueva.getByLabel("Asignado a (opcional)").selectOption({ label: `Ana ${m}` });
  await nueva.getByRole("button", { name: "Registrar Orden de Trabajo" }).dblclick();
  await expect.poll(() => avisos.join(" ")).toContain("Sin conexión");
  await expect(nueva).toHaveCount(0);

  await context.setOffline(false);
  await expect(filas(page)).toContainText([`Rodillo ${m}`], { timeout: 45_000 });
  await expect(filas(page)).toHaveCount(1);
  await expect(filas(page)).toContainText([`Ana ${m}`]);
  await expect(cifras(page)).toContainText("Abiertas1");

  await page.getByRole("button", { name: /^Ver la orden/ }).click();
  await panel(page)
    .getByRole("button", { name: new RegExp(`^Ana ${m}`) })
    .click();
  await expect(ventana(page).getByRole("checkbox")).toHaveCount(1);
  await context.setOffline(true);
  await ventana(page).getByRole("button", { name: "Quitar mecánico" }).click();
  await expect(ventana(page).getByRole("alert")).toContainText("necesita señal");
  await context.setOffline(false);
  await ventana(page).getByRole("button", { name: "Quitar mecánico" }).click();
  await expect(panel(page)).toContainText("Falta asignar un mecánico");
});

test("con IPERC se ve si está autorizado y un checklist abre su orden", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const m = marca();
  const empresa = await crearEmpresaSola(
    request,
    [...BASE, "iperc", "checklists", "repuestos"],
    "ot-iperc"
  );
  const fallos = vigilar(page);
  let conIperc = 0;
  let iperc = 0;
  let deChecklist = 0;
  await aOrdenes(page, empresa, async () => {
    iperc = Number(
      (
        await crear(page, "/api/erp/iperc", {
          area_frente: "Taller",
          items: [
            {
              etapa_actividad: "Desmontaje",
              peligro: "Carga suspendida",
              riesgo: "Golpe",
              probabilidad: 2,
              severidad: 2,
              medidas_control: "Señalizar",
            },
          ],
        })
      ).id
    );
    conIperc = await orden(page, { titulo: `Con IPERC ${m}`, iperc_id: iperc });
    const formato = await crear(page, "/api/erp/checklists/plantillas", {
      nombre: "Pre-uso",
      items: [{ descripcion: "Frenos", critica: true }],
    });
    deChecklist = (
      await crear(page, "/api/erp/checklists", {
        plantilla_id: formato.id,
        activo_texto: `Bomba ${m}`,
        items: [{ descripcion: "Frenos", estado: "malo" }],
      })
    ).orden_trabajo_id;
  });

  const fila = filas(page).filter({ hasText: `Con IPERC ${m}` });
  await expect(fila).toContainText("Sin autorizar");
  await verOrden(page, conIperc).click();
  await expect(panel(page)).toContainText("IPERC recomendado");
  await expect(panel(page).getByRole("region", { name: "Repuestos" })).toContainText("Pronto");
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  const aprobado = await page.request.patch(`/api/erp/iperc/${iperc}/estado`, {
    data: { estado: "aprobado" },
  });
  expect(aprobado.status(), await aprobado.text()).toBe(200);
  await filtro(page, "Estado").selectOption("abierta");
  await expect(fila).toContainText("Autorizado");
  await verOrden(page, conIperc).click();
  await expect(panel(page)).toContainText("IPERC autorizado");
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();

  await entradaDelMenu(page, "Checklists").click();
  await page.getByRole("button", { name: /^Ver el checklist/ }).click();
  await page.getByRole("button", { name: "Ver órdenes de trabajo" }).click();
  await expect(page).toHaveURL(/\/mantenimiento\/ordenes$/);
  await expect(panel(page)).toContainText(`OT #${deChecklist}`);
  await expect(panel(page)).toContainText("Falla reportada");
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  // Por el menú se entra sin panel abierto.
  await entradaDelMenu(page, "Equipos").click();
  await entradaDelMenu(page, "Órdenes de trabajo").click();
  await expect(filas(page)).toHaveCount(2);
  await expect(panel(page)).toHaveCount(0);
  expect(fallos).toEqual([]);
});

test("Lectura ve la lista y el panel sin poder cambiar nada", async ({ page, request }) => {
  test.setTimeout(180_000);
  const m = marca();
  const empresa = await crearEmpresaSola(request, BASE, "ot-lectura");
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: /^Gestión de mantenimiento/ }).first()
  );
  const id = await orden(page, { titulo: `Solo mirar ${m}` });
  const documento = dni();
  const password = `Lectura-${m}-9x`;
  await crear(page, "/api/erp/usuarios", {
    nombre: `Lectura ${m}`,
    dni: documento,
    password,
    rol: "lectura",
  });
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: documento, password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const fallos = vigilar(page);
  await page.goto("/mantenimiento/ordenes");
  await page.getByLabel("Contraseña temporal").fill(password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(`Nueva-${m}-7y`);
  await page.getByLabel("Confirmar nueva contraseña").fill(`Nueva-${m}-7y`);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();

  await expect(titulo(page)).toBeVisible({ timeout: 20_000 });
  await expect(filas(page)).toContainText([`Solo mirar ${m}`]);
  await expect(page.getByRole("button", { name: "Nueva OT" })).toHaveCount(0);
  await expect(filtro(page, "Mecánico").locator("option")).toHaveText([
    "Todos los mecánicos",
    "Sin asignar",
  ]);
  await verOrden(page, id).click();
  await expect(panel(page)).toContainText("Falta asignar un mecánico");
  await expect(panel(page).getByRole("button", { name: "Asignar mecánico" })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Horas y tareas" }).click();
  const horas = page.getByRole("dialog", { name: /^Horas y tareas de la orden/ });
  await expect(horas.getByLabel("Hora de inicio")).toBeDisabled();
  await expect(horas.getByRole("button", { name: "Guardar horas" })).toHaveCount(0);
  // Quien solo mira no pide lo que el servidor le niega.
  expect(fallos, "peticiones rechazadas").toEqual([]);
});

test("sin IPERC ni Almacén no aparecen; sin Órdenes de trabajo no hay pantalla", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, BASE, "ot-sola");
  const fallos = vigilar(page);
  let id = 0;
  await aOrdenes(page, empresa, async () => {
    id = await orden(page, {});
  });
  await expect(page.getByRole("columnheader", { name: "IPERC" })).toHaveCount(0);
  await verOrden(page, id).click();
  await expect(panel(page)).toContainText("Cómo avanza");
  await expect(panel(page)).not.toContainText("IPERC");
  await expect(panel(page).getByRole("region", { name: "Repuestos" })).toHaveCount(0);
  expect(fallos).toEqual([]);

  const sola = await crearEmpresaSola(request, "mantenimiento", "ot-sin");
  await page.request.post("/api/auth/logout");
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await entrarPorPrimeraVez(page, sola, menu(page));
  await expect(menu(page).getByRole("button", { name: /Órdenes de trabajo/ })).toHaveCount(0);
  await page.evaluate(() => {
    window.history.pushState(null, "", "/mantenimiento/ordenes");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "Todavía no hay equipos" })).toBeVisible();
  await expect(titulo(page)).toHaveCount(0);
  expect(fallos).toEqual([]);
});

test("en el celular, con textos largos, nada se sale", async ({ page, request }) => {
  test.setTimeout(240_000);
  const largo = (letra: string, n: number) => letra.repeat(n);
  const empresa = await crearEmpresaSola(request, BASE, "ot-celular");
  let id = 0;
  await aOrdenes(page, empresa, async () => {
    await mecanico(page, largo("M", 90));
    await crear(page, "/api/erp/mantenimiento/areas", { nombre: largo("A", 50) });
    id = await orden(page, {
      activo_texto: largo("C", 150),
      titulo: largo("T", 200),
      descripcion: largo("D", 600),
    });
  });
  await page.setViewportSize({ width: 393, height: 800 });
  const cabe = async (donde: string) => {
    const sobra = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(sobra, donde).toBeLessThanOrEqual(0);
  };
  const dentro = async (nombre: "panel" | "ventana") => {
    const caja = nombre === "panel" ? panel(page) : ventana(page);
    const sobra = await caja.evaluate((el) =>
      Math.max(
        ...[el, ...el.querySelectorAll("div, section, ul, button, header")].map(
          (n) => n.getBoundingClientRect().right - window.innerWidth
        )
      )
    );
    expect(sobra, nombre).toBeLessThanOrEqual(1);
  };
  await expect(filas(page)).toHaveCount(1);
  await cabe("lista");
  await verOrden(page, id).click();
  await expect(panel(page)).toContainText("Cómo avanza");
  await cabe("panel");
  await dentro("panel");
  await panel(page).getByRole("button", { name: "Asignar mecánico" }).click();
  await expect(ventana(page).getByRole("checkbox")).toHaveCount(1);
  await dentro("ventana");
  await ventana(page).getByRole("checkbox").click();
  await expect(ventana(page).getByRole("button", { name: /^Asignar a/ })).toBeInViewport();
  await dentro("ventana");
  // Ya asignado, el nombre largo también cabe en el panel.
  await ventana(page)
    .getByRole("button", { name: /^Asignar a/ })
    .click();
  await expect(panel(page)).toContainText("Lista para iniciar");
  await dentro("panel");
});
