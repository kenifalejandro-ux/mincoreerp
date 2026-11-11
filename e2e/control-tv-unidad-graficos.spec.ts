/** e2e/control-tv-unidad-graficos.spec.ts
 *
 * La TV de una unidad con DATOS (el e2e de control-tv.spec.ts solo ve estados vacíos): los gráficos del
 * consumo acumulado por origen y del consumo por tramo, el selector de período (que pide el resumen con
 * ?periodo=), «Marcas» junto a «Digital» y que todo quepa sin bajar a 1920×990 y 1366×820. La unidad y su
 * resumen llegan de respuestas fijas (page.route): lo que se prueba es la pantalla, no el servidor.
 */
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const ID = 777001;
const H = 3_600_000;
const hace = (h: number) => new Date(Date.now() - h * H).toISOString();

const viaje = {
  id: String(ID),
  numero: 77,
  equipo_id: 1,
  placa_codigo: "GRAF-001",
  codigo_interno: null,
  equipo_tipo: "TRACTO",
  tipo_medidor: "odometro",
  conductor_nombre: "Marco Prueba",
  conductor_dni: "40112233",
  relevo_dni: "40998877",
  relevo_nombre: "Rosa Relevo",
  volante_dni: "40112233",
  turnos: null,
  origen_id: "1",
  origen: "Huamachuco",
  destino_id: "2",
  destino: "Trujillo",
  inicio_en: hace(20),
  fin_en: null,
  estado: "en_curso",
  descansos: [],
  ultima_ubicacion: null,
  paradas: [
    { orden: 0, lugar_id: 1, lugar: "Huamachuco", llegada_en: null, salida_en: hace(20) },
    { orden: 1, lugar_id: 2, lugar: "Trujillo", llegada_en: hace(12), salida_en: hace(11) },
    { orden: 2, lugar_id: 1, lugar: "Huamachuco", llegada_en: null, salida_en: null },
  ],
};
const cargas = [
  {
    id: "1",
    producto: "combustible",
    origen: "tanque",
    despachado_en: hace(19),
    cantidad: "18",
    unidad: "gal",
    costo: "270",
  },
  {
    id: "2",
    producto: "combustible",
    origen: "tanqueta",
    despachado_en: hace(11),
    cantidad: "10",
    unidad: "gal",
    costo: "150",
  },
  {
    id: "3",
    producto: "combustible",
    origen: "compra_externa",
    despachado_en: hace(5),
    cantidad: "5",
    unidad: "gal",
    costo: "80",
  },
  {
    id: "4",
    producto: "urea",
    origen: "almacen",
    despachado_en: hace(19),
    cantidad: "12",
    unidad: "L",
    costo: "30",
  },
];
const tramos = [
  {
    orden: 1,
    de: "Huamachuco",
    a: "Trujillo",
    salida_en: hace(20),
    llegada_en: hace(12),
    recorrido: 180,
    combustible_gal: 19.5,
    urea_l: 9,
    esperado_min: 420,
  },
  {
    orden: 2,
    de: "Trujillo",
    a: "Huamachuco",
    salida_en: hace(11),
    llegada_en: null,
    recorrido: null,
    combustible_gal: 13.5,
    urea_l: 3,
    esperado_min: 420,
  },
];
const DIAS = { "24h": 1, "7d": 7, "30d": 30 } as const;

