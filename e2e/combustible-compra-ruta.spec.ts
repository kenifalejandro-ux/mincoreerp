/** e2e/combustible-compra-ruta.spec.ts
 *
 * "Compra en ruta" (0135): UNA boleta con combustible, urea o los dos, desde su
 * propia entrada del menú de Combustible.
 *
 * Qué prueba y por qué en un navegador real: los tests de servidor ya cubren la
 * API (atomicidad, reintento, permisos, cuadre). Lo que solo se ve acá es la
 * cadena completa de la pantalla -- que el cuadre se calcule en vivo, que el
 * botón no deje enviar un descuadre sin motivo, que sin señal la compra quede en
 * el equipo y se sincronice sola UNA vez (con su foto), y que el formulario sea
 * usable en el celular, que es donde lo llena el conductor.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

// JPEG de 1x1 píxel: válido para el navegador y para el filtro de tipos.
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);

const unico = () => randomBytes(3).toString("hex").toUpperCase();

/** Una unidad con horómetro, un proveedor que vende diésel Y urea en ruta, y un
 *  envase de urea: andamiaje por API, no lo que se prueba. */
async function sembrar(page: Page, marca: string) {
  const equipo = await page.request.post("/api/erp/equipos", {
    data: { placa_codigo: marca, tipo: "VOLQUETE", tipo_medidor: "horometro" },
  });
  expect(equipo.status(), "no se pudo crear el equipo de prueba").toBe(201);
  const grifo = await page.request.post("/api/erp/combustible/grifos", {
    data: {
      nombre: `PRIMAX ${marca}`,
      abastece_ruta: true,
      abastece_tanque: false,
      abastece_urea: true,
      abastece_urea_ruta: true,
    },
  });
  expect(grifo.status(), "no se pudo crear el proveedor de prueba").toBe(201);

  // El catálogo de envases lo siembra el alta de la empresa; por si este
  // tenant de prueba no lo trae, se crea uno. Un 409 (ya existe) es correcto.
  const pres = await page.request.get("/api/erp/combustible/urea/presentaciones");
  const lista = pres.ok() ? ((await pres.json()) as { activa: boolean }[]) : [];
  if (!lista.some((p) => p.activa)) {
    await page.request.post("/api/erp/combustible/urea/presentaciones", {
      data: { codigo: "caja", nombre: "Caja", litros: 20, es_referencia: true },
    });
  }
  return { grifoNombre: `PRIMAX ${marca}` };
}

