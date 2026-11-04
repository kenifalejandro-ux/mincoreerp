/** e2e/combustible-cisterna.spec.ts
 *
 * El excedente que se queda en la cisterna del proveedor (0168): la opción
 * "Dejar en cisterna" del reparto, el aviso corto en Tanques que lleva a la
 * pestaña "Cisternas", y su reparto desde ahí a una unidad (con vale y medidor),
 * a una tanqueta (sin unidad no lleva vale) o al tanque, también sin señal.
 *
 * Por qué en un navegador real: la API ya la cubren los tests de servidor. Lo
 * que solo se ve acá es que la línea "cisterna" no pida unidad, que el aviso
 * salga y baje con cada salida, que el botón no deje pasarse del saldo, y que
 * una salida hecha sin señal quede guardada en el equipo y llegue sola.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

interface Cisterna {
  id: string;
  saldo: string;
  recepcion_id: string;
  tanque_codigo: string;
}

async function preparar(page: Page, marca: string) {
  const grifoInternoId = await primerGrifoActivo(page);
  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `CI-${marca}`,
      tanque_nombre: `Tanque cisterna ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 2000,
      nivel_actual: 2000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status(), "no se pudo crear el tanque de prueba").toBe(201);
  const placa = `CI-${marca}`;
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: placa,
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(equipo.status(), "no se pudo crear el equipo de prueba").toBe(201);
  const grifo = await page.request.post("/api/erp/combustible/grifos", {
    data: { nombre: `CISTERNA ${marca}` },
  });
  expect(grifo.status()).toBe(201);
  return {
    grifoInternoId,
    tanqueId: (await tanque.json()).id as number,
    equipoId: (await equipo.json()).id as number,
    proveedorId: (await grifo.json()).id as number,
    placa,
  };
}

/** La cisterna de ESTA corrida: el tenant e2e sobrevive entre corridas y
 *  puede tener otras con saldo. */
async function miCisterna(page: Page, marca: string): Promise<Cisterna | undefined> {
  const r = await page.request.get("/api/erp/combustible/despachos/cisternas-con-saldo");
  return ((await r.json()) as Cisterna[]).find((c) => c.tanque_codigo === `CI-${marca}`);
}

/** Deja la cisterna vacía para no ensuciar el aviso de las demás specs. */
async function vaciar(page: Page, marca: string, equipoId: number, serie: string, vale: number) {
  const c = await miCisterna(page, marca);
  if (!c) return;
  const r = await page.request.post("/api/erp/combustible/despachos", {
    data: {
      origen: "excedente_recepcion",
      excedente_linea_id: Number(c.id),
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: vale,
      cantidad: Number(c.saldo),
      lectura_horometro: 900,
      costo_unitario: 1,
    },
  });
  expect(r.status(), "no se pudo vaciar la cisterna de prueba").toBe(201);
}

const irATanques = (page: Page) => page.getByRole("button", { name: "Tanques", exact: true });
const irACisternas = (page: Page) => page.getByRole("button", { name: "Cisternas", exact: true });

/** La tarjeta de la cisterna de ESTA corrida en la pestaña "Cisternas". */
const tarjetaDe = (page: Page, recepcionId: string) =>
  page.locator("article").filter({ hasText: `Recepción #${recepcionId} ` });

/** "300 / 500 gal": lo que queda sobre lo que quedó al recibir. */
const queda = (saldo: number, inicial: number) => new RegExp(`${saldo}\\s*/\\s*${inicial} gal`);

