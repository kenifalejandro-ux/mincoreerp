/** e2e/control-tv-movil.spec.ts
 *
 * La TV de una unidad en celular y tablet (menos de 1024 px): una barra abajo con cinco pestañas (Mapa, Viaje,
 * Conductor, Consumo y Alertas) y las cifras siempre arriba; que con nombres y lugares muy largos nada se pase
 * del ancho de la pantalla (antes la cabecera empujaba todo a un lado); y que desde 1024 px la vista de
 * escritorio siga igual, sin barra. La TV central no cambia: en tablet conserva su distribución. La unidad y sus
 * datos llegan de respuestas fijas (page.route): lo que se prueba es la pantalla.
 */
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const ID = 777005;
const hace = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const ORIGEN = "Puerto Maldonado del Alto Amazonas";
const DESTINO = "San Juan de Lurigancho Norte";
const viaje = {
  id: String(ID),
  numero: 5,
  equipo_id: 1,
  placa_codigo: "MOV-0012345",
  codigo_interno: null,
  equipo_tipo: "TRACTO REMOLCADOR GRANDE",
  tipo_medidor: "odometro",
  conductor_nombre: "Larios Esquivel Luis Alberto Fernández de la Cruz",
  conductor_dni: "40112244",
  relevo_dni: null,
  relevo_nombre: null,
  volante_dni: "40112244",
  turnos: null,
  origen_id: "1",
  origen: ORIGEN,
  destino_id: "2",
  destino: DESTINO,
  inicio_en: hace(6),
  fin_en: null,
  estado: "en_curso",
  descansos: [],
  ultima_ubicacion: null,
  paradas: [
    { orden: 0, lugar_id: 1, lugar: ORIGEN, llegada_en: null, salida_en: hace(6) },
    { orden: 1, lugar_id: 2, lugar: DESTINO, llegada_en: null, salida_en: null },
  ],
};

async function prepararRespuestas(page: Page) {
  await page.route(new RegExp(`/api/erp/viajes/${ID}(\\?.*)?$`), (r) =>
    r.fulfill({
      json: {
        viaje,
        cargas: [
          {
            id: "1",
            producto: "combustible",
            origen: "tanque",
            despachado_en: hace(5),
            cantidad: "40",
            unidad: "gal",
            costo: "600",
          },
        ],
        ruta: { combustible_gal: 30, urea_l: null },
        tramos: [
          {
            orden: 1,
            de: ORIGEN,
            a: DESTINO,
            salida_en: hace(6),
            llegada_en: null,
            recorrido: null,
            combustible_gal: 40,
            urea_l: 5,
          },
        ],
      },
    })
  );
  await page.route(new RegExp(`/api/erp/viajes/control-tv/unidad/${ID}\\?`), (r) =>
    r.fulfill({
      json: {
        dias: 30,
        conductor: {
          dni: "40112244",
          en_ruta: 1,
          programados: 0,
          terminados: 4,
          anulados: 1,
          como_titular: 5,
          como_relevo: 1,
        },
        rendimiento: {
          rendimiento: { valor: 6.4, unidad: "km/gal" },
          cargado_gal: 40,
          vs_pares_pct: 22,
          vs_pasado_pct: -15,
          diagnostico: "alto",
        },
        estadia_normal: null,
        ultimas_cargas: [],
        alertas: {
          total: 3,
          criticas: 1,
          ultimas: [{ tipo: "viaje_sin_llegada", creado_en: hace(2), gravedad: "critica" }],
        },
      },
    })
  );
  await page.route(/\/api\/erp\/viajes\/lugares(\?.*)?$/, (r) =>
    r.fulfill({
      json: {
        data: [
          { id: 1, nombre: ORIGEN, latitud: -12.6, longitud: -69.2 },
          { id: 2, nombre: DESTINO, latitud: -11.9, longitud: -77.0 },
        ],
      },
    })
  );
  await page.route(/\/api\/erp\/viajes\?estado=en_curso/, (r) =>
    r.fulfill({ json: { data: [viaje] } })
  );
}

/** Lo que se pasa del ancho de la pantalla (sin contar las teselas del satélite ni la barra fija). */
const desborde = (page: Page) =>
  page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const hijo = document.querySelector("div.fixed.inset-0 > div.mx-auto") as HTMLElement;
    const fuera: string[] = [];
    for (const e of document.querySelectorAll("*")) {
      const b = (e as HTMLElement).getBoundingClientRect();
      if (
        b.width > 0 &&
        b.right > W + 1 &&
        !(e as HTMLElement).closest(".leaflet-container,nav,[class*='truncate']")
      )
        fuera.push(
          `${e.tagName}.${String((e as HTMLElement).className).slice(0, 40)} R=${Math.round(b.right)}`
        );
    }
    return {
      sobra: hijo.scrollWidth - hijo.clientWidth,
      pagina: document.documentElement.scrollWidth - W,
      fuera,
    };
  });

