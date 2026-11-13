/** e2e/combustible-vales-faltantes.spec.ts
 *
 * Tanques: un clic en la tarjeta «Nivel de tanque» o en la fila abre el kardex, y el kardex avisa
 * los vales que faltan en el talonario del período. Los tramos y los vecinos los cubre el test de
 * servidor y los textos el de lógica; acá se ve en un navegador que el clic abre lo que debe, que
 * los íconos de la fila no lo abren y que sin la consulta de talonarios el kardex sale igual.
 *
 * El tenant e2e sobrevive entre corridas y tiene más tanques y series: todo se busca por la marca
 * de ESTA corrida y el total del aviso solo se exige como número.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

async function prepararTanqueConVales(page: Page, marca: string, vales = [1, 2, 5]) {
  const grifoInternoId = await primerGrifoActivo(page);
  const crear = async (ruta: string, data: object) => {
    const r = await page.request.post(ruta, { data });
    expect(r.status(), `${ruta}: ${await r.text()}`).toBe(201);
    return (await r.json()) as Record<string, unknown>;
  };
  const tanque = await crear("/api/erp/combustible", {
    codigo: `VF-${marca}`,
    tanque_nombre: `Tanque vales ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 2000,
    nivel_actual: 1500,
    requiere_documento: false,
    grifo_interno_id: grifoInternoId,
  });
  const tanqueta = await crear("/api/erp/combustible/tanquetas", {
    grifo_interno_id: grifoInternoId,
    codigo: `TV-${marca}`,
  });
  // Por defecto, vales 1, 2 y 5: faltan el 3 y el 4, en un solo tramo.
  for (const nVale of vales) {
    await crear("/api/erp/combustible/despachos", {
      origen: "tanque_propio",
      combustible_id: tanque.id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: Number(tanqueta.id),
      serie_talonario: `V${marca}`,
      n_vale: nVale,
      cantidad: 20,
      lectura_contometro: 20,
      costo_unitario: 16,
      despachado_en: new Date().toISOString(),
    });
  }
  return { nombre: `Tanque vales ${marca}`, codigo: `VF-${marca}` };
}

// El tenant e2e acumula tanques y vales entre corridas y la lista tarda en cargar: los primeros
// `expect` de cada pantalla esperan más que los 5 s de siempre.
const CARGA = { timeout: 30_000 };

// Un solo login para todo el archivo. El login por pantalla compite con la instalación del service
// worker de la PWA, que en un contexto nuevo precachea toda la app justo cuando el test rellena el
// formulario: un clic en «Ingresar» que cae en medio no envía nada. Con cuatro logins seguidos esa
// carrera salía una de cada tres corridas; con uno solo, casi nunca.
test.describe.configure({ mode: "serial" });
let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
});

test.afterAll(async () => {
  await page.close();
});

async function irATanques(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Tanques", exact: true }).click();
}

test("Tanques: el clic en la fila abre el kardex, los íconos no, y el aviso lista los tramos que faltan", async () => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const tanque = await prepararTanqueConVales(page, marca);
  await irATanques(page);

  const fila = page.getByRole("row").filter({ hasText: tanque.codigo });
  await expect(fila).toBeVisible(CARGA);
  expect(await fila.evaluate((el) => getComputedStyle(el).cursor), "falta la manito").toBe(
    "pointer"
  );

  // Un ícono hace lo suyo y NO abre el kardex.
  await fila.getByTitle("Ver tanque").click();
  await expect(page.getByText(`Kardex — ${tanque.codigo}`)).toHaveCount(0);

  // El clic en la fila sí lo abre.
  await irATanques(page);
  await page.getByRole("row").filter({ hasText: tanque.codigo }).locator("td").first().click();
  await expect(page.getByText(`Kardex — ${tanque.codigo}`)).toBeVisible(CARGA);

  // El aviso rojo cuenta los faltantes y al tocarlo muestra el tramo con sus vecinos.
  const aviso = page.getByRole("button", { name: /Vales faltantes: \d+/ });
  await expect(aviso).toBeVisible(CARGA);
  await expect(aviso).toHaveAttribute("aria-expanded", "false");
  await aviso.click();
  await expect(aviso).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator("#kardex-vales-faltantes");
  const serie = panel.locator("section").filter({ hasText: `Serie V${marca}` });
  await expect(serie).toContainText("faltan 2");
  await expect(serie).toContainText("00003 – 00004");
  await expect(serie).toContainText(`Entre el V${marca}-00002`);
  await expect(serie).toContainText(`V${marca}-00005`);
  await expect(serie).toContainText(/registrado por/);
});

test("Tanques: el clic en la tarjeta del tanque abre su kardex", async () => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const tanque = await prepararTanqueConVales(page, marca);
  await irATanques(page);

  const tarjeta = page.locator('[role="button"][aria-label^="Ver kardex de"]');
  await expect(tarjeta).toBeVisible(CARGA);
  expect(await tarjeta.evaluate((el) => getComputedStyle(el).cursor), "falta la manito").toBe(
    "pointer"
  );
  // El selector de la tarjeta es suyo: cambiar de tanque no abre el kardex.
  await tarjeta.getByRole("combobox").selectOption({ label: tanque.nombre });
  await expect(page.getByText(/^Kardex — /)).toHaveCount(0);
  await tarjeta.getByText("Nivel de tanque").click();
  await expect(page.getByText(`Kardex — ${tanque.codigo}`)).toBeVisible(CARGA);

  // Con el teclado: Enter en la tarjeta enfocada también lo abre.
  await irATanques(page);
  const tarjetaOtraVez = page.locator('[role="button"][aria-label^="Ver kardex de"]');
  await expect(tarjetaOtraVez).toBeVisible(CARGA);
  await tarjetaOtraVez.getByRole("combobox").selectOption({ label: tanque.nombre });
  await tarjetaOtraVez.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(`Kardex — ${tanque.codigo}`)).toBeVisible(CARGA);
});

test("Kardex: si la consulta de talonarios falla, el kardex sale igual y sin aviso", async () => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const tanque = await prepararTanqueConVales(page, marca);
  await page.route("**/despachos/talonarios**", (ruta) => ruta.abort());
  await irATanques(page);

  await page.getByRole("row").filter({ hasText: tanque.codigo }).locator("td").first().click();
  await expect(page.getByText(`Kardex — ${tanque.codigo}`)).toBeVisible(CARGA);
  await expect(page.getByText(/Entradas/).first()).toBeVisible();
  await expect(page.getByText(/Vales faltantes|Vales completos/)).toHaveCount(0);
  await expect(page.getByText(/No se pudo armar el kardex/)).toHaveCount(0);
  // Los tests que siguen sí necesitan la consulta de talonarios.
  await page.unroute("**/despachos/talonarios**");
});