test("la TV de una unidad con datos: gráficos, período, Marcas y sin bajar", async ({ page }) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const pedidosResumen: string[] = [];
  await page.route(new RegExp(`/api/erp/viajes/${ID}(\\?.*)?$`), (r) =>
    r.fulfill({
      json: { viaje, cargas, ruta: { combustible_gal: 30, urea_l: null }, tramos },
    })
  );
  await page.route(new RegExp(`/api/erp/viajes/control-tv/unidad/${ID}\\?`), (r) => {
    const periodo = new URL(r.request().url()).searchParams.get("periodo") as keyof typeof DIAS;
    pedidosResumen.push(periodo);
    return r.fulfill({
      json: {
        dias: DIAS[periodo] ?? 30,
        conductor: {
          dni: "40112233",
          en_ruta: 1,
          programados: 1,
          terminados: DIAS[periodo] === 1 ? 0 : 6,
          anulados: 1,
          como_titular: 9,
          como_relevo: 2,
        },
        rendimiento: {
          rendimiento: { valor: 6.4, unidad: "km/gal" },
          cargado_gal: 33,
          vs_pares_pct: 22,
          vs_pasado_pct: -15,
          diagnostico: "alto",
        },
        estadia_normal: { minutos: 90, viajes: 12 },
        ultimas_cargas: [
          {
            producto: "combustible",
            en: hace(5),
            cantidad: 5,
            unidad: "gal",
            origen: "compra_externa",
          },
        ],
        alertas: {
          total: 2,
          criticas: 1,
          ultimas: [{ tipo: "viaje_sin_llegada", creado_en: hace(2), gravedad: "critica" }],
        },
      },
    });
  });

  await page.setViewportSize({ width: 1920, height: 990 });
  await page.goto(`/control-tv?unidad=${ID}`);
  await expect(page.getByRole("heading", { name: "Marco Prueba" })).toBeVisible();
  // Entra en 30 días y lo pide así.
  await expect(
    page.getByRole("heading", { name: /^Resumen de la unidad · 30 días/ })
  ).toBeVisible();
  expect(pedidosResumen[0]).toBe("30d");

  // El consumo acumulado: una barra por origen (18, 10 y 5 gal) y lo acumulado (33 gal) arriba.
  const acumulado = page.locator("section", {
    has: page.getByRole("heading", { name: /Consumo acumulado del viaje/ }),
  });
  for (const origen of ["Grifo", "Tanqueta", "Compra en ruta"]) {
    await expect(acumulado.getByText(origen, { exact: true }).first()).toBeVisible();
  }
  await expect(acumulado.getByText("18", { exact: true })).toBeVisible();
  await expect(acumulado.getByText("33 gal", { exact: true })).toHaveCount(2); // la cifra y el acumulado
  // El consumo por tramo: los dos tramos, el segundo «en curso».
  const tramosSeccion = page.locator("section", {
    has: page.getByRole("heading", { name: /Consumo por tramo/ }),
  });
  await expect(tramosSeccion.getByText(/^19[.,]5$/)).toBeVisible();
  await expect(tramosSeccion.getByText(/en curso/)).toBeVisible();
  // El rendimiento con sus desvíos (el rojo pasa de 20 %), sin cifras absurdas.
  await expect(page.getByText("+22 %", { exact: true })).toBeVisible();
  await expect(page.getByText("−15 %", { exact: true })).toBeVisible();

  const sinScroll = () =>
    page
      .locator("div.fixed.inset-0")
      .first()
      .evaluate((el) => el.scrollHeight - el.clientHeight);
  for (const [ancho, alto, nombre] of [
    [1920, 990, "1920x990"],
    [1366, 820, "1366x820"],
  ] as const) {
    await page.setViewportSize({ width: ancho, height: alto });
    await expect(page.getByRole("heading", { name: "Alertas activas" })).toBeVisible();
    expect(await sinScroll(), `unidad con datos ${nombre} sin scroll`).toBeLessThanOrEqual(1);
    if (process.env.CAPTURAS_TV) {
      await page.screenshot({ path: `${process.env.CAPTURAS_TV}/unidad-datos-${nombre}.png` });
    }
  }
  await page.setViewportSize({ width: 1920, height: 990 });

  // El período: 24 h pide el resumen con ?periodo=24h y el título dice «24 horas».
  await page.getByRole("button", { name: "24 h", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /^Resumen de la unidad · 24 horas/ })
  ).toBeVisible();
  expect(pedidosResumen).toContain("24h");
  await page.getByRole("button", { name: "7 días", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Resumen de la unidad · 7 días/ })).toBeVisible();
  expect(pedidosResumen).toContain("7d");

  // «Marcas» está junto a «Digital» y «Satélite»; al elegirla salen los carriles y se va el mapa.
  await expect(page.getByRole("button", { name: "Digital", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Marcas", exact: true }).click();
  await expect(page.getByText("Salida", { exact: true })).toBeVisible();
  await expect(page.getByText("Destino", { exact: true })).toBeVisible();
  await expect(page.getByText("Regreso", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /Mapa de las unidades en ruta/ })).toBeHidden();
  // No se duplica la leyenda de estados: en la unidad no hay filtros (una sola unidad).
  await expect(page.getByRole("button", { name: /^Todas\s*\d+$/ })).toHaveCount(0);
  if (process.env.CAPTURAS_TV) {
    await page.screenshot({ path: `${process.env.CAPTURAS_TV}/unidad-marcas-1920x990.png` });
  }
  await page.getByRole("button", { name: "Digital", exact: true }).click();
  await expect(page.getByRole("img", { name: /Mapa de las unidades en ruta/ })).toBeVisible();

  // En el celular se arma sin lado a lado: solo se captura para mirarlo.
  if (process.env.CAPTURAS_TV) {
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(page.getByRole("heading", { name: "Marco Prueba" })).toBeVisible();
    await page.screenshot({
      path: `${process.env.CAPTURAS_TV}/unidad-datos-393.png`,
      fullPage: true,
    });
  }
});