test("Dejar en cisterna: el reparto no pide unidad y el saldo se reparte a una unidad y a una tanqueta", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { grifoInternoId, tanqueId, equipoId, placa } = await preparar(page, marca);
  const tanqueta = await page.request.post("/api/erp/combustible/tanquetas", {
    data: { grifo_interno_id: grifoInternoId, codigo: `TQ-${marca}` },
  });
  expect(tanqueta.status(), "no se pudo crear la tanqueta de prueba").toBe(201);
  const serie = `C${marca}`;

  try {
    // ── La recepción: tanque lleno, llegan 500 y todo se queda en la cisterna ──
    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await page.getByRole("button", { name: "Registrar recepción" }).first().click();
    await page.locator("#recepcion-tanque").selectOption(String(tanqueId));
    await page.locator("#recepcion-grifo").selectOption({ label: `CISTERNA ${marca}` });
    await page.locator("#recepcion-cantidad").fill("500");
    await page.locator("#recepcion-costo").fill("17.5");
    await page.locator("form").getByRole("button", { name: "Registrar recepción" }).click();

    await expect(page.getByText("La recepción no cabe en el tanque")).toBeVisible();
    const quitar = page.getByRole("button", { name: "Quitar línea" });
    while ((await quitar.count()) > 0) await quitar.last().click();
    await page.locator("#exc-destino-0").selectOption({ label: "Dejar en cisterna" });
    await page.locator("#exc-cantidad-0").fill("500");
    // Sin unidad ni tanqueta: el saldo se reparte después.
    await expect(page.locator("#exc-equipo-0")).toHaveCount(0);
    await expect(page.locator("#exc-tanqueta-0")).toHaveCount(0);
    await expect(page.getByText(/se queda en ella como saldo/)).toBeVisible();
    await expect(page.getByText("El reparto cubre todo el excedente.")).toBeVisible();
    const confirmar = page.getByRole("button", { name: "Registrar con este reparto" });
    await expect(confirmar).toBeEnabled();
    await confirmar.click();
    await expect(page.getByText(/Recepción registrada/)).toBeVisible();

    const cisterna = await miCisterna(page, marca);
    expect(cisterna, "la cisterna no quedó con saldo").toBeDefined();
    expect(Number(cisterna!.saldo)).toBe(500);
    const ficha = await (await page.request.get(`/api/erp/combustible/${tanqueId}`)).json();
    expect(Number(ficha.nivel_teorico), "al tanque no entró nada").toBe(2000);

    // ── El aviso corto en Tanques lleva a la pestaña "Cisternas" ───────────
    await irATanques(page).click();
    const aviso = page.getByText(/con saldo por repartir/).locator("..");
    await expect(aviso).toBeVisible();
    await aviso.getByRole("button", { name: "Ver" }).click();
    const fila = () => tarjetaDe(page, cisterna!.recepcion_id);
    await expect(fila()).toContainText(queda(500, 500));
    await fila().getByRole("button", { name: "Repartir" }).click();

    // A una unidad: con vale y medidor, y no deja pasarse del saldo.
    const registrar = page.getByRole("button", { name: "Registrar salida" });
    await page.locator("#cis-unidad").selectOption({ label: placa });
    await page.locator("#cis-serie").fill(serie);
    await page.locator("#cis-vale").fill("1");
    await page.locator("#cis-medidor").fill("100");
    await page.locator("#cis-cantidad").fill("600");
    await expect(page.getByText(/solo quedan 500/)).toBeVisible();
    await expect(registrar).toBeDisabled();
    await page.locator("#cis-cantidad").fill("200");
    await expect(page.getByText(/Quedarán 300 gal/)).toBeVisible();
    await expect(registrar).toBeEnabled();
    await registrar.click();
    await expect(
      page.getByText(`Salida registrada: 200 gal de la cisterna a ${placa}.`)
    ).toBeVisible();
    await expect(fila()).toContainText(queda(300, 500));
    // La salida aparece en la tarjeta, con la placa de la unidad.
    await expect(fila()).toContainText(placa);

    // A una tanqueta sin unidad: sin vale, y el saldo baja otra vez.
    await fila().getByRole("button", { name: "Repartir" }).click();
    await page.locator("#cis-destino").selectOption("tanqueta");
    const valorTanqueta = await page
      .locator("#cis-tanqueta option", { hasText: `TQ-${marca}` })
      .getAttribute("value");
    await page.locator("#cis-tanqueta").selectOption(valorTanqueta!);
    await page.locator("#cis-cantidad").fill("100");
    await expect(registrar).toBeEnabled();
    await registrar.click();
    await expect(page.getByText(/Salida registrada: 100 gal de la cisterna a TQ-/)).toBeVisible();
    await expect(fila()).toContainText(queda(200, 500));
    expect(Number((await miCisterna(page, marca))!.saldo)).toBe(200);
  } finally {
    await vaciar(page, marca, equipoId, serie, 2);
  }
});

