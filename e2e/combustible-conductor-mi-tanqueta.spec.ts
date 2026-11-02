/** e2e/combustible-conductor-mi-tanqueta.spec.ts
 *
 * "Mi tanqueta" del conductor (pestaña Tanquetas): el cilindro de la tanqueta asignada a SU
 * unidad. Qué prueba y por qué en un navegador real: los tests de servidor ya cubren el 404 de
 * lo ajeno y el saldo; lo que solo se ve acá es la pantalla del conductor:
 *   - el cilindro baja SOLO cuando otro (la oficina) carga, sin recargar la página;
 *   - baja cuando el propio conductor carga por el formulario;
 *   - el sobregiro (saldo negativo) se dice y el líquido no se sale del vidrio;
 *   - sin señal se queda el último saldo conocido y lo avisa; al volver la señal, se corrige;
 *   - dos tanquetas en la unidad: aparece el selector y cambia el cilindro;
 *   - sin tanqueta o sin unidad: un mensaje claro y su historial de cargas sigue ahí.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  type ViajeDeConductor,
} from "./fixtures/conductorConViaje";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

/** El service worker se interpone a `page.route` (en WebKit no se llega a interceptar nada: el
 *  500 simulado de abajo nunca salía). Bloquearlo no debilita lo que este spec prueba: la pantalla
 *  vuelve a pedir, guarda su caché en localStorage y avisa; nada de eso depende del service
 *  worker. Mismo recurso que e2e/capa-b-cliente-uuid.spec.ts. */
test.use({ serviceWorkers: "block" });

const SIN_CARGAS = "Todavía no hay cargas desde tanqueta registradas.";

const crear = async (page: Page, ruta: string, data: object, esperado = 201) => {
  const r = await page.request.post(ruta, { data });
  expect(r.status(), `${ruta}: ${await r.text()}`).toBe(esperado);
  return (await r.json()) as Record<string, unknown>;
};

const nuevoConductor = (marca: string, prefijo: string, nombre: string) => ({
  dni: `${prefijo}${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`,
  password: `Clave-${marca}-9x`,
  nombre,
});

/** Lo que `entrarAMiViaje` y `darDeBajaAlConductor` piden de un conductor (sin viaje). */
const comoConductor = (marca: string, c: { dni: string; password: string }): ViajeDeConductor => ({
  a: "",
  b: "",
  dni: c.dni,
  password: c.password,
  marca,
  viajeId: "",
  numero: 0,
});

/** Da de baja a los conductores de prueba que alcanzaron a crearse. Cada baja es independiente y
 *  una que falle no tapa el fallo real del test ni impide las demás. */
async function darDeBajaLosCreados(
  page: Page,
  marca: string,
  creados: { dni: string; password: string }[]
) {
  for (const c of creados) {
    try {
      await darDeBajaAlConductor(page, comoConductor(marca, c));
    } catch {
      // Limpieza de mejor esfuerzo.
    }
  }
}

