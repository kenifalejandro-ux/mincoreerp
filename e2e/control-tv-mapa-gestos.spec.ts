/** e2e/control-tv-mapa-gestos.spec.ts
 *
 * El mapa del Control TV en la vista de una unidad: arrastrar y acercar el mapa digital (y «Recentrar»),
 * que un clic al final de un arrastre no abra nada, los pines de GPS y el avatar de la unidad en el satélite
 * (marcadores de Leaflet: no necesitan bajar imágenes), y la etiqueta «Nuevo» del ícono de TV de la barra
 * superior (sale, dura 24 horas desde el primer clic y se va). La unidad y los lugares llegan de respuestas
 * fijas (page.route): lo que se prueba es la pantalla.
 */
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

const ID = 777002;
const H = 3_600_000;
const hace = (h: number) => new Date(Date.now() - h * H).toISOString();
const CLAVE_NOVEDAD = /^controlTv\.novedad\./;

const viaje = {
  id: String(ID),
  numero: 78,
  equipo_id: 1,
  placa_codigo: "GEST-001",
  codigo_interno: null,
  equipo_tipo: "TRACTO",
  tipo_medidor: "odometro",
  conductor_nombre: "Pia Prueba",
  conductor_dni: "40112244",
  relevo_dni: null,
  relevo_nombre: null,
  volante_dni: "40112244",
  turnos: null,
  origen_id: "1",
  origen: "Huamachuco",
  destino_id: "2",
  destino: "Trujillo",
  inicio_en: hace(6),
  fin_en: null,
  estado: "en_curso",
  descansos: [],
  ultima_ubicacion: null,
  paradas: [
    { orden: 0, lugar_id: 1, lugar: "Huamachuco", llegada_en: null, salida_en: hace(6) },
    { orden: 1, lugar_id: 2, lugar: "Trujillo", llegada_en: null, salida_en: null },
  ],
};

async function prepararRespuestas(page: Page, v: object = viaje, extra: object[] = []) {
  await page.route(new RegExp(`/api/erp/viajes/${ID}(\\?.*)?$`), (r) =>
    r.fulfill({
      json: { viaje: v, cargas: [], ruta: { combustible_gal: null, urea_l: null }, tramos: [] },
    })
  );
  await page.route(new RegExp(`/api/erp/viajes/control-tv/unidad/${ID}\\?`), (r) =>
    r.fulfill({
      json: {
        dias: 30,
        conductor: null,
        rendimiento: null,
        estadia_normal: null,
        ultimas_cargas: [],
        alertas: { total: 0, ultimas: [] },
      },
    })
  );
  // Los dos lugares con su punto en el mapa (Huamachuco y Trujillo).
  await page.route(/\/api\/erp\/viajes\/lugares(\?.*)?$/, (r) =>
    r.fulfill({
      json: {
        data: [
          { id: 1, nombre: "Huamachuco", latitud: -7.8133, longitud: -78.0484 },
          { id: 2, nombre: "Trujillo", latitud: -8.1116, longitud: -79.0288 },
          ...extra,
        ],
      },
    })
  );
}

