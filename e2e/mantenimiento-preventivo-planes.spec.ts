/** e2e/mantenimiento-preventivo-planes.spec.ts
 *
 * Mantenimiento preventivo → Planes (M9), con empresas que tienen SOLO Mantenimiento:
 *
 * 1. Vacía avisa qué falta; con planes muestra la regla, los niveles, quién lo usa y los tipos sin plan.
 * 2. El panel de un nivel se abre con clic o teclado y se cierra con ✕, Escape, fuera o «atrás».
 * 3. Una lectura fallida o sin señal se dice y se puede reintentar; nunca parece «no hay planes».
 * 4. Lectura ve lo mismo y la pantalla no pide nada que el servidor le niegue.
 * 5. Con textos largos y ciclos de 12 pasos nada se sale, de celular a escritorio.
 * 6. Con datos corrientes se lee entero en celular, tablet y laptop chica.
 *
 * Cada test crea su propia empresa (no hay API para borrarlas: la base de los e2e es efímera en CI).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

const API = "/api/erp/mantenimiento";
const PLANES = /\/api\/erp\/mantenimiento\/planes$/;
const RESUMEN = /\/api\/erp\/mantenimiento\/preventivo$/;

const menu = (page: Page) =>
  page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
const entradaDelMenu = (page: Page, nombre: string) =>
  menu(page).getByRole("button", { name: new RegExp(`^${nombre}`) });
const titulo = (page: Page) => page.getByRole("heading", { name: /^Planes MP1/, level: 1 });
const lista = (page: Page) => page.getByRole("navigation", { name: "Planes por tipo de equipo" });
const regla = (page: Page) => page.getByRole("region", { name: "Cómo funciona" });
const niveles = (page: Page) => page.getByRole("region", { name: "Niveles del plan" });
const usan = (page: Page) => page.getByRole("region", { name: "Quién usa este plan" });
const sinPlan = (page: Page) => page.getByRole("region", { name: "Tipos sin plan" });
const panel = (page: Page) => page.getByRole("dialog", { name: "Detalle del nivel" });
const verNivel = (page: Page, n: number) =>
  page.getByRole("button", { name: `Ver el MP${n}` }).filter({ visible: true });
const aviso = (page: Page) => page.getByRole("alert");
const marca = () => randomBytes(2).toString("hex").toUpperCase();
const dni = () => `93${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;

async function crear(page: Page, url: string, data: unknown) {
  const r = await page.request.post(`${API}${url}`, { data });
  expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
}
const equipo = async (page: Page, data: Record<string, unknown>) =>
  Number((await crear(page, "/equipos", data)).id);
const TAREAS = {
  "1": { tareas: ["Cambio de aceite", "Engrase general"], repuestos: ["Filtro de aceite × 1"] },
  "2": { tareas: ["Filtro de aire"] },
  "3": { tareas: ["Aceite de corona"] },
};
const plan = (page: Page, tipo_equipo: string, extra: Record<string, unknown> = {}) =>
  crear(page, "/planes", {
    tipo_equipo,
    medida: "horometro",
    intervalo: 250,
    ciclo: [1, 2, 1, 3],
    niveles: TAREAS,
    ...extra,
  });
const servicio = (page: Page, equipo_id: number, paso: number, lectura: number) =>
  crear(page, "/preventivo/servicios", {
    cliente_uuid: randomUUID(),
    equipo_id,
    nivel: [1, 2, 1, 3][paso],
    paso,
    lectura,
    hecho_en: "2026-01-10T12:00:00Z",
  });

/** Cuatro volquetes (al día, próximo, vencido, sin datos), un horno sin plan. */
async function sembrarVolquetes(page: Page) {
  const volquete = (placa_codigo: string, lectura: number, extra = {}) =>
    equipo(page, { placa_codigo, tipo: "Volquete", lectura, ...extra });
  const alDia = await volquete("AL-DIA", 1100);
  const proximo = await volquete("PROXIMO", 1230, { propiedad: "alquilada" });
  const vencido = await volquete("VENCIDO", 1400);
  await volquete("NUEVO", 50);
  await equipo(page, { placa_codigo: "H-4", tipo: "Horno" });
  await plan(page, "Volquete");
  for (const id of [alDia, proximo, vencido]) await servicio(page, id, 0, 1000);
}

/** Entra a una empresa recién creada, siembra y deja el ecosistema abierto en el Centro. */
async function alEcosistema(
  page: Page,
  empresa: Awaited<ReturnType<typeof crearEmpresaSola>>,
  sembrar: () => Promise<void> = async () => {}
) {
  const entrada = page.getByRole("button", { name: /^Gestión de mantenimiento/ }).first();
  await entrarPorPrimeraVez(page, empresa, entrada.or(menu(page)).first());
  await sembrar();
  if (!(await menu(page).isVisible())) {
    await entrada.click();
    if (!(await menu(page).isVisible())) {
      await page
        .getByRole("button", { name: /Centro de mantenimiento/ })
        .first()
        .click();
    }
  }
  await expect(menu(page)).toBeVisible();
}