/** En pantalla chica el menú lateral está plegado detrás de un botón. */
async function abrirCompraEnRuta(page: Page) {
  const mostrar = page.getByRole("button", { name: "Mostrar menú" });
  if (await mostrar.isVisible()) await mostrar.click();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  // En celular, entrar a Combustible cierra el menú: se reabre para ver sus
  // submenús.
  if (await mostrar.isVisible()) await mostrar.click();
  await page.getByRole("button", { name: "Compra en ruta" }).click();
  await expect(page.getByRole("heading", { name: "Compra en ruta", level: 1 })).toBeVisible();
  // El formulario vive en una ventana: la pantalla es el historial y este botón.
  await page.getByRole("button", { name: "Registrar compra", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Registrar compra en ruta" })).toBeVisible();
}

async function elegirPorTexto(page: Page, selector: string, texto: string) {
  // Las unidades y proveedores llegan del servidor después de abrir la
  // pantalla: se espera a que la opción exista antes de buscarla.
  await expect(page.locator(`${selector} option`, { hasText: texto })).toHaveCount(1);
  const valor = await page
    .locator(`${selector} option`)
    .evaluateAll(
      (opciones, buscado) =>
        (opciones as HTMLOptionElement[]).find((o) => o.textContent?.includes(buscado as string))
          ?.value ?? null,
      texto
    );
  expect(valor, `no hay una opción con "${texto}" en ${selector}`).not.toBeNull();
  await page.locator(selector).selectOption(valor as string);
}

/** Llena la boleta completa: 40 gal × S/ 17.50 = 700 y 2 cajas × S/ 50 = 100,
 *  total 800. */
async function llenar(
  page: Page,
  datos: { marca: string; grifoNombre: string; numero: string; total: string; foto?: boolean }
) {
  await page.getByLabel("Incluye urea").check();

  await elegirPorTexto(page, "#compra-unidad", datos.marca);
  await elegirPorTexto(page, "#compra-proveedor", datos.grifoNombre);
  await page.locator("#compra-comprobante-numero").fill(datos.numero);
  if (datos.foto) {
    // Solo el del formulario: el historial de abajo trae uno por cada fila.
    await page
      .locator("form")
      .locator('input[type="file"]')
      .setInputFiles({ name: "boleta.jpg", mimeType: "image/jpeg", buffer: JPEG_1X1 });
    await expect(page.locator("form").getByText(/boleta\.jpg/)).toBeVisible();
  }

  await page.locator("#compra-galones").fill("40");
  await page.locator("#compra-medidor").fill("5000");
  // Primera carga de la unidad: no hay anterior, las horas se escriben a mano.
  await page.locator("#compra-horas").fill("12");
  await page.locator("#compra-costo-unitario").fill("17.5");

  const urea = page.locator("section", { hasText: "Qué se compró" });
  await urea.locator('input[type="number"]').nth(0).fill("2");
  await urea.locator('input[type="number"]').nth(1).fill("50");

  await page.locator("#compra-total-boleta").fill(datos.total);
}

const botonRegistrar = (page: Page) =>
  page.getByRole("dialog").getByRole("button", { name: /Registrar compra|Guardando/ });

/** Los despachos de esa boleta según el servidor. El listado separa por
 *  producto (combustible por defecto), así que se piden los dos. */
async function despachosDeLaBoleta(page: Page, numero: string) {
  const encontrados: {
    comprobante_numero: string | null;
    producto: string;
    comprobante_nombre?: string | null;
  }[] = [];
  for (const producto of ["combustible", "urea"]) {
    const res = await page.request.get(
      `/api/erp/combustible/despachos?pageSize=200&producto=${producto}`
    );
    const cuerpo = res.ok() ? await res.json() : {};
    const filas = (Array.isArray(cuerpo) ? cuerpo : (cuerpo.data ?? [])) as {
      comprobante_numero: string | null;
      comprobante_nombre?: string | null;
    }[];
    for (const f of filas) {
      if (f.comprobante_numero === numero) encontrados.push({ ...f, producto });
    }
  }
  return encontrados;
}

async function flujoCompleto(page: Page) {
  const marca = `CRU-${unico()}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);
  await abrirCompraEnRuta(page);

  // Sin boleta que comparar, el botón no deja enviar.
  await expect(botonRegistrar(page)).toBeDisabled();

  await llenar(page, { marca, grifoNombre, numero, total: "800", foto: true });

  // El cuadre se calcula en vivo, con lo que dice el papel.
  await expect(page.getByText("Cuadra: la boleta coincide con lo registrado.")).toBeVisible();
  await expect(botonRegistrar(page)).toBeEnabled();

  await botonRegistrar(page).click();
  await expect(
    page.getByText(new RegExp(`Compra registrada \\(la boleta ${numero}\\)`))
  ).toBeVisible({ timeout: 30_000 });

  // Los dos productos quedaron con LA MISMA boleta, y la foto en los dos.
  await expect
    .poll(async () => (await despachosDeLaBoleta(page, numero)).map((d) => d.producto).sort(), {
      message: "no quedaron los dos despachos de la boleta",
    })
    .toEqual(["combustible", "urea"]);
  await expect
    .poll(
      async () =>
        (await despachosDeLaBoleta(page, numero)).filter((d) => d.comprobante_nombre).length,
      { message: "la foto no quedó en los dos despachos" }
    )
    .toBe(2);

  // El formulario queda limpio para la siguiente compra.
  await expect(page.locator("#compra-comprobante-numero")).toHaveCount(0);
}

test("compra en ruta: una boleta con combustible y urea crea los dos despachos con su foto", async ({
  page,
}) => {
  await flujoCompleto(page);
});

test.describe("en pantalla de celular", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true });

  test("compra en ruta: el mismo flujo en 393x852", async ({ page }) => {
    await flujoCompleto(page);
  });
});

test("un total que no cuadra pide el motivo y no deja registrar sin él", async ({ page }) => {
  const marca = `DSC-${unico()}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);
  await abrirCompraEnRuta(page);
  await llenar(page, { marca, grifoNombre, numero, total: "810" });

  await expect(page.getByText(/No cuadra: diferencia de S\/\s*10[.,]00/)).toBeVisible();
  await expect(page.locator("#compra-motivo")).toBeVisible();
  await expect(botonRegistrar(page)).toBeDisabled();

  // Una diferencia de centavos es redondeo y no pide nada.
  await page.locator("#compra-total-boleta").fill("800.05");
  await expect(page.getByText("Cuadra: la boleta coincide con lo registrado.")).toBeVisible();
  await expect(page.locator("#compra-motivo")).toHaveCount(0);

  await page.locator("#compra-total-boleta").fill("810");
  await page.locator("#compra-motivo").fill("El grifo cobró un servicio de lavado");
  await expect(botonRegistrar(page)).toBeEnabled();
  await botonRegistrar(page).click();

  await expect(
    page.getByText(new RegExp(`Compra registrada \\(la boleta ${numero}\\)`))
  ).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await despachosDeLaBoleta(page, numero)).length).toBe(2);

  // Y la boleta que no cuadra queda a la vista de quien revisa: en la Bandeja,
  // con el papel, lo registrado y el motivo que escribió el conductor.
  await page.getByRole("button", { name: /^Bandeja/ }).click();
  await page.getByText(numero).first().click();
  await expect(
    page.getByText(/El papel dice S\/ 810\.00 y lo registrado suma S\/ 800\.00/)
  ).toBeVisible();
  await expect(page.getByText(/Motivo: El grifo cobró un servicio de lavado/)).toBeVisible();
});

