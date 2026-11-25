/** e2e/checklists-no-apta.spec.ts
 *
 * Checklist no apto, orden automática y lectura del medidor (E5-2), en el navegador:
 *
 * 1. Con señal: la lectura mal escrita no sale; la falla crítica avisa, genera la orden y se ve en las dos
 *    pantallas; una lectura que retrocede no hace perder el checklist.
 * 2. Sin señal: el checklist con lectura y falla crítica queda en el equipo y, al volver la red, entra una
 *    sola vez, con su orden y con la hora en que se llenó.
 * 3. Solo Checklists: no se pide lectura ni se habla de órdenes.
 *
 * Cada test crea su propia empresa (no hay API para borrarlas: la base de los e2e es efímera en CI).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { botonRegistrar } from "./fixtures/checklists";
import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";
import { elegirUnidad } from "./fixtures/selectorDeUnidad";

const PLANTILLA = "Pre-uso volquete";
const placaNueva = () => `E52-${randomBytes(2).toString("hex").toUpperCase()}`;

/** Acepta todos los avisos del navegador y los va guardando. */
function escucharAvisos(page: Page): string[] {
  const avisos: string[] = [];
  page.on("dialog", (d) => {
    avisos.push(d.message());
    void d.accept();
  });
  return avisos;
}

async function sembrarPlantilla(page: Page) {
  const r = await page.request.post("/api/erp/checklists/plantillas", {
    data: {
      nombre: PLANTILLA,
      items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
    },
  });
  expect(r.status(), await r.text()).toBe(201);
}

/** La vista cargó sus listas al entrar, antes de sembrar: se sale y se vuelve para que las pida de nuevo
 *  (recargar la página pediría otra vez la clave). */
async function volverAChecklists(page: Page) {
  await page.getByRole("button", { name: "Órdenes de Trabajo" }).first().click();
  await page.getByRole("button", { name: "Checklists" }).first().click();
}

async function abrirYElegir(page: Page, placa: string) {
  await page.getByRole("button", { name: "Nuevo Checklist" }).click();
  await elegirUnidad(page, "checklist-equipo", placa);
  await page.getByLabel("Plantilla").selectOption({ label: PLANTILLA });
  await expect(page.getByText("Frenos")).toBeVisible();
}

/** El estado de la pregunta: cada una tiene su propio selector, al lado de su texto. */
const marcarMalo = (page: Page, pregunta: string) =>
  page
    .locator("form div")
    .filter({ has: page.locator("span", { hasText: pregunta }) })
    .last()
    .locator("select")
    .selectOption("malo");

const campoLectura = (page: Page) => page.getByLabel(/^Horómetro o kilometraje/);

const listado = async (page: Page, modulo: "checklists" | "ordenes_trabajo") =>
  (await (await page.request.get(`/api/erp/${modulo}?pageSize=50`)).json()).data as Record<
    string,
    unknown
  >[];

test("con señal: avisa la falla crítica y la orden, y una lectura que retrocede no pierde el checklist", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const placa = placaNueva();
  const empresa = await crearEmpresaSola(
    request,
    ["mantenimiento", "checklists", "ordenes_trabajo"],
    "noapta"
  );
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: "Checklists" }).first()
  );
  const unidad = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: {
      placa_codigo: placa,
      tipo: "Volquete",
      medidor: "horometro",
      lectura: 10,
      propiedad: "propia",
    },
  });
  expect(unidad.status(), await unidad.text()).toBe(201);
  await sembrarPlantilla(page);
  await volverAChecklists(page);
  const avisos = escucharAvisos(page);

  // ── Con separador de miles no se envía nada ───────────────────────────
  await abrirYElegir(page, placa);
  await campoLectura(page).fill("1.250");
  await marcarMalo(page, "Frenos");
  await botonRegistrar(page).click();
  await expect.poll(() => avisos.at(-1)).toContain("sin separador de miles");
  expect(await listado(page, "checklists")).toHaveLength(0);

  // ── Corregida: no apta, con su orden ──────────────────────────────────
  await campoLectura(page).fill("20,5");
  await botonRegistrar(page).click();
  await expect.poll(() => avisos.at(-1)).toContain("NO APTA");
  const [orden] = await listado(page, "ordenes_trabajo");
  expect(avisos.at(-1)).toContain(`#${orden.id}`);
  await expect(page.getByRole("cell", { name: /No apta/ })).toContainText(
    `Orden de trabajo #${orden.id}`
  );
  expect((await listado(page, "checklists"))[0]).toMatchObject({
    resultado: "no_apta",
    lectura_valor: 20.5,
  });

  // ── Una lectura menor: el checklist entra y dice por qué no quedó ─────
  await abrirYElegir(page, placa);
  await campoLectura(page).fill("5");
  await botonRegistrar(page).click();
  await expect.poll(() => avisos.at(-1)).toContain("No se registró la lectura");
  await expect(page.getByRole("cell", { name: /No se registró la lectura/ })).toBeVisible();
  expect(await listado(page, "checklists")).toHaveLength(2);
  expect(await listado(page, "ordenes_trabajo")).toHaveLength(1);

  // ── La orden dice de dónde vino ───────────────────────────────────────
  await page.getByRole("button", { name: "Órdenes de Trabajo" }).first().click();
  await expect(page.getByText(`Generada por checklist #${orden.checklist_id}`)).toBeVisible();
});