/** Entra (o vuelve a entrar) a Preventivo por el menú: la pantalla se lee de nuevo. */
async function aPlanes(page: Page) {
  await entradaDelMenu(page, "Centro de mantenimiento").click();
  await entradaDelMenu(page, "Mantenimiento preventivo").click();
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

test("vacía avisa qué falta y con un plan muestra la regla, los niveles y quién lo usa", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "pm-ver");
  await alEcosistema(page, empresa);
  const fallos = vigilar(page);

  await expect(entradaDelMenu(page, "Mantenimiento preventivo")).toContainText("Nuevo");
  await aPlanes(page);
  await expect(page).toHaveURL(/\/mantenimiento\/preventivo$/);
  await expect(page).toHaveTitle("Mantenimiento preventivo · Gestión de mantenimiento");
  await expect(page.getByText("Primero registra tus equipos")).toBeVisible();
  await expect(lista(page)).toHaveCount(0);
  await expect(sinPlan(page)).toHaveCount(0);
  for (const pronto of ["Resumen", "Calendario"]) {
    await expect(page.getByRole("tab", { name: new RegExp(`^${pronto}`) })).toBeDisabled();
  }

  await equipo(page, { placa_codigo: "H-9", tipo: "Horno" });
  await aPlanes(page);
  await expect(page.getByText("llega en la próxima entrega")).toBeVisible();
  await expect(sinPlan(page)).toContainText("Horno · 1 equipo");

  await sembrarVolquetes(page);
  await plan(page, "Camioneta", {
    medida: "odometro",
    intervalo: 5000,
    aviso_antes: 0,
    ciclo: [1, 3],
    niveles: { "1": TAREAS["1"], "3": TAREAS["3"] },
  });
  await equipo(page, { placa_codigo: "CAM-1", tipo: "camioneta", lectura: 10 });
  await aPlanes(page);

  await expect(page.getByRole("tab", { name: /^Planes/ })).toContainText("2");
  await expect(lista(page).getByRole("button")).toHaveText([
    /Camioneta.*1 equipo · cada 5,000 km/,
    /Volquete.*4 equipos · cada 250 h/,
  ]);
  // Abre el primero de la lista.
  await expect(regla(page)).toContainText("Camioneta: un servicio cada 5,000 km");
  await expect(regla(page)).toContainText("MP1 → MP3");
  await expect(regla(page)).toContainText("pasa directo a «Vencido»");
  await expect(niveles(page)).not.toContainText("Servicio intermedio");
  // Sin MP2, el MP3 suma lo del MP1.
  await expect(niveles(page).locator("tbody tr").nth(1)).toContainText("+ todo lo del MP1");
  await expect(usan(page)).toContainText("El equipo mide en h y el plan en km");

  await lista(page)
    .getByRole("button", { name: /Volquete/ })
    .click();
  await expect(regla(page)).toContainText("MP1 → MP2 → MP1 → MP3");
  await expect(regla(page)).toContainText("cuando faltan 25 h o menos");
  await expect(niveles(page).locator("tbody tr")).toHaveText([
    /MP1.*Servicio básico.*2 veces por ciclo.*2.*1 sugerido/,
    /MP2.*Servicio intermedio.*1 vez por ciclo.*1.*\+ todo lo del MP1.*—/,
    /MP3.*Servicio mayor.*1 vez por ciclo.*1.*\+ todo lo del MP2.*—/,
  ]);
  await expect(usan(page)).toContainText("4 equipos");
  const fila = (placa: string) => usan(page).getByRole("listitem").filter({ hasText: placa });
  await expect(fila("AL-DIA")).toContainText(/MP2.*en 150 h.*Al día/);
  await expect(fila("PROXIMO")).toContainText(/Alquilada.*en 20 h.*Próximo/);
  await expect(fila("VENCIDO")).toContainText(/pasó 150 h.*Vencido/);
  await expect(fila("NUEVO")).toContainText(/Sin un servicio registrado.*Sin datos/);
  await expect(usan(page)).not.toContainText("CAM-1");
  await expect(sinPlan(page)).toContainText("Horno · 2 equipos");

  // El panel, con clic en la fila.
  await niveles(page).locator("tbody tr").nth(1).click();
  await expect(panel(page)).toContainText("Volquete · MP2");
  await expect(panel(page)).toContainText("cada 250 h (1 vez por ciclo)");
  await expect(panel(page)).toContainText("Incluye todo lo del MP1");
  await expect(panel(page)).toContainText("Filtro de aire");
  await expect(panel(page)).toContainText("Este nivel no tiene repuestos");
  await expect(panel(page)).toContainText("VENCIDOPróximo: MP2 · Vencido");
  await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
  await expect(panel(page)).toHaveCount(0);

  // Con teclado: abre, Escape cierra y el foco vuelve al botón.
  await verNivel(page, 1).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toContainText("Volquete · MP1");
  await expect(panel(page)).not.toContainText("Incluye todo");
  await expect(panel(page)).toContainText("Filtro de aceite × 1");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(verNivel(page, 1)).toBeFocused();

  // Pulsar fuera de la hoja.
  await verNivel(page, 3).click();
  await expect(panel(page)).toBeVisible();
  // La sombra queda entre el menú y la hoja.
  const hoja = (await panel(page).boundingBox())!;
  await page.mouse.click(hoja.x - 8, hoja.y + 200);
  await expect(panel(page)).toHaveCount(0);

  // «Atrás» con el panel abierto sale de la sección sin dejar el panel; «adelante» vuelve.
  await verNivel(page, 3).click();
  await expect(panel(page)).toBeVisible();
  await page.goBack();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mantenimiento$/);
  await page.goForward();
  await expect(titulo(page)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);

  expect(fallos).toEqual([]);
});