test("sin señal la compra queda en el equipo y se sincroniza sola, una sola vez, con su foto", async ({
  page,
  context,
}) => {
  const marca = `OFC-${unico()}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);
  // Unidad, proveedor y catálogos se eligen TODAVÍA CON RED: es el caso real,
  // el conductor abre la app donde hay señal y la pierde camino.
  await abrirCompraEnRuta(page);
  await llenar(page, { marca, grifoNombre, numero, total: "800", foto: true });

  // ── Se corta la red ──────────────────────────────────────────────────
  await context.setOffline(true);
  await botonRegistrar(page).click();
  await expect(
    page.getByText(/Sin conexión: la boleta .* quedó guardada en este equipo/)
  ).toBeVisible({ timeout: 30_000 });
  // Dos avisos con ese rol: el de la pantalla y la franja del Layout.
  await expect(page.getByRole("status").filter({ hasText: "Sin conexión" }).first()).toBeVisible();

  // ── Vuelve la red ────────────────────────────────────────────────────
  await context.setOffline(false);

  // El drenaje lo dispara el evento "online" o, si no llega, el reintento
  // periódico de offlineSync.ts: de ahí el timeout holgado.
  await expect
    .poll(async () => (await despachosDeLaBoleta(page, numero)).map((d) => d.producto).sort(), {
      timeout: 60_000,
      message: "la compra guardada sin red no llegó al servidor",
    })
    .toEqual(["combustible", "urea"]);

  // Lo que más importa: UNA sola compra, aunque la cola haya reintentado, y la
  // foto, que viaja DESPUÉS del registro, quedó en los dos.
  await expect
    .poll(
      async () =>
        (await despachosDeLaBoleta(page, numero)).filter((d) => d.comprobante_nombre).length,
      { timeout: 60_000, message: "la foto encolada no quedó en los dos despachos" }
    )
    .toBe(2);
  expect(await despachosDeLaBoleta(page, numero)).toHaveLength(2);
});

/** Una carga anterior de la unidad, por API: andamiaje para las horas
 *  abastecidas, que se calculan contra ella. */
async function registrarCargaPrevia(
  page: Page,
  marca: string,
  grifoNombre: string,
  horometro: number
) {
  const equipos = await page.request.get("/api/erp/combustible/equipos-destino?pageSize=200");
  const equipo = ((await equipos.json()).data as { id: number; placa_codigo: string }[]).find(
    (e) => e.placa_codigo === marca
  );
  const grifos = await page.request.get("/api/erp/combustible/grifos/para-formulario");
  const grifo = ((await grifos.json()) as { id: number; nombre: string }[]).find(
    (g) => g.nombre === grifoNombre
  );
  expect(equipo && grifo, "no se encontró la unidad o el proveedor sembrados").toBeTruthy();
  const r = await page.request.post("/api/erp/combustible/despachos", {
    data: {
      origen: "compra_externa",
      grifo_id: grifo!.id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo!.id,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${unico()}`,
      cantidad: 40,
      lectura_horometro: horometro,
      horas_abastecidas: 10,
      costo_unitario: 17.5,
      despachado_en: new Date(Date.now() - 3600_000).toISOString(),
    },
  });
  expect(r.status(), await r.text()).toBe(201);
}