test("Dejar en cisterna: una salida sin señal queda guardada en el equipo y llega sola", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { tanqueId, equipoId, proveedorId, placa } = await preparar(page, marca);
  const serie = `O${marca}`;
  try {
    const rec = await page.request.post("/api/erp/combustible/recepciones", {
      data: {
        combustible_id: tanqueId,
        grifo_id: proveedorId,
        cantidad: 400,
        costo_unitario: 17.5,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [{ destino: "cisterna", cantidad: 400 }],
      },
    });
    expect(rec.status(), "no se pudo registrar la recepción de prueba").toBe(201);
    const cisterna = (await miCisterna(page, marca))!;

    await page.reload();
    // Recargada, la página vuelve al Dashboard con el submenú cerrado.
    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await irACisternas(page).click();
    const fila = tarjetaDe(page, cisterna.recepcion_id);
    await expect(fila).toContainText(queda(400, 400));

    // Otra persona reparte 50: la tarjeta baja sola, sin recargar la página.
    const otra = await page.request.post("/api/erp/combustible/despachos", {
      data: {
        origen: "excedente_recepcion",
        excedente_linea_id: Number(cisterna.id),
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipoId,
        serie_talonario: serie,
        n_vale: 1,
        cantidad: 50,
        lectura_horometro: 50,
        costo_unitario: 1,
      },
    });
    expect(otra.status(), "no se pudo registrar la salida de otra persona").toBe(201);
    await expect(fila).toContainText(queda(350, 400), { timeout: 15_000 });

    // Sin señal: se abre el reparto, se registra y queda en la cola del equipo.
    await page.context().setOffline(true);
    await fila.getByRole("button", { name: "Repartir" }).click();
    await page.locator("#cis-unidad").selectOption({ label: placa });
    await page.locator("#cis-serie").fill(serie);
    await page.locator("#cis-vale").fill("2");
    await page.locator("#cis-medidor").fill("100");
    await page.locator("#cis-cantidad").fill("150");
    await page.getByRole("button", { name: "Registrar salida" }).click();
    await expect(page.getByText(/Sin conexión: la salida de 150 gal/)).toBeVisible();
    await expect(page.getByText(/guardada en este equipo/)).toBeVisible();

    // Vuelve la señal: la cola envía sola la salida y el saldo baja.
    await page.context().setOffline(false);
    await expect
      .poll(async () => Number((await miCisterna(page, marca))?.saldo ?? 0), { timeout: 30_000 })
      .toBe(200);
  } finally {
    await page.context().setOffline(false);
    await vaciar(page, marca, equipoId, serie, 3);
  }
});

test("Dejar en cisterna: se pasa al tanque, sube su nivel y no excede su espacio libre", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { grifoInternoId, tanqueId, equipoId, proveedorId } = await preparar(page, marca);
  const serie = `T${marca}`;
  try {
    // Otro tanque de la misma sede, producto y unidad, con espacio y con varilla.
    const destino = await page.request.post("/api/erp/combustible", {
      data: {
        codigo: `CD-${marca}`,
        tanque_nombre: `Tanque destino ${marca}`,
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 1000,
        nivel_actual: 700,
        requiere_documento: false,
        grifo_interno_id: grifoInternoId,
      },
    });
    expect(destino.status(), "no se pudo crear el tanque destino").toBe(201);
    const destinoId = (await destino.json()).id as number;
    const rec = await page.request.post("/api/erp/combustible/recepciones", {
      data: {
        combustible_id: tanqueId,
        grifo_id: proveedorId,
        cantidad: 500,
        costo_unitario: 17.5,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [{ destino: "cisterna", cantidad: 500 }],
      },
    });
    expect(rec.status(), "no se pudo registrar la recepción de prueba").toBe(201);
    const cisterna = (await miCisterna(page, marca))!;

    await page.reload();
    await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await irACisternas(page).click();
    const fila = tarjetaDe(page, cisterna.recepcion_id);
    await fila.getByRole("button", { name: "Repartir" }).click();

    await page.locator("#cis-destino").selectOption("tanque");
    const valor = await page
      .locator("#cis-tanque option", { hasText: `CD-${marca}` })
      .getAttribute("value");
    await page.locator("#cis-tanque").selectOption(valor!);
    // Sin vale ni medidor: es una entrada del tanque.
    await expect(page.locator("#cis-vale")).toHaveCount(0);
    await expect(page.locator("#cis-medidor")).toHaveCount(0);

    // El tanque tiene 300 gal de espacio: 400 no entran, aunque la cisterna los tenga.
    const pasar = page.getByRole("button", { name: "Pasar al tanque" });
    await page.locator("#cis-cantidad").fill("400");
    await expect(page.getByText(/solo tiene espacio para 300/)).toBeVisible();
    await expect(pasar).toBeDisabled();
    await page.locator("#cis-cantidad").fill("250");
    await expect(pasar).toBeEnabled();
    await pasar.click();
    await expect(
      page.getByText(`Pase registrado: 250 gal de la cisterna a CD-${marca}.`)
    ).toBeVisible();
    await expect(fila).toContainText(queda(250, 500));

    const ficha = await (await page.request.get(`/api/erp/combustible/${destinoId}`)).json();
    expect(Number(ficha.nivel_teorico), "el nivel del tanque subió").toBe(950);
    expect(Number((await miCisterna(page, marca))!.saldo)).toBe(250);
  } finally {
    await vaciar(page, marca, equipoId, serie, 1);
  }
});