test("una lectura fallida o sin señal se dice, se reintenta y no parece «no hay planes»", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(240_000);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "pm-fallo");
  await alEcosistema(page, empresa, () => sembrarVolquetes(page));

  for (const ruta of [PLANES, RESUMEN]) {
    await page.route(ruta, (r) =>
      r.fulfill({ status: 500, contentType: "application/json", body: '{"message":"Se cayó"}' })
    );
    await aPlanes(page);
    await expect(aviso(page)).toContainText("No se pudieron cargar los planes. Se cayó");
    await expect(page.getByText("Todavía no hay planes")).toHaveCount(0);
    await expect(lista(page)).toHaveCount(0);
    await expect(page.getByText("Cargando…")).toHaveCount(0);
    await page.unroute(ruta);
    await aviso(page).getByRole("button", { name: "Reintentar" }).click();
    await expect(regla(page)).toContainText("Volquete");
    await expect(aviso(page)).toHaveCount(0);
  }

  await entradaDelMenu(page, "Centro de mantenimiento").click();
  await context.setOffline(true);
  await entradaDelMenu(page, "Mantenimiento preventivo").click();
  await expect(aviso(page)).toContainText("Sin conexión: ver los planes necesita señal.");
  await expect(page.getByText("Todavía no hay planes")).toHaveCount(0);
  // Reintentar todavía sin señal: sigue diciéndolo.
  await aviso(page).getByRole("button", { name: "Reintentar" }).click();
  await expect(aviso(page)).toContainText("necesita señal");
  await context.setOffline(false);
  await aviso(page).getByRole("button", { name: "Reintentar" }).click();
  await expect(usan(page)).toContainText("4 equipos");
});