test("el mapa digital de una unidad se arrastra, se acerca y se recentra", async ({ page }) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await prepararRespuestas(page);
  await page.setViewportSize({ width: 1920, height: 990 });
  await page.goto(`/control-tv?unidad=${ID}`);
  await expect(page.getByRole("heading", { name: "Pia Prueba" })).toBeVisible();

  const mapa = page.getByRole("img", { name: /Mapa de las unidades en ruta/ });
  await expect(mapa).toBeVisible();
  const recentrar = page.getByRole("button", { name: "Recentrar" });
  await expect(recentrar).toHaveCount(0);
  // El primer dibujo (cuadrícula, ruta, pines y avatar) tiene que estar antes de comparar.
  await page.waitForTimeout(600);
  const caja = (await mapa.boundingBox())!;
  const centro = { x: caja.x + caja.width / 2, y: caja.y + caja.height / 2 };
  const inicial = await mapa.screenshot();
  if (process.env.CAPTURAS_TV) {
    await page.screenshot({ path: `${process.env.CAPTURAS_TV}/gestos-1-inicial.png` });
  }

  // La rueda acerca: aparece «Recentrar» y el dibujo cambia.
  await page.mouse.move(centro.x, centro.y);
  await page.mouse.wheel(0, -600);
  await expect(recentrar).toBeVisible();
  await page.waitForTimeout(400);
  expect((await mapa.screenshot()).equals(inicial)).toBe(false);
  if (process.env.CAPTURAS_TV) {
    await page.screenshot({ path: `${process.env.CAPTURAS_TV}/gestos-2-rueda.png` });
  }

  // «Recentrar» devuelve el encuadre de la ruta, igual que al abrir.
  await recentrar.click();
  await expect(recentrar).toHaveCount(0);
  await page.waitForTimeout(400);
  expect((await mapa.screenshot()).equals(inicial)).toBe(true);

  // Arrastrar con el ratón mueve el mapa y también ofrece «Recentrar».
  await page.mouse.move(centro.x, centro.y);
  await page.mouse.down();
  await page.mouse.move(centro.x + 160, centro.y + 50, { steps: 8 });
  await page.mouse.up();
  await expect(recentrar).toBeVisible();
  await page.waitForTimeout(400);
  expect((await mapa.screenshot()).equals(inicial)).toBe(false);
  if (process.env.CAPTURAS_TV) {
    await page.screenshot({ path: `${process.env.CAPTURAS_TV}/gestos-3-arrastre.png` });
  }
  // Soltar al final de un arrastre no abre ninguna unidad (seguimos en la misma).
  expect(page.url()).toContain(`unidad=${ID}`);

  // Cambiar de unidad (o volver a abrir) encuadra de nuevo: aquí, «Recentrar» lo hace a mano.
  await recentrar.click();
  await expect(recentrar).toHaveCount(0);

  // Sin mover el mapa, la rueda alejada hasta el tope no se sale del país ni rompe el dibujo.
  await page.mouse.move(centro.x, centro.y);
  await page.mouse.wheel(0, 20_000);
  await expect(recentrar).toBeVisible();
  await expect(mapa).toBeVisible();
});

test("el satélite pone un pin en el origen y el destino y el avatar de la unidad", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await prepararRespuestas(page);
  await page.setViewportSize({ width: 1920, height: 990 });
  await page.goto(`/control-tv?unidad=${ID}`);
  await expect(page.getByRole("heading", { name: "Pia Prueba" })).toBeVisible();
  await page.getByRole("button", { name: "Satélite", exact: true }).click();
  await expect(page.locator(".leaflet-container")).toBeVisible();
  // Tres marcadores: pin de la salida, pin de la llegada y el avatar de la unidad (ninguno es un punto).
  const marcadores = page.locator(".leaflet-marker-icon");
  await expect(marcadores).toHaveCount(3);
  // Los dos pines llevan su trazo ámbar (salida) y verde (llegada); el avatar, el dibujo del tipo.
  await expect(page.locator('.leaflet-marker-icon svg[stroke="#fbbf24"]')).toHaveCount(1);
  await expect(page.locator('.leaflet-marker-icon svg[stroke="#34d399"]').first()).toBeVisible();
  await expect(page.locator(".leaflet-marker-icon div svg")).toHaveCount(1);
  // En la vista de una unidad no hay etiqueta fija con la placa y el conductor.
  await expect(page.locator(".etq-unidad")).toHaveCount(0);
  await page.getByRole("button", { name: "Digital", exact: true }).click();
  await expect(page.locator(".leaflet-container")).toHaveCount(0);
});