test("Cisternas: el perfil Lectura ve la pestaña y la cisterna, pero sin el botón Repartir", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const { tanqueId, equipoId, proveedorId } = await preparar(page, marca);
  const serie = `L${marca}`;

  const email = `lectura-cisterna-${marca.toLowerCase()}@mincoreerp.test`;
  const temporal = `Temporal!${marca}2026`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre: `Lectura ${marca}`, email, password: temporal, rol: "lectura" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  const usuarioId = (await alta.json()).id as string;
  const actuales = await (await page.request.get(`/api/erp/usuarios/${usuarioId}/permisos`)).json();
  const habilitar = await page.request.put(`/api/erp/usuarios/${usuarioId}/permisos`, {
    data: {
      modulos: actuales.modulos.map((m: { modulo: string; asignado: boolean; nivel: string }) => ({
        modulo: m.modulo,
        asignado: m.modulo === "combustible" ? true : m.asignado,
        nivel: m.nivel,
      })),
      motivo: "spec e2e: Lectura con Combustible",
    },
  });
  expect(habilitar.status(), await habilitar.text()).toBe(200);

  const contexto = await browser.newContext();
  const lectura = await contexto.newPage();
  try {
    const rec = await page.request.post("/api/erp/combustible/recepciones", {
      data: {
        combustible_id: tanqueId,
        grifo_id: proveedorId,
        cantidad: 300,
        costo_unitario: 17.5,
        recibido_en: new Date().toISOString(),
        reparto_excedente: [{ destino: "cisterna", cantidad: 300 }],
      },
    });
    expect(rec.status(), "no se pudo registrar la recepción de prueba").toBe(201);
    const cisterna = (await miCisterna(page, marca))!;

    await lectura.goto("/");
    await lectura.getByLabel("Correo").fill(email);
    await lectura.getByLabel("Contraseña").fill(temporal);
    await lectura.getByRole("button", { name: "Ingresar" }).click();
    await lectura.locator("#passwordActual").fill(temporal);
    await lectura.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await lectura.locator("#confirmacion").fill(`${temporal}Nueva`);
    await lectura.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(lectura.getByRole("button", { name: "Dashboard" })).toBeVisible();

    await lectura.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await irACisternas(lectura).click();
    const tarjeta = tarjetaDe(lectura, cisterna.recepcion_id);
    await expect(tarjeta).toContainText(queda(300, 300));
    await expect(tarjeta).toContainText(`CISTERNA ${marca}`);
    await expect(tarjeta.getByRole("button", { name: "Repartir" })).toHaveCount(0);
    // Tampoco el aviso de Tanques (que es de quien reparte).
    await irATanques(lectura).click();
    await expect(lectura.getByText(/con saldo por repartir/)).toHaveCount(0);
  } finally {
    await contexto.close();
    await vaciar(page, marca, equipoId, serie, 1);
    await page.request.patch(`/api/erp/usuarios/${usuarioId}/estado`, {
      data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
    });
  }
});
