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

async function prepararTanqueConVales(page: Page, marca: string) {
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
  // Vales 1, 2 y 5: faltan el 3 y el 4, en un solo tramo.
  for (const nVale of [1, 2, 5]) {
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

async function irATanques(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Tanques", exact: true }).click();
}

test("Tanques: el clic en la fila abre el kardex, los íconos no, y el aviso lista los tramos que faltan", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
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

test("Tanques: el clic en la tarjeta del tanque abre su kardex", async ({ page }) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
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

test("Kardex: si la consulta de talonarios falla, el kardex sale igual y sin aviso", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const tanque = await prepararTanqueConVales(page, marca);
  await page.route("**/despachos/talonarios**", (ruta) => ruta.abort());
  await irATanques(page);

  await page.getByRole("row").filter({ hasText: tanque.codigo }).locator("td").first().click();
  await expect(page.getByText(`Kardex — ${tanque.codigo}`)).toBeVisible(CARGA);
  await expect(page.getByText(/Entradas/).first()).toBeVisible();
  await expect(page.getByText(/Vales faltantes|Vales completos/)).toHaveCount(0);
  await expect(page.getByText(/No se pudo armar el kardex/)).toHaveCount(0);
});