const barra = (page: Page) => page.getByRole("navigation", { name: "Secciones de la unidad" });
const PESTANAS: [string, string[]][] = [
  ["Mapa", ["Dónde está"]],
  ["Viaje", ["Consumo acumulado del viaje", "Tiempos del viaje"]],
  ["Conductor", ["Conductor y relevo", "Resumen de la unidad"]],
  ["Consumo", ["Consumo por tramo", "Rendimiento y cargas"]],
  ["Alertas", ["Alertas activas"]],
];

for (const [ancho, alto] of [
  [393, 852],
  [768, 1024],
] as const) {
  test(`la unidad en ${ancho} px: pestañas abajo y nada se pasa del ancho con nombres largos`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const admin = adminA();
    await loginPorUI(page, admin.email, admin.password);
    await prepararRespuestas(page);
    await page.setViewportSize({ width: ancho, height: alto });
    await page.goto(`/control-tv?unidad=${ID}`);
    await expect(barra(page)).toBeVisible();
    // Las cifras de arriba están siempre, en cualquier pestaña.
    await expect(page.getByText("EN RUTA", { exact: true })).toBeVisible();
    await expect(page.getByText("Alertas abiertas", { exact: false }).first()).toBeVisible();
    // La insignia de la pestaña Alertas dice cuántas hay abiertas.
    await expect(barra(page).getByRole("button", { name: /Alertas/ })).toContainText("3");

    for (const [nombre, titulos] of PESTANAS) {
      await barra(page)
        .getByRole("button", { name: new RegExp(nombre) })
        .click();
      await expect(barra(page).getByRole("button", { name: new RegExp(nombre) })).toHaveAttribute(
        "aria-current",
        "page"
      );
      for (const t of titulos)
        await expect(page.getByText(t, { exact: false }).first()).toBeVisible();
      // Con la ruta y el nombre larguísimos, ni la página ni la unidad se desplazan de costado.
      const d = await desborde(page);
      expect(d.sobra, `${nombre} ${ancho}px: sobra ancho dentro de la unidad`).toBeLessThanOrEqual(
        0
      );
      expect(d.pagina, `${nombre} ${ancho}px: la página se ensancha`).toBeLessThanOrEqual(0);
      expect(d.fuera, `${nombre} ${ancho}px: elementos fuera de la pantalla`).toEqual([]);
      if (process.env.CAPTURAS_TV) {
        await page.screenshot({
          path: `${process.env.CAPTURAS_TV}/movil-unidad-${nombre}-${ancho}.png`,
        });
      }
    }
  });
}

test("el corte está en 1024 px: a 1023 hay barra y a 1024 la vista de escritorio, sin barra", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await prepararRespuestas(page);
  await page.setViewportSize({ width: 1023, height: 800 });
  await page.goto(`/control-tv?unidad=${ID}`);
  await expect(barra(page)).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(barra(page)).toHaveCount(0);
  // En escritorio se ve todo a la vez, sin pestañas: el mapa y las cuatro tarjetas de abajo.
  for (const t of [
    "Dónde está",
    "Consumo acumulado del viaje",
    "Consumo por tramo",
    "Rendimiento y cargas",
    "Alertas activas",
  ]) {
    await expect(page.getByRole("heading", { name: new RegExp(t) }).first()).toBeVisible();
  }
  // Girar el teléfono (de 393 a 768 y de vuelta) conserva la pestaña elegida.
  await page.setViewportSize({ width: 393, height: 852 });
  await barra(page)
    .getByRole("button", { name: /Consumo/ })
    .click();
  await page.setViewportSize({ width: 852, height: 393 });
  await expect(barra(page).getByRole("button", { name: /Consumo/ })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await page.setViewportSize({ width: 393, height: 852 });
  await expect(page.getByText("Consumo por tramo", { exact: false }).first()).toBeVisible();
});

test("la TV central no cambia: barra propia en celular, y en tablet su distribución de siempre", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await prepararRespuestas(page);
  const central = page.getByRole("navigation", { name: "Secciones del Control TV" });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/control-tv");
  await expect(central).toBeVisible();
  await expect(barra(page)).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(central).toHaveCount(0);
  await expect(page.getByText("Flota en operación")).toBeVisible();
  const d = await desborde(page);
  expect(d.sobra).toBeLessThanOrEqual(0);
  expect(d.pagina).toBeLessThanOrEqual(0);
});