test("sin señal: con lectura y falla crítica se guarda en el equipo y entra una sola vez", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const placa = placaNueva();
  const empresa = await crearEmpresaSola(
    request,
    ["flota", "checklists", "ordenes_trabajo"],
    "noapta-off"
  );
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: "Checklists" }).first()
  );
  const unidad = await page.request.post("/api/erp/equipos", {
    data: { placa_codigo: placa, tipo: "Volquete", tipo_medidor: "horometro" },
  });
  expect(unidad.status(), await unidad.text()).toBe(201);
  const unidadId = (await unidad.json()).id as number;
  await sembrarPlantilla(page);
  await volverAChecklists(page);
  const avisos = escucharAvisos(page);

  // La unidad y la plantilla se eligen con red, como en la base antes de salir a la cancha.
  await abrirYElegir(page, placa);
  await context.setOffline(true);
  await campoLectura(page).fill("150");
  await marcarMalo(page, "Frenos");
  await botonRegistrar(page).click();
  await expect.poll(() => avisos.join(" ")).toContain("Sin conexión");
  expect(avisos.at(-1)).toContain("NO APTA");
  // La orden la decide el servidor: sin señal no se promete.
  expect(avisos.at(-1)).not.toContain("orden");

  const antesDeVolver = Date.now();
  await context.setOffline(false);
  await expect(page.getByRole("cell", { name: /No apta/ })).toContainText("Orden de trabajo #", {
    timeout: 45_000,
  });

  expect(await listado(page, "checklists")).toHaveLength(1);
  expect(await listado(page, "ordenes_trabajo")).toHaveLength(1);
  const lecturas = (await (await page.request.get(`/api/erp/equipos/${unidadId}/lecturas`)).json())
    .data as { valor: number; origen: string; leido_en: string }[];
  expect(lecturas).toHaveLength(1);
  expect(lecturas[0]).toMatchObject({ valor: 150, origen: "checklist" });
  // La hora es la del llenado, no la del envío.
  expect(Date.parse(lecturas[0].leido_en)).toBeLessThanOrEqual(antesDeVolver);
});

test("solo Checklists: no pide lectura y la no apta no habla de órdenes", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, "checklists", "noapta-solo");
  const pestania = page.getByRole("button", { name: /^Plantillas/ });
  await entrarPorPrimeraVez(page, empresa, pestania);
  const avisos = escucharAvisos(page);

  await pestania.click();
  await page.getByRole("button", { name: "+ Nueva Plantilla" }).click();
  const nueva = page.getByRole("dialog", { name: "Nueva Plantilla" });
  await nueva.getByLabel("Nombre").fill(PLANTILLA);
  await nueva.getByPlaceholder("Ítem 1").fill("Frenos");
  await nueva.getByLabel("Ítem 1 es crítico").check();
  await nueva.getByRole("button", { name: "Crear Plantilla" }).click();
  await expect(nueva).toHaveCount(0);

  await page.getByRole("button", { name: "Checklists" }).last().click();
  await page.getByRole("button", { name: "Nuevo Checklist" }).click();
  await page.getByLabel("Plantilla").selectOption({ label: PLANTILLA });
  await page.getByLabel(/^Activo o lugar/).fill("Horno 4");
  await expect(campoLectura(page)).toHaveCount(0);
  await marcarMalo(page, "Frenos");
  await botonRegistrar(page).click();

  await expect.poll(() => avisos.at(-1)).toContain("NO APTA");
  expect(avisos.at(-1)).not.toContain("orden");
  await expect(page.getByRole("cell", { name: "No apta" })).toBeVisible();
  await expect(page.getByText(/Orden de trabajo #/)).toHaveCount(0);
});