/** Un tanque de donde llenar las tanquetas. */
const crearTanque = (page: Page, marca: string, grifoInternoId: number) =>
  crear(page, "/api/erp/combustible", {
    codigo: `HMH-${marca}`,
    tanque_nombre: `Huamachuco ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 10000,
    nivel_actual: 8000,
    requiere_documento: false,
    grifo_interno_id: grifoInternoId,
  });

/** Una tanqueta de 280 gal, llenada con `galones` desde el tanque y asignada a la unidad. */
async function tanquetaConSaldo(
  page: Page,
  marca: string,
  grifoInternoId: number,
  tanqueId: unknown,
  equipoId: unknown,
  numero: number,
  galones: number
) {
  const tanqueta = await crear(page, "/api/erp/combustible/tanquetas", {
    grifo_interno_id: grifoInternoId,
    codigo: `TQ${numero}-${marca}`,
  });
  await crear(page, "/api/erp/combustible/despachos", {
    origen: "tanque_propio",
    combustible_id: tanqueId,
    tipo_combustible: "diesel_b5",
    tipo_destino: "reserva_cubeta",
    tanqueta_destino_id: Number(tanqueta.id),
    serie_talonario: `P${marca}`,
    n_vale: numero,
    cantidad: galones,
    lectura_contometro: galones,
    costo_unitario: 16,
  });
  const asignada = await page.request.put(`/api/erp/combustible/tanquetas/${tanqueta.id}/asignar`, {
    data: { equipo_id: equipoId, serie_talonario: `C${marca}`, n_vale: numero },
  });
  expect(asignada.status(), await asignada.text()).toBe(200);
  return { id: Number(tanqueta.id), codigo: tanqueta.codigo as string };
}

test("Mi tanqueta: el cilindro baja solo cuando se carga y avisa sin señal @celular", async ({
  page,
  browser,
}) => {
  // Siembra por API, la oficina en otra sesión y la pantalla del conductor.
  test.setTimeout(240_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const contexto = await browser.newContext();
  const oficina = await contexto.newPage();
  const admin = adminA();
  const creados: { dni: string; password: string }[] = [];
  try {
    await loginPorUI(oficina, admin.email, admin.password);
    const grifoInternoId = await primerGrifoActivo(oficina);

    const conductor = nuevoConductor(marca, "96", `Conductor ${marca}`);
    await crear(oficina, "/api/erp/usuarios", { ...conductor, rol: "conductor_ruta" });
    creados.push(conductor);
    const tanque = await crearTanque(oficina, marca, grifoInternoId);
    const placa = `VM-${marca}`;
    const equipo = await crear(oficina, "/api/erp/equipos", {
      placa_codigo: placa,
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      conductor_nombre: conductor.nombre,
      conductor_dni: conductor.dni,
      grifo_interno_id: grifoInternoId,
    });
    const t1 = await tanquetaConSaldo(oficina, marca, grifoInternoId, tanque.id, equipo.id, 1, 120);
    const cargaDeLaOficina = (cantidad: number, medidor: number) =>
      oficina.request.post("/api/erp/combustible/despachos", {
        data: {
          origen: "tanqueta",
          tanqueta_origen_id: t1.id,
          tipo_combustible: "diesel_b5",
          tipo_destino: "equipo",
          equipo_id: equipo.id,
          cantidad,
          lectura_horometro: medidor,
        },
      });
    // El cilindro se nombra por lo que dice: "<código>: <saldo> de 280 galones".
    const cilindro = (saldo: string) =>
      page.getByRole("img", { name: `${t1.codigo}: ${saldo} de 280 galones`, exact: true });
    // El kardex: una fila por movimiento, la más reciente primero; la última celda es el Saldo.
    const kardex = page.getByRole("region", { name: "Movimientos de la tanqueta" });
    const filaKardex = (texto: string) => kardex.getByRole("row").filter({ hasText: texto });
    const saldoDe = (fila: ReturnType<typeof filaKardex>) => fila.getByRole("cell").last();
    const valeDeLlenado = `P${marca}-1`;
    const valeDeSalida = `C${marca}-1`;

    await entrarAMiViaje(page, comoConductor(marca, conductor));
    await page.getByRole("button", { name: "Tanquetas" }).click();

    // ── Su tanqueta, con lo que lleva, y su historial de cargas al lado ─────
    await expect(page.getByRole("heading", { name: "Mi tanqueta", level: 1 })).toBeVisible();
    await expect(cilindro("120")).toBeVisible();
    await expect(page.getByText("Saldo según registros")).toBeVisible();
    await expect(page.getByText(`Unidad ${placa}`)).toBeVisible();
    await expect(page.getByText(/Actualizado a las/)).toBeVisible();

    // ── A la derecha, los movimientos de la tanqueta (kardex) que cuadran con el cilindro ──
    await expect(page.getByRole("tab", { name: "Movimientos" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(kardex.getByText("CUADRA CON EL CILINDRO")).toBeVisible();
    await expect(filaKardex("Llenada desde")).toContainText(valeDeLlenado);
    const filaSalida = filaKardex("Salida a la unidad · 120 gal");
    await expect(filaSalida).toContainText(valeDeSalida);
    await expect(filaSalida).toContainText(placa);
    await expect(saldoDe(filaSalida)).toHaveText("120");
    // El Saldo siempre a la vista, y cada fila en una sola línea (no se parte en varias). A 1280 px
    // la tabla cabe entera y la comprobación sería trivial: se hace también en un celular, donde
    // la tabla se desplaza de lado y el Saldo debe quedarse fijo a la derecha.
    const grande = page.viewportSize()!;
    for (const ancho of [grande.width, 360]) {
      await page.setViewportSize({ width: ancho, height: 800 });
      // A 360 px el cilindro queda arriba y la tabla más abajo: se baja hasta ella. Con la tabla
      // desplazada al inicio, un Saldo que no fuera fijo quedaría fuera por la derecha.
      await filaSalida.scrollIntoViewIfNeeded();
      await filaSalida.evaluate((fila) => {
        const contenedor = fila.closest(".overflow-x-auto");
        if (contenedor) contenedor.scrollLeft = 0;
      });
      await expect(saldoDe(filaSalida)).toBeInViewport();
      expect((await filaSalida.boundingBox())!.height).toBeLessThan(50);
    }
    await page.setViewportSize(grande);

    // Las pestañas se manejan con el teclado: flechas, y solo la activa está en el orden del Tab.
    const pestanaMov = page.getByRole("tab", { name: "Movimientos" });
    const pestanaCargas = page.getByRole("tab", { name: "Mis cargas" });
    await expect(pestanaCargas).toHaveAttribute("tabindex", "-1");
    await pestanaMov.focus();
    await page.keyboard.press("ArrowRight");
    await expect(pestanaCargas).toHaveAttribute("aria-selected", "true");
    await expect(pestanaCargas).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(pestanaMov).toHaveAttribute("aria-selected", "true");
    await expect(pestanaMov).toBeFocused();

    // ── La oficina carga 10 gal a su unidad: el cilindro baja SOLO ─────────
    // El stream de eventos se abre un instante después de pintar la pantalla; un evento que sale
    // antes de que quede suscrito no llega (la pantalla lo recupera al reabrirse, no al primer
    // pintado). Se espera ese instante para probar el aviso en vivo y no una carrera.
    await page.waitForTimeout(1500);
    const delaOficina = await cargaDeLaOficina(10, 1000);
    expect(delaOficina.status(), await delaOficina.text()).toBe(201);
    await expect(cilindro("110")).toBeVisible({ timeout: 20_000 });
    // Y el kardex lo dice: la carga de otro (la oficina) con el vale de la salida y el saldo.
    const fila10 = filaKardex("Carga en ruta").first();
    await expect(fila10).toContainText("−10");
    await expect(fila10).toContainText(valeDeSalida);
    await expect(fila10).toContainText(conductor.nombre);
    await expect(saldoDe(fila10)).toHaveText("110");
    const idCarga10 = (await delaOficina.json()).id as number;

    // ── El conductor carga 5 gal por el formulario: también baja ───────────
    await page.getByRole("button", { name: "Carga desde tanqueta" }).first().click();
    await expect(page.locator("#despacho-medidor-tanqueta")).toBeEnabled({ timeout: 15_000 });
    await page.locator("#despacho-cantidad-tanqueta").fill("5");
    await page.locator("#despacho-medidor-tanqueta").fill("1100");
    await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
    await expect(page.getByText(`Despacho registrado: la carga desde ${t1.codigo}.`)).toBeVisible();
    await expect(cilindro("105")).toBeVisible({ timeout: 20_000 });
    const fila5 = filaKardex("Carga en ruta").first();
    await expect(fila5).toContainText("−5");
    await expect(saldoDe(fila5)).toHaveText("105");
    // "Mis cargas" es solo lo que ÉL sacó: la de la oficina no está.
    await page.getByRole("tab", { name: "Mis cargas" }).click();
    await expect(page.getByRole("row").filter({ hasText: placa })).toHaveCount(1);
    await page.getByRole("tab", { name: "Movimientos" }).click();

    // ── Se anula la carga de la oficina: el cilindro sube y el kardex la deja tachada ──
    const anulada = await oficina.request.patch(
      `/api/erp/combustible/despachos/${idCarga10}/anular`,
      { data: { motivo: "Digitada de más" } }
    );
    expect(anulada.status(), await anulada.text()).toBe(200);
    await expect(cilindro("115")).toBeVisible({ timeout: 20_000 });
    const filaAnulada = filaKardex("Carga en ruta").filter({ hasText: "ANULADA" });
    await expect(filaAnulada).toHaveCount(1);
    // Columna Cantidad (la sexta): la cifra tachada, sin "+" ni "−" porque no movió nada.
    await expect(filaAnulada.getByRole("cell").nth(5)).toHaveText(/^10$/);
    // Una anulada no mueve el saldo: queda donde estaba antes de ella.
    await expect(saldoDe(filaAnulada)).toHaveText("120");
    await expect(saldoDe(filaKardex("Carga en ruta").first())).toHaveText("115");

    // ── Sobregiro: se cargó más de lo que tenía registrado ─────────────────
    // El servidor lo acepta (los galones en ruta son estimados). La pantalla dice el saldo real,
    // lo explica y el líquido se queda en 0 %, sin salirse del vidrio.
    const sobregiro = await cargaDeLaOficina(200, 1200);
    expect(sobregiro.status(), await sobregiro.text()).toBe(201);
    const negativo = page.getByRole("img", {
      name: new RegExp(`^${t1.codigo}: [-−]85 de 280 galones$`),
    });
    await expect(negativo).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/Se cargaron 85 gal más de los que esta tanqueta tenía/)
    ).toBeVisible();
    // El kardex lo muestra con el saldo negativo, y sigue cuadrando con el cilindro.
    const fila200 = filaKardex("Carga en ruta").first();
    await expect(fila200).toContainText("−200");
    await expect(saldoDe(fila200)).toHaveText(/^[-−]85$/);
    await expect(kardex.getByText("CUADRA CON EL CILINDRO")).toBeVisible();
    await expect(negativo.locator("div[style*='height']").first()).toHaveAttribute(
      "style",
      /height:\s*0%/
    );

    // ── Sin señal: se queda lo último que se supo y lo dice ────────────────
    const pedirDeNuevo = () =>
      page.evaluate(() => window.dispatchEvent(new Event("combustible:actualizado")));
    await page.context().setOffline(true);
    await pedirDeNuevo();
    await expect(page.getByText(/Sin señal: último saldo conocido/)).toBeVisible();
    await expect(negativo).toBeVisible();
    await expect(filaKardex("Carga en ruta").first()).toContainText("−200");
    // Vuelve la señal: lo corrige solo y deja de avisar.
    await page.context().setOffline(false);
    await pedirDeNuevo();
    await expect(page.getByText(/Sin señal/)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(/Actualizado a las/)).toBeVisible();

    // ── El servidor responde con error: se queda lo último y lo dice ───────
    const mias = "**/api/erp/combustible/tanquetas/mias";
    await page.route(mias, (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Falla de prueba" }),
      })
    );
    await pedirDeNuevo();
    await expect(page.getByText(/No se pudo actualizar: último saldo conocido/)).toBeVisible();
    await expect(negativo).toBeVisible();
    await page.unroute(mias);
    await pedirDeNuevo();
    await expect(page.getByText(/No se pudo actualizar/)).toHaveCount(0, { timeout: 20_000 });

    // ── La tanqueta desaparece de la lista: el filtro de fechas del historial NO se pierde ──
    await page.getByRole("tab", { name: "Mis cargas" }).click();
    const desde = page.locator("#cargas-tanqueta-desde");
    await desde.fill("2026-01-01");
    await page.route(mias, (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );
    await pedirDeNuevo();
    await expect(page.getByText(/No hay una tanqueta asignada a tu unidad/)).toBeVisible();
    await expect(desde).toHaveValue("2026-01-01");
    await page.unroute(mias);
    await pedirDeNuevo();
    await expect(negativo).toBeVisible({ timeout: 20_000 });
    await expect(desde).toHaveValue("2026-01-01");

    // ── Sin señal y se vuelve a entrar a la pantalla: cilindro y movimientos salen del celular ──
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Compra en ruta" }).click();
    await page.getByRole("button", { name: "Tanquetas" }).click();
    await expect(negativo).toBeVisible();
    await expect(page.getByText(/Sin señal: último saldo conocido/)).toBeVisible();
    await expect(filaKardex("Carga en ruta").first()).toContainText("−200");
    await expect(saldoDe(filaKardex("Carga en ruta").first())).toHaveText(/^[-−]85$/);

    // ── Sin señal con un caché de forma vieja o rota: no tumba la pantalla ──────────────
    await page.evaluate(() => {
      for (const clave of Object.keys(localStorage)) {
        if (clave.startsWith("mi-tanqueta:")) {
          localStorage.setItem(
            clave,
            JSON.stringify({ guardadoEn: "basura", tanquetas: [{ id: 5, codigo: "VIEJA" }] })
          );
        }
      }
    });
    await page.context().setOffline(true);
    // Se sale y se vuelve a entrar a la pantalla (sin recargar la página): se monta sin señal.
    await page.getByRole("button", { name: "Compra en ruta" }).click();
    await page.getByRole("button", { name: "Tanquetas" }).click();
    await expect(page.getByRole("heading", { name: "Mi tanqueta", level: 1 })).toBeVisible();
    await expect(page.getByText(/Sin conexión: no se pudo cargar tu tanqueta/)).toBeVisible();
    await expect(page.getByText("Algo salió mal")).toHaveCount(0);
  } finally {
    await page.unroute("**/api/erp/combustible/tanquetas/mias").catch(() => {});
    await page.context().setOffline(false);
    await contexto.close();
    await darDeBajaLosCreados(page, marca, creados);
  }
});

test("Mi tanqueta: selector con dos tanquetas, y mensajes sin tanqueta o sin unidad", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  const creados: { dni: string; password: string }[] = [];
  try {
    await loginPorUI(page, admin.email, admin.password);
    const grifoInternoId = await primerGrifoActivo(page);

    const conDos = nuevoConductor(marca, "96", `Con dos ${marca}`);
    const sinTanqueta = nuevoConductor(marca, "95", `Sin tanqueta ${marca}`);
    const sinUnidad = nuevoConductor(marca, "94", `Sin unidad ${marca}`);
    for (const c of [conDos, sinTanqueta, sinUnidad]) {
      await crear(page, "/api/erp/usuarios", { ...c, rol: "conductor_ruta" });
      creados.push(c);
    }
    const tanque = await crearTanque(page, marca, grifoInternoId);
    const unidad = (c: { dni: string; nombre: string }, placa: string) =>
      crear(page, "/api/erp/equipos", {
        placa_codigo: placa,
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        conductor_nombre: c.nombre,
        conductor_dni: c.dni,
        grifo_interno_id: grifoInternoId,
      });
    const equipoDeDos = await unidad(conDos, `VD-${marca}`);
    await unidad(sinTanqueta, `VS-${marca}`);
    const primera = await tanquetaConSaldo(
      page,
      marca,
      grifoInternoId,
      tanque.id,
      equipoDeDos.id,
      1,
      120
    );
    const segunda = await tanquetaConSaldo(
      page,
      marca,
      grifoInternoId,
      tanque.id,
      equipoDeDos.id,
      2,
      60
    );

    const irATanquetas = async (c: { dni: string; password: string }) => {
      await page.request.post("/api/auth/logout");
      await entrarAMiViaje(page, comoConductor(marca, c));
      await page.getByRole("button", { name: "Tanquetas" }).click();
      await expect(page.getByRole("heading", { name: "Mi tanqueta", level: 1 })).toBeVisible();
    };

    // ── Dos tanquetas: el selector arranca en la más antigua y cambia el cilindro ──
    await page.request.post("/api/auth/logout");
    await irATanquetas(conDos);
    const selector = page.getByLabel("Tanqueta", { exact: true });
    await expect(selector).toBeVisible();
    await expect(selector).toHaveValue(String(primera.id));
    await expect(
      page.getByRole("img", { name: `${primera.codigo}: 120 de 280 galones`, exact: true })
    ).toBeVisible();
    // Los movimientos son los de la tanqueta elegida, y cambian con ella.
    const kardex = page.getByRole("region", { name: "Movimientos de la tanqueta" });
    await expect(kardex).toContainText("Salida a la unidad · 120 gal");
    await selector.selectOption({ label: segunda.codigo });
    await expect(kardex).toContainText("Salida a la unidad · 60 gal");
    await expect(kardex).not.toContainText("120 gal");
    await expect(
      page.getByRole("img", { name: `${segunda.codigo}: 60 de 280 galones`, exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: `${primera.codigo}: 120 de 280 galones`, exact: true })
    ).toHaveCount(0);

    // "Mis cargas" es la otra pestaña y trae el historial del conductor.
    await page.getByRole("tab", { name: "Mis cargas" }).click();
    await expect(page.getByText(SIN_CARGAS)).toBeVisible();
    await page.getByRole("tab", { name: "Movimientos" }).click();
    await expect(kardex).toBeVisible();

    // ── Con unidad pero sin tanqueta: lo dice, y su historial sigue ahí ──────
    await irATanquetas(sinTanqueta);
    await expect(page.getByText(/No hay una tanqueta asignada a tu unidad/)).toBeVisible();
    // El logo de la cabecera también es una imagen: se busca solo un cilindro.
    await expect(page.getByRole("img", { name: /de 280 galones$/ })).toHaveCount(0);
    // Sin tanqueta no hay kardex ni pestañas: se ve su historial directo.
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText(SIN_CARGAS)).toBeVisible();

    // ── Sin unidad en Equipos: dice que revisen el DNI ──────────────────────
    await irATanquetas(sinUnidad);
    await expect(page.getByText(/no tiene ninguna unidad a su cargo en Equipos/)).toBeVisible();
    await expect(page.getByText(SIN_CARGAS)).toBeVisible();
  } finally {
    await darDeBajaLosCreados(page, marca, creados);
  }
});