test("Lectura ve los planes y el panel sin pedir nada que se le niegue", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const m = marca();
  const empresa = await crearEmpresaSola(request, "mantenimiento", "pm-lectura");
  await entrarPorPrimeraVez(
    page,
    empresa,
    page
      .getByRole("button", { name: /^Gestión de mantenimiento/ })
      .or(menu(page))
      .first()
  );
  await sembrarVolquetes(page);
  const documento = dni();
  const password = `Lectura-${m}-9x`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Lectura ${m}`, dni: documento, password, rol: "lectura" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: documento, password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const fallos = vigilar(page);
  await page.goto("/mantenimiento/preventivo");
  await page.getByLabel("Contraseña temporal").fill(password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(`Nueva-${m}-7y`);
  await page.getByLabel("Confirmar nueva contraseña").fill(`Nueva-${m}-7y`);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();

  // La dirección guardada abre Preventivo directamente.
  await expect(titulo(page)).toBeVisible({ timeout: 20_000 });
  await expect(usan(page)).toContainText("4 equipos");
  await verNivel(page, 2).click();
  await expect(panel(page)).toContainText("Filtro de aire");
  await expect(
    page.getByRole("button", { name: /Nuevo plan|Editar|Registrar|Quitar/ })
  ).toHaveCount(0);
  expect(fallos, "peticiones rechazadas").toEqual([]);
});

test("con textos largos y ciclos de 12 pasos nada se sale, del celular al escritorio", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const largo = "Retroexcavadora hidraulica sobre orugas de gran tonelaje";
  const corrido = "W".repeat(60);
  const placa = "Z".repeat(40);
  const linea = "k".repeat(160);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "pm-largo");
  await alEcosistema(page, empresa, async () => {
    const conTextos = {
      "1": { tareas: [linea], repuestos: [linea] },
      "2": { tareas: [linea] },
      "3": { tareas: [linea] },
    };
    for (const tipo of [corrido, largo]) {
      const id = await equipo(page, { placa_codigo: `${placa.slice(1)}${tipo[0]}`, tipo });
      await plan(page, tipo, {
        intervalo: 1_000_000,
        ciclo: [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 3],
        niveles: conTextos,
      });
      await servicio(page, id, 0, 9_000_000);
    }
    await equipo(page, { placa_codigo: "SIN-1", tipo: "Q".repeat(60) });
  });

  /** Lo que sobresale a lo ancho dentro de un bloque, sin contar las cajas que se desplazan a propósito. */
  const desborde = (selector: ReturnType<typeof usan>) =>
    selector.evaluate((raiz) => {
      const limite = raiz.getBoundingClientRect().right + 1;
      return [...raiz.querySelectorAll<HTMLElement>("*")]
        .filter((el) => !el.closest(".overflow-x-auto") && el.offsetParent !== null)
        .filter((el) => el.getBoundingClientRect().right > limite)
        .map((el) => `${el.tagName} ${(el.textContent ?? "").slice(0, 30)}`);
    });

  for (const [ancho, alto] of [
    [360, 740],
    [393, 851],
    [768, 1024],
    [1024, 768],
    [1366, 768],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width: 1366, height: 900 });
    await aPlanes(page);
    await page.setViewportSize({ width: ancho, height: alto });
    for (const nombre of [corrido, largo]) {
      await lista(page)
        .getByRole("button", { name: new RegExp(nombre.slice(0, 20)) })
        .click();
      const pagina = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect.soft(pagina, `${ancho}: la página se ensancha`).toBeLessThanOrEqual(0);
      for (const [bloque, region] of [
        ["regla", regla(page)],
        ["niveles", niveles(page)],
        ["quién usa", usan(page)],
        ["sin plan", sinPlan(page)],
      ] as const) {
        expect.soft(await desborde(region), `${ancho}: ${bloque}`).toEqual([]);
      }
    }
    const pestanas = await page.getByRole("tablist", { name: "Preventivo" }).evaluate((el) => ({
      lineas: new Set([...el.children].map((c) => (c as HTMLElement).offsetTop)).size,
      sobra: el.scrollWidth - el.clientWidth,
    }));
    expect.soft(pestanas.lineas, `${ancho}: pestañas en una línea`).toBe(1);
    // Se llega al final de la regla desplazando solo su caja.
    const ultimo = regla(page).getByRole("listitem").last();
    await ultimo.scrollIntoViewIfNeeded();
    await expect(ultimo).toBeInViewport();

    await verNivel(page, 1).click();
    await expect(panel(page)).toBeVisible();
    const enPanel = await panel(page).evaluate((hoja) =>
      [hoja, ...hoja.querySelectorAll<HTMLElement>("div")]
        .filter((d) => d.scrollWidth > d.clientWidth + 1)
        .map((d) => d.className.slice(0, 60))
    );
    expect.soft(enPanel, `${ancho}: panel`).toEqual([]);
    await panel(page).getByRole("button", { name: "Cerrar el panel" }).click();
    await expect(panel(page)).toHaveCount(0);
  }
});

test("con datos corrientes se lee entero en celular, tablet y laptop chica", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "pm-medidas");
  await alEcosistema(page, empresa, () => sembrarVolquetes(page));

  for (const [ancho, alto] of [
    [360, 740],
    [393, 851],
    [768, 1024],
    [1024, 768],
    [1280, 720],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width: 1366, height: 900 });
    await aPlanes(page);
    await page.setViewportSize({ width: ancho, height: alto });
    await expect(usan(page)).toContainText("4 equipos");

    // La tabla de niveles cabe entera: no hay que desplazarla para ver los repuestos.
    const tabla = await niveles(page).evaluate((raiz) => {
      const caja = raiz.querySelector("table")?.parentElement;
      return caja ? Math.max(0, caja.scrollWidth - caja.clientWidth) : 0;
    });
    expect.soft(tabla, `${ancho}: la tabla de niveles se corta`).toBe(0);
    // Una placa corriente no se parte en pedazos.
    const partidas = await usan(page).evaluate((raiz) =>
      [...raiz.querySelectorAll("li b")]
        .filter((b) => b.getBoundingClientRect().height > 28)
        .map((b) => b.textContent)
    );
    expect.soft(partidas, `${ancho}: placas partidas`).toEqual([]);
    // Las tres pestañas se ven completas.
    const sobra = await page
      .getByRole("tablist", { name: "Preventivo" })
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect.soft(sobra, `${ancho}: pestañas cortadas`).toBeLessThanOrEqual(0);
  }
});