test("horas abastecidas: se calculan solas desde la carga anterior y lo escrito a mano manda", async ({
  page,
}) => {
  const marca = `HRS-${unico()}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);
  await registrarCargaPrevia(page, marca, grifoNombre, 1000);

  await abrirCompraEnRuta(page);
  await elegirPorTexto(page, "#compra-unidad", marca);
  await elegirPorTexto(page, "#compra-proveedor", grifoNombre);

  const horas = page.locator("#compra-horas");
  const horometro = page.locator("#compra-medidor");

  await horometro.fill("1012.5");
  await expect(horas).toHaveValue("12.5");
  await expect(page.getByText(/Carga anterior: 1\.?,?000 h/)).toBeVisible();

  // Lo escrito a mano manda: cambiar la lectura NO pisa lo que el conductor puso.
  await horas.fill("99");
  await horometro.fill("1020");
  await expect(horas).toHaveValue("99");

  // Vaciarlo devuelve el campo al cálculo.
  await horas.fill("");
  await expect(horas).toHaveValue("20");

  // Una lectura menor que la anterior no inventa horas negativas: avisa y deja a mano.
  await horometro.fill("900");
  await expect(horas).toHaveValue("");
  await expect(page.getByText(/La lectura es menor que la de la carga anterior/)).toBeVisible();
});

test("horas abastecidas: una unidad sin carga anterior queda a mano, sin inventar nada", async ({
  page,
}) => {
  const marca = `NEW-${unico()}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);

  await abrirCompraEnRuta(page);
  await elegirPorTexto(page, "#compra-unidad", marca);
  await elegirPorTexto(page, "#compra-proveedor", grifoNombre);
  await page.locator("#compra-medidor").fill("500");

  await expect(page.getByText(/No hay una carga anterior con horómetro/)).toBeVisible();
  await expect(page.locator("#compra-horas")).toHaveValue("");
});