test("Talonarios: el botón abre el reporte con la serie, su tramo que falta y el Excel", async () => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  // Vales 1, 2, 5 y 7: faltan el 3 y el 4 (un tramo de dos) y el 6 (un tramo de un solo vale).
  await prepararTanqueConVales(page, marca, [1, 2, 5, 7]);
  await irATanques(page);

  // Botón nuevo: lleva la etiqueta «Nuevo» (hasta 24 h después del primer clic de cada persona).
  const boton = page.getByRole("button", { name: "Talonarios", exact: true });
  await expect(boton.getByText("Nuevo")).toBeVisible(CARGA);
  await boton.click();
  await expect(page.getByText("Talonarios de vales")).toBeVisible(CARGA);

  // La franja de arriba: la dona y las tarjetas con lo que falta, lo regularizado y lo despachado.
  await expect(page.getByRole("img", { name: /de los vales tienen respaldo/ })).toBeVisible(CARGA);
  for (const titulo of [
    "Vales que faltan",
    "Regularizados",
    "Sin explicar",
    "Despachado con vale",
  ]) {
    await expect(page.getByText(titulo, { exact: true }).first()).toBeVisible();
  }

  // La serie de esta corrida: usados 4 de 7, faltan 3.
  const fila = page.getByRole("row").filter({ hasText: `V${marca}` });
  await expect(fila).toBeVisible(CARGA);
  await expect(fila).toContainText("4 de 7");
  await fila.getByRole("button", { name: "Ver tramos" }).click();
  await expect(page.getByText("00003 – 00004")).toBeVisible();
  await expect(page.getByText(`Entre el V${marca}-00002`)).toBeVisible();

  // Un tramo de un solo vale (el 6) ocupa una sola fila, con el botón «Regularizar» en lima.
  const unico = page.getByRole("checkbox", { name: /Marcar el vale V.*-00006/ });
  await expect(unico).toBeVisible();
  await expect(
    page.locator("section").filter({ has: unico }).getByRole("button", { name: "Regularizar" })
  ).toHaveClass(/bg-lime-400/);
  await expect(page.locator("section").filter({ has: unico })).not.toContainText("1 vale ·");

  // Cada vale que falta tiene su fila. Regularizar uno: pide motivo, y «Otro» pide además el detalle.
  const vale3 = page.getByRole("listitem").filter({ hasText: `V${marca}-00003` });
  const vale4 = page.getByRole("listitem").filter({ hasText: `V${marca}-00004` });
  await expect(vale3).toContainText("Sin explicar");
  await vale3.getByRole("button", { name: "Regularizar" }).click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByText("Elige un motivo.")).toBeVisible();
  await page.locator("#reg-3-motivo").selectOption("otro");
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByText("Con «Otro» el detalle es obligatorio.")).toBeVisible();
  await page.locator("#reg-3-motivo").selectOption("roto");
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(vale3).toContainText("Regularizado", CARGA);
  await expect(vale3).toContainText("Vale roto");
  await expect(vale4).toContainText("Sin explicar");

  // Regularizar en masa: se marca el vale que queda y la barra de abajo lo regulariza.
  await vale4.getByRole("checkbox").check();
  await expect(page.getByText("1 vale seleccionado")).toBeVisible();
  await page.locator("#reg-masiva-motivo").selectOption("perdido");
  await page.getByRole("button", { name: "Regularizar seleccionados" }).click();
  await expect(vale4).toContainText("Regularizado", CARGA);
  await expect(vale4).toContainText("Vale perdido");
  // Quedan regularizados el 3 y el 4, y sin explicar el 6.
  const filaSerie = page
    .getByRole("row")
    .filter({ hasText: `V${marca}` })
    .first();
  await expect(filaSerie.getByRole("cell").nth(5)).toHaveText("2");
  await expect(filaSerie.getByRole("cell").nth(6)).toHaveText("1");

  // Deshacer una regularización: el motivo es obligatorio y el vale vuelve a «Sin explicar».
  await vale3.getByRole("button", { name: "Deshacer" }).click();
  await page.getByRole("button", { name: "Deshacer regularización" }).click();
  await expect(page.getByText("Escribe por qué se deshace.")).toBeVisible();
  await page.locator("#des-3").fill("me equivoqué de vale");
  await page.getByRole("button", { name: "Deshacer regularización" }).click();
  await expect(vale3).toContainText("Sin explicar", CARGA);
  await expect(vale4).toContainText("Regularizado");
  // En masa: se marca el vale que sigue regularizado y la barra lo deshace.
  await vale4.getByRole("checkbox").check();
  await page.locator("#des-masiva").fill("revisión");
  await page.getByRole("button", { name: "Deshacer regularización" }).click();
  await expect(vale4).toContainText("Sin explicar", CARGA);
  await expect(filaSerie.getByRole("cell").nth(5)).toHaveText("0");
  await expect(filaSerie.getByRole("cell").nth(6)).toHaveText("3");

  // El cuadre contra el tanque lo ve el administrador.
  await expect(page.getByText("Cuadre contra el tanque")).toBeVisible();

  // El Excel baja con las series del período.
  const [descarga] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Excel \(\.xlsx\)/ }).click(),
  ]);
  expect(descarga.suggestedFilename()).toMatch(
    /^talonarios-\d{4}-\d{2}-\d{2}-a-\d{4}-\d{2}-\d{2}\.xlsx$/
  );
});