test("en la TV central la etiqueta de una unidad sale solo al pasar el mouse", async ({ page }) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await prepararRespuestas(page);
  // La flota en curso es solo esta unidad: así lo único dibujado en la capa viva es ella.
  await page.route(/\/api\/erp\/viajes\?estado=en_curso/, (r) =>
    r.fulfill({ json: { data: [viaje] } })
  );
  await page.setViewportSize({ width: 1920, height: 990 });
  await page.goto("/control-tv");
  const mapa = page.getByRole("img", { name: /Mapa de las unidades en ruta/ });
  await expect(mapa).toBeVisible();
  await page.waitForTimeout(800);
  // Lo dibujado en la capa de las unidades (la caja que ocupa): sin etiqueta es solo el avatar.
  const dibujo = () =>
    mapa.evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
      let x0 = c.width,
        y0 = c.height,
        x1 = -1,
        y1 = -1;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++)
          if (d.data[(y * c.width + x) * 4 + 3] > 20) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
      const k = c.width / c.getBoundingClientRect().width;
      return { w: (x1 - x0) / k, cx: (x0 + x1) / 2 / k, cy: (y0 + y1) / 2 / k, vacio: x1 < 0 };
    });
  const sin = await dibujo();
  expect(sin.vacio).toBe(false);
  expect(sin.w).toBeLessThan(60); // solo el avatar, sin etiqueta
  const caja = (await mapa.boundingBox())!;
  // Pasar el mouse por encima de la unidad (el avatar está en el centro de lo dibujado) muestra la etiqueta.
  await page.mouse.move(caja.x + sin.cx, caja.y + sin.cy);
  await expect.poll(async () => (await dibujo()).w).toBeGreaterThan(sin.w + 60);
  if (process.env.CAPTURAS_TV) {
    await page.screenshot({ path: `${process.env.CAPTURAS_TV}/central-etiqueta-hover.png` });
  }
  // Al sacar el mouse, la etiqueta se va.
  await page.mouse.move(caja.x + 12, caja.y + 12);
  await expect.poll(async () => (await dibujo()).w).toBeLessThan(60);
});

test("la etiqueta «Nuevo» del ícono de TV sale, dura 24 horas desde el primer clic y se va", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const icono = page.getByRole("button", { name: "Control TV", exact: true });
  const nuevo = icono.getByText("Nuevo", { exact: true });
  const claves = () =>
    page.evaluate(
      (re) => Object.keys(localStorage).filter((k) => new RegExp(re).test(k)),
      CLAVE_NOVEDAD.source
    );
  // Entra como una persona que nunca abrió el Control TV.
  await page.evaluate((re) => {
    for (const k of Object.keys(localStorage))
      if (new RegExp(re).test(k)) localStorage.removeItem(k);
  }, CLAVE_NOVEDAD.source);
  await page.reload();
  await expect(nuevo).toBeVisible();
  if (process.env.CAPTURAS_TV) {
    const b = (await icono.boundingBox())!;
    await page.screenshot({
      path: `${process.env.CAPTURAS_TV}/nuevo-icono.png`,
      clip: { x: b.x - 60, y: Math.max(0, b.y - 14), width: b.width + 120, height: b.height + 28 },
    });
  }
  // El nombre accesible del botón no cambia con la etiqueta (es solo un aviso visual).
  await expect(icono).toHaveAccessibleName("Control TV");

  // El primer clic abre el Control TV y anota la hora; la etiqueta sigue (24 horas).
  const [tv] = await Promise.all([context.waitForEvent("page"), icono.click()]);
  await tv.close();
  expect((await claves()).length).toBe(1);
  await page.reload();
  await expect(nuevo).toBeVisible();

  // Pasadas 24 horas del primer clic, desaparece.
  const clave = (await claves())[0];
  await page.evaluate(
    ([k, antes]) => localStorage.setItem(k as string, String(antes)),
    [clave, Date.now() - 25 * H]
  );
  await page.reload();
  await expect(icono).toBeVisible();
  await expect(nuevo).toHaveCount(0);
});

