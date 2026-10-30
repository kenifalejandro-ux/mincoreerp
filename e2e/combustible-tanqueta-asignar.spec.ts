/** e2e/combustible-tanqueta-asignar.spec.ts
 *
 * La pestaña Tanquetas asigna una tanqueta con saldo a la unidad que la lleva
 * (0139) y la recibe de vuelta (0143), con motivo si el saldo que volvió no coincide, y
 * mandando el saldo al tanque (0145). El preparativo va por API: el tanque, la tanqueta y el
 * vale que la llena.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("tanqueta: se asigna a una unidad desde la pestaña y se recibe de vuelta", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `HMC-${marca}`,
      tanque_nombre: `Huamachuco ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 8000,
      requiere_documento: false,
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status()).toBe(201);
  const tqt = await page.request.post("/api/erp/combustible/tanquetas", {
    data: { grifo_interno_id: grifoInternoId, codigo: `TQ-${marca}` },
  });
  expect(tqt.status()).toBe(201);
  const { id: tanquetaId, codigo } = await tqt.json();
  const placa = `VQ-${marca}`;
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: placa,
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(equipo.status()).toBe(201);
  const vale = await page.request.post("/api/erp/combustible/despachos", {
    data: {
      origen: "tanque_propio",
      combustible_id: (await tanque.json()).id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: Number(tanquetaId),
      serie_talonario: `A${marca}`,
      n_vale: 1,
      cantidad: 200,
      lectura_contometro: 200,
      costo_unitario: 16,
    },
  });
  expect(vale.status()).toBe(201);

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Tanquetas" }).click();

  await page.getByRole("button", { name: `Asignar ${codigo} a una unidad` }).click();
  await page.locator("#asignar-unidad").selectOption({ label: placa });
  // Al elegir la unidad se pide el vale de la salida (0141): sin él no se asigna.
  await expect(page.locator("#asignar-serie")).toBeVisible();
  await expect(page.getByRole("button", { name: "Asignar", exact: true })).toBeDisabled();
  await page.locator("#asignar-serie").fill(`S${marca}`);
  await page.locator("#asignar-vale").fill("1");
  await page.getByRole("button", { name: "Asignar", exact: true }).click();
  await expect(page.getByText(`Va con la unidad ${placa}`)).toBeVisible();

  // Si lo que volvió no coincide con el saldo calculado, el motivo es obligatorio.
  await page.getByRole("button", { name: `Recibir ${codigo} de vuelta` }).click();
  await page.locator("#retorno-volvio").fill("190");
  await expect(page.getByRole("button", { name: "Registrar retorno" })).toBeDisabled();
  await page.locator("#retorno-motivo").fill("Se derramó al bajarla");
  // Nada viene elegido: sin decir a dónde va el saldo no se puede registrar.
  const registrar = page.getByRole("button", { name: "Registrar retorno" });
  await expect(registrar).toBeDisabled();
  // Vuelve al tanque (pozo): pide el tanque de la sede y recién entonces se puede registrar.
  await page.getByLabel("Volver al tanque (pozo)").check();
  await expect(registrar).toBeDisabled();
  const opcionTanque = page.locator("#retorno-tanque option", { hasText: `HMC-${marca}` });
  await page.locator("#retorno-tanque").selectOption((await opcionTanque.getAttribute("value"))!);
  await expect(registrar).toBeEnabled();
  await registrar.click();
  await expect(page.getByText(`Va con la unidad ${placa}`)).toHaveCount(0);
});

test("tanqueta: al recibirla de vuelta, el saldo pasa a otra unidad con su vale", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `HMD-${marca}`,
      tanque_nombre: `Huamachuco ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 8000,
      requiere_documento: false,
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status()).toBe(201);
  const tqt = await page.request.post("/api/erp/combustible/tanquetas", {
    data: { grifo_interno_id: grifoInternoId, codigo: `TU-${marca}` },
  });
  expect(tqt.status()).toBe(201);
  const { id: tanquetaId, codigo } = await tqt.json();
  const unidad = async (placa: string) => {
    const r = await page.request.post("/api/erp/equipos", {
      data: {
        placa_codigo: placa,
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: grifoInternoId,
      },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).id as number;
  };
  const placaA = `UA-${marca}`;
  const placaB = `UB-${marca}`;
  const unidadA = await unidad(placaA);
  await unidad(placaB);
  const vale = await page.request.post("/api/erp/combustible/despachos", {
    data: {
      origen: "tanque_propio",
      combustible_id: (await tanque.json()).id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: Number(tanquetaId),
      serie_talonario: `B${marca}`,
      n_vale: 1,
      cantidad: 120,
      lectura_contometro: 120,
      costo_unitario: 16,
    },
  });
  expect(vale.status()).toBe(201);
  const asignada = await page.request.put(`/api/erp/combustible/tanquetas/${tanquetaId}/asignar`, {
    data: { equipo_id: unidadA, serie_talonario: `C${marca}`, n_vale: 1 },
  });
  expect(asignada.status()).toBe(200);

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Tanquetas" }).click();
  await expect(page.getByText(`Va con la unidad ${placaA}`)).toBeVisible();

  await page.getByRole("button", { name: `Recibir ${codigo} de vuelta` }).click();
  const registrar = page.getByRole("button", { name: "Registrar retorno" });
  await page.getByLabel("Pasa a otra unidad").check();
  // La unidad de la que volvió no se ofrece; solo las otras.
  await expect(page.locator("#retorno-unidad option", { hasText: placaA })).toHaveCount(0);
  const opcionB = page.locator("#retorno-unidad option", { hasText: placaB });
  await page.locator("#retorno-unidad").selectOption((await opcionB.getAttribute("value"))!);
  // Con la unidad elegida se pide el vale de esa salida: sin él no se registra.
  await expect(registrar).toBeDisabled();
  await page.locator("#retorno-serie").fill(`D${marca}`);
  await page.locator("#retorno-vale").fill("1");
  await expect(registrar).toBeEnabled();
  await registrar.click();
  await expect(page.getByText(`Va con la unidad ${placaB}`)).toBeVisible();
  await expect(page.getByText(`Va con la unidad ${placaA}`)).toHaveCount(0);
});

test("tanqueta: llenarla sin unidad no pide vale (con unidad sí) y funciona sin señal", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `HME-${marca}`,
      tanque_nombre: `Huamachuco ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 8000,
      requiere_documento: false,
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status()).toBe(201);
  const tanqueId = (await tanque.json()).id as number;
  const tanquetas: string[] = [];
  for (const prefijo of ["TA", "TB", "TC"]) {
    const r = await page.request.post("/api/erp/combustible/tanquetas", {
      data: { grifo_interno_id: grifoInternoId, codigo: `${prefijo}-${marca}` },
    });
    expect(r.status()).toBe(201);
    tanquetas.push((await r.json()).codigo as string);
  }
  const placa = `VE-${marca}`;
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: placa,
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(equipo.status()).toBe(201);

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();

  const abrirYLlenar = async (codigoTanqueta: string) => {
    await page.getByRole("button", { name: "Registrar despacho" }).first().click();
    await page.locator("#despacho-tanque").selectOption(String(tanqueId));
    await page.locator("#despacho-cantidad").fill("100");
    await page.locator("#despacho-contometro").fill("100");
    await page.locator("#despacho-tipo-destino").selectOption("reserva_cubeta");
    const opcion = page.locator("#despacho-tanqueta-destino option", { hasText: codigoTanqueta });
    await page
      .locator("#despacho-tanqueta-destino")
      .selectOption((await opcion.getAttribute("value"))!);
    await page.locator("#despacho-costo-unitario").fill("16");
  };
  const saldoDe = async (codigoTanqueta: string) => {
    const r = await page.request.get("/api/erp/combustible/tanquetas");
    const fila = ((await r.json()) as { codigo: string; saldo: string }[]).find(
      (t) => t.codigo === codigoTanqueta
    );
    return Number(fila?.saldo);
  };

  // ── Sin unidad: ni serie ni número de vale ─────────────────────────────
  await abrirYLlenar(tanquetas[0]);
  await expect(page.locator("#despacho-tanqueta-equipo")).toHaveValue("");
  await expect(page.locator("#despacho-serie")).toHaveCount(0);
  await expect(page.locator("#despacho-n-vale")).toHaveCount(0);
  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(page.getByText(/Despacho registrado: el traspaso a la tanqueta/)).toBeVisible();
  expect(await saldoDe(tanquetas[0])).toBe(100);

  // ── Con unidad: el vale vuelve a pedirse y es obligatorio ──────────────
  await abrirYLlenar(tanquetas[1]);
  await page.locator("#despacho-tanqueta-equipo").selectOption({ label: `${placa} — VOLQUETE` });
  await expect(page.locator("#despacho-serie")).toBeVisible();
  await expect(page.locator("#despacho-n-vale")).toBeVisible();
  // Si cambia de idea y la deja sin asignar, vuelven a esconderse.
  await page.locator("#despacho-tanqueta-equipo").selectOption("");
  await expect(page.locator("#despacho-serie")).toHaveCount(0);
  await page.locator("#despacho-tanqueta-equipo").selectOption({ label: `${placa} — VOLQUETE` });
  await page.locator("#despacho-serie").fill(`E${marca}`);
  await page.locator("#despacho-n-vale").fill("1");
  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(page.getByText(/Despacho registrado: el vale 1 de la serie/)).toBeVisible();
  expect(await saldoDe(tanquetas[1])).toBe(100);

  // ── Sin señal: queda en el celular y, al volver la red, se envía UNA vez ─
  await abrirYLlenar(tanquetas[2]);
  await page.context().setOffline(true);
  await page.locator("form").getByRole("button", { name: "Registrar despacho" }).click();
  await expect(
    page.getByText(/Sin conexión: el traspaso a la tanqueta quedó guardado/)
  ).toBeVisible();
  await page.context().setOffline(false);
  await expect
    .poll(async () => saldoDe(tanquetas[2]), {
      message: "la cola tiene que enviar el traspaso, una sola vez",
      timeout: 60_000,
    })
    .toBe(100);
});

test("tanqueta: el historial muestra el cuadre de cada salida (cerrada y abierta)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `HMF-${marca}`,
      tanque_nombre: `Huamachuco ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 8000,
      requiere_documento: false,
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status()).toBe(201);
  const tanqueId = (await tanque.json()).id as number;
  const unidad = async (prefijo: string) => {
    const placa = `${prefijo}-${marca}`;
    const r = await page.request.post("/api/erp/equipos", {
      data: {
        placa_codigo: placa,
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: grifoInternoId,
      },
    });
    expect(r.status()).toBe(201);
    return { id: (await r.json()).id as number, placa };
  };
  const nuevaTanqueta = async (prefijo: string) => {
    const r = await page.request.post("/api/erp/combustible/tanquetas", {
      data: { grifo_interno_id: grifoInternoId, codigo: `${prefijo}-${marca}` },
    });
    expect(r.status()).toBe(201);
    return { id: Number((await r.json()).id), codigo: `${prefijo}-${marca}` };
  };
  const llenar = async (tanquetaId: number) => {
    const r = await page.request.post("/api/erp/combustible/despachos", {
      data: {
        origen: "tanque_propio",
        combustible_id: tanqueId,
        tipo_combustible: "diesel_b5",
        tipo_destino: "reserva_cubeta",
        tanqueta_destino_id: tanquetaId,
        cantidad: 100,
        lectura_contometro: 100,
        costo_unitario: 16,
        cliente_uuid: crypto.randomUUID(),
      },
    });
    expect(r.status()).toBe(201);
  };
  const asignar = async (tanquetaId: number, equipoId: number, serie: string) => {
    const r = await page.request.put(`/api/erp/combustible/tanquetas/${tanquetaId}/asignar`, {
      data: { equipo_id: equipoId, serie_talonario: serie, n_vale: 1 },
    });
    expect(r.status()).toBe(200);
  };
  const cargar = async (
    tanquetaId: number,
    equipoId: number,
    cantidad: number,
    medidor: number
  ) => {
    const r = await page.request.post("/api/erp/combustible/despachos", {
      data: {
        origen: "tanqueta",
        tanqueta_origen_id: tanquetaId,
        tanqueta_lugar: "ruta",
        tipo_destino: "equipo",
        equipo_id: equipoId,
        tipo_combustible: "diesel_b5",
        cantidad,
        lectura_horometro: medidor,
      },
    });
    expect(r.status()).toBe(201);
  };

  // Una tanqueta cerrada: salió con 100, cargó 70, volvió con 28 de 30.
  const cerrada = await nuevaTanqueta("CC");
  const u1 = await unidad("UC");
  await llenar(cerrada.id);
  await asignar(cerrada.id, u1.id, `C${marca}`);
  await cargar(cerrada.id, u1.id, 70, 1500);
  const retorno = await page.request.post(`/api/erp/combustible/tanquetas/${cerrada.id}/retorno`, {
    data: {
      saldo_calculado: 30,
      saldo_validado: 28,
      motivo: "se derramó al bajarla",
      destino: "reserva",
    },
  });
  expect(retorno.status()).toBe(201);
  // Una abierta: sigue con la unidad, cargó 40 de 100.
  const abierta = await nuevaTanqueta("CA");
  const u2 = await unidad("UA");
  await llenar(abierta.id);
  await asignar(abierta.id, u2.id, `A${marca}`);
  await cargar(abierta.id, u2.id, 40, 1600);
  // Y una sin salidas.
  const vacia = await nuevaTanqueta("CV");

  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Tanquetas" }).click();

  await page.getByRole("button", { name: `Historial de ${cerrada.codigo}` }).click();
  await expect(page.getByText("Cuadre de cada salida")).toBeVisible();
  await expect(
    page.getByText(
      `Vale C${marca}-1 · unidad ${u1.placa} — salió con 100 gal · cargó 70 gal (1 carga) · debía volver con 30 gal · volvió con 28 gal · diferencia −2 gal (motivo: "se derramó al bajarla")`
    )
  ).toBeVisible();
  // El vale de la asignación también está en el historial (PR anterior).
  await expect(
    page.getByText(new RegExp(`Asignada a ${u1.placa} · vale C${marca}-1`))
  ).toBeVisible();
  await page.getByRole("button", { name: "Cerrar", exact: true }).last().click();

  await page.getByRole("button", { name: `Historial de ${abierta.codigo}` }).click();
  await expect(
    page.getByText(
      `Vale A${marca}-1 · unidad ${u2.placa} — salió con 100 gal · cargó 40 gal (1 carga) · va con la unidad · lleva 60 gal`
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "Cerrar", exact: true }).last().click();

  await page.getByRole("button", { name: `Historial de ${vacia.codigo}` }).click();
  await expect(page.getByText("Sin movimientos todavía.")).toBeVisible();
  await expect(page.getByText("Cuadre de cada salida")).toHaveCount(0);
});