test("el historial junta la boleta en una fila y la foto única se sube y se reemplaza desde ahí", async ({
  page,
}) => {
  const marca = `HIS-${unico()}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();
  const PDF = Buffer.from("%PDF-1.4\n%reemplazo\n");

  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);
  await abrirCompraEnRuta(page);
  // Sin foto: es lo que pasa cuando el conductor no la tiene a mano al comprar.
  await llenar(page, { marca, grifoNombre, numero, total: "800" });
  await botonRegistrar(page).click();
  await expect(
    page.getByText(new RegExp(`Compra registrada \\(la boleta ${numero}\\)`))
  ).toBeVisible({ timeout: 30_000 });

  // UNA sola fila con combustible y urea juntos.
  const fila = page.getByRole("row").filter({ hasText: numero });
  await expect(fila).toHaveCount(1);
  await expect(fila).toContainText("Diésel B5");
  await expect(fila).toContainText("Urea");
  await expect(fila).toContainText("Subir foto");

  // Sube la foto UNA vez desde el historial: queda en los dos despachos.
  await fila
    .locator('input[type="file"]')
    .setInputFiles({ name: "boleta.jpg", mimeType: "image/jpeg", buffer: JPEG_1X1 });
  await expect(
    page.getByText(new RegExp(`Comprobante adjuntado a la boleta ${numero}`))
  ).toBeVisible();
  await expect(fila.getByRole("button", { name: "Ver comprobante" })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await despachosDeLaBoleta(page, numero)).filter((d) => d.comprobante_nombre).length,
      { message: "la foto subida desde el historial no quedó en los dos despachos" }
    )
    .toBe(2);

  // Reemplazarla pide foto nueva y motivo.
  await fila.getByRole("button", { name: "Reemplazar", exact: true }).click();
  const confirmar = page
    .getByRole("dialog")
    .getByRole("button", { name: "Reemplazar", exact: true });
  await expect(confirmar).toBeDisabled();
  await page
    .getByRole("dialog")
    .locator('input[type="file"]')
    .setInputFiles({ name: "nueva.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(confirmar).toBeDisabled(); // con foto pero sin motivo, tampoco
  await page
    .getByRole("dialog")
    .getByPlaceholder(/foto anterior/)
    .fill("la foto anterior estaba borrosa");
  await expect(confirmar).toBeEnabled();
  await confirmar.click();
  await expect(
    page.getByText(new RegExp(`Comprobante de la boleta ${numero} reemplazado`))
  ).toBeVisible({ timeout: 20_000 });
});

/** ¿Hay un borrador guardado en este navegador? */
const hayBorrador = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage).some((k) => k.startsWith("mincore:compra-ruta-borrador:"))
  );

test("el borrador: lo escrito sobrevive a una recarga y se puede descartar", async ({ page }) => {
  const marca = `BOR-${unico()}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);
  await abrirCompraEnRuta(page);

  // Un formulario recién abierto no deja borrador.
  expect(await hayBorrador(page)).toBe(false);

  await elegirPorTexto(page, "#compra-unidad", marca);
  await elegirPorTexto(page, "#compra-proveedor", grifoNombre);
  await page.locator("#compra-comprobante-numero").fill(numero);
  await page.locator("#compra-galones").fill("33");
  await page.locator("#compra-total-boleta").fill("500");
  // Se espera a que el borrador ya traiga LO ÚLTIMO que se escribió (el guardado
  // tiene una pausa de 400 ms), no solo a que exista uno.
  await expect
    .poll(
      () =>
        page.evaluate(
          (n) =>
            Object.entries(localStorage).some(
              ([k, v]) => k.startsWith("mincore:compra-ruta-borrador:") && v.includes(n)
            ),
          numero
        ),
      { message: "el borrador no quedó con lo último escrito" }
    )
    .toBe(true);

  // Se cierra la pantalla (o se va la señal): al volver, sigue ahí.
  await page.reload();
  await abrirCompraEnRuta(page);
  await expect(page.getByText(/Recuperamos lo que estabas escribiendo/)).toBeVisible();
  await expect(page.locator("#compra-comprobante-numero")).toHaveValue(numero);
  await expect(page.locator("#compra-galones")).toHaveValue("33");
  await expect(page.locator("#compra-total-boleta")).toHaveValue("500");
  await expect(page.locator("#compra-unidad")).not.toHaveValue("");
  await expect(page.locator("#compra-proveedor")).not.toHaveValue("");

  // Empezar de cero lo borra de verdad: otra recarga ya no lo trae.
  await page.getByRole("button", { name: "Empezar de cero" }).click();
  await expect(page.locator("#compra-comprobante-numero")).toHaveValue("");
  await expect(page.getByText(/Recuperamos lo que estabas escribiendo/)).toHaveCount(0);
  await expect.poll(() => hayBorrador(page)).toBe(false);
  await page.reload();
  await abrirCompraEnRuta(page);
  await expect(page.getByText(/Recuperamos lo que estabas escribiendo/)).toHaveCount(0);
  await expect(page.locator("#compra-comprobante-numero")).toHaveValue("");
});

test("el borrador se borra al registrar la compra: no vuelve en la recarga", async ({ page }) => {
  const marca = `BRG-${unico()}`;
  const numero = `B001-${unico()}`;
  const admin = adminA();

  await loginPorUI(page, admin.email, admin.password);
  const { grifoNombre } = await sembrar(page, marca);
  await abrirCompraEnRuta(page);
  await llenar(page, { marca, grifoNombre, numero, total: "800" });
  await expect.poll(() => hayBorrador(page)).toBe(true);

  await botonRegistrar(page).click();
  await expect(
    page.getByText(new RegExp(`Compra registrada \\(la boleta ${numero}\\)`))
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => hayBorrador(page), { message: "el borrador quedó tras registrar" })
    .toBe(false);

  await page.reload();
  await abrirCompraEnRuta(page);
  await expect(page.getByText(/Recuperamos lo que estabas escribiendo/)).toHaveCount(0);
  await expect(page.locator("#compra-comprobante-numero")).toHaveValue("");
});