// Un lugar cercano al origen, lejos del punto medio recto entre Huamachuco y Trujillo.
const AMARU = { id: 3, nombre: "Tupac Amaru", latitud: -7.9, longitud: -78.2 };
const conUbicacion = {
  ...viaje,
  ultima_ubicacion: {
    id: 1,
    lugar_id: 3,
    texto: "Tupac Amaru",
    nota: null,
    registrado_en: hace(1),
    origen: "oficina",
  },
};

test("sin líneas en el satélite y la unidad va en el lugar donde se anotó su ubicación", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await page.setViewportSize({ width: 1920, height: 990 });
  const avatar = page.locator(".leaflet-marker-icon:has(div svg)");
  const abrir = async () => {
    await page.goto(`/control-tv?unidad=${ID}`);
    await expect(page.getByRole("heading", { name: "Pia Prueba" })).toBeVisible();
    await page.getByRole("button", { name: "Satélite", exact: true }).click();
    await expect(avatar).toHaveCount(1);
    await page.waitForTimeout(700); // el mapa termina de encuadrar
    // El satélite vuelve a dibujar sus marcadores con cada actualización de la pantalla: se reintenta
    // hasta medirlo con el marcador puesto.
    let caja: { x: number; y: number } | null = null;
    await expect
      .poll(async () => {
        caja = await avatar.boundingBox().catch(() => null);
        return caja !== null;
      })
      .toBe(true);
    return caja as unknown as { x: number; y: number };
  };

  // Sin ubicación anotada: a mitad del tramo, y sin ninguna línea dibujada.
  await prepararRespuestas(page, viaje, [AMARU]);
  const medio = await abrir();
  await expect(page.locator(".leaflet-overlay-pane path")).toHaveCount(0);
  // Los dos pines (origen y destino) y el avatar siguen: solo se quitaron las líneas.
  await expect(page.locator(".leaflet-marker-icon")).toHaveCount(3);

  // Con la ubicación anotada en un lugar con punto: la unidad cambia de sitio (va al lugar).
  await page.unroute(/\/api\/erp\/viajes\/lugares(\?.*)?$/);
  await page.unroute(new RegExp(`/api/erp/viajes/${ID}(\\?.*)?$`));
  await prepararRespuestas(page, conUbicacion, [AMARU]);
  const exacta = await abrir();
  expect(Math.hypot(exacta.x - medio.x, exacta.y - medio.y)).toBeGreaterThan(60);
  if (process.env.CAPTURAS_TV) {
    await page.screenshot({ path: `${process.env.CAPTURAS_TV}/sin-lineas-satelite-exacta.png` });
  }
});

test("sin líneas en el digital: ninguna ruta dibujada y el aviso del mapa sigue siendo legible", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await prepararRespuestas(page, conUbicacion, [AMARU]);
  await page.setViewportSize({ width: 1920, height: 990 });
  await page.goto(`/control-tv?unidad=${ID}`);
  await expect(page.getByRole("heading", { name: "Pia Prueba" })).toBeVisible();
  const mapa = page.getByRole("img", { name: /Mapa de las unidades en ruta/ });
  await expect(mapa).toBeVisible();
  await page.waitForTimeout(800);
  // Con la ubicación anotada en un lugar con punto, el texto dice que la posición es la anotada, no estimada.
  await expect(page.getByText("en el punto anotado")).toBeVisible();
  await expect(page.getByText("estimada por las marcas")).toHaveCount(0);
  // La capa fija (la que dibujaba las rutas) no tiene píxeles del color de la ruta (lima #d4f25a).
  const pixelesDeRuta = await page.evaluate(() => {
    const c = document.querySelectorAll("canvas")[0] as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (
        d[i + 3] > 40 &&
        d[i] > 190 &&
        d[i] < 235 &&
        d[i + 1] > 225 &&
        d[i + 2] > 60 &&
        d[i + 2] < 130
      )
        n++;
    return n;
  });
  expect(pixelesDeRuta).toBe(0);
  if (process.env.CAPTURAS_TV) {
    await page.screenshot({ path: `${process.env.CAPTURAS_TV}/sin-lineas-digital-exacta.png` });
  }
});
