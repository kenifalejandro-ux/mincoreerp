/** e2e/combustible-lugares.spec.ts
 *
 * La ventana de Lugares de Viajes (0159): agregar con tipo y ubicación, editar, buscar,
 * desactivar y reactivar; un lugar desactivado no se ofrece al programar un viaje; el perfil
 * Lectura no ve el botón de Lugares. Los nombres llevan una marca única: los specs corren en
 * paralelo sobre el mismo tenant.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

async function abrirViajes(page: Page) {
  const mostrar = page.getByRole("button", { name: "Mostrar menú" });
  if (await mostrar.isVisible()) await mostrar.click();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Viajes" }).click();
}

// Solo la tabla de la ventana de Lugares: detrás hay la de Viajes, con cientos de filas.
const tabla = (page: Page) =>
  page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Lugar", exact: true }) });

const fila = (page: Page, nombre: string) =>
  tabla(page)
    .getByRole("row")
    .filter({ has: page.getByText(nombre, { exact: true }) });

test("agregar, editar, buscar, desactivar y reactivar un lugar", async ({ page }) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const mina = `Mina ${marca}`;
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  await abrirViajes(page);
  await page.getByRole("button", { name: "Lugares", exact: true }).click();
  await expect(page.getByText("Lugares registrados")).toBeVisible();

  // El tipo es obligatorio al agregar.
  await page.getByRole("button", { name: "Agregar lugar" }).click();
  const dialogo = page.getByRole("dialog", { name: "Agregar lugar" });
  await dialogo.getByLabel("Nombre", { exact: true }).fill(mina);
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("Elige qué tipo");

  await dialogo.getByLabel("Tipo", { exact: true }).selectOption({ label: "Mina" });
  await dialogo.getByLabel(/^Ubicación/).fill("Hualgayoc, Cajamarca");
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(dialogo).toHaveCount(0);
  // La celda de la columna Tipo (el nombre ya contiene "Mina": mirar la fila entera no probaría nada).
  await expect(fila(page, mina).getByRole("cell").nth(1)).toHaveText("Mina");
  await expect(fila(page, mina)).toContainText("Hualgayoc, Cajamarca");
  await expect(fila(page, mina)).toContainText("Activo");

  // Un nombre repetido (aunque cambien las mayúsculas) no se guarda y avisa en el formulario.
  await page.getByRole("button", { name: "Agregar lugar" }).click();
  await dialogo.getByLabel("Nombre", { exact: true }).fill(mina.toUpperCase());
  await dialogo.getByLabel("Tipo", { exact: true }).selectOption({ label: "Ciudad" });
  await dialogo.getByRole("button", { name: "Guardar" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("ya existe");
  await dialogo.getByRole("button", { name: "Cerrar" }).click();
  await expect(dialogo).toHaveCount(0);

  // Editar: cambia el tipo y borra la ubicación.
  await page.getByRole("button", { name: `Editar ${mina}` }).click();
  const edicion = page.getByRole("dialog", { name: "Editar lugar" });
  await expect(edicion.getByLabel("Nombre", { exact: true })).toHaveValue(mina);
  // Un lugar que ya tiene tipo no puede volver a "sin tipo".
  await expect(
    edicion.getByLabel("Tipo", { exact: true }).locator("option", { hasText: "Sin tipo" })
  ).toHaveCount(0);
  await edicion.getByLabel("Tipo", { exact: true }).selectOption({ label: "Abastecimiento" });
  await edicion.getByLabel(/^Ubicación/).fill("");
  await edicion.getByRole("button", { name: "Guardar" }).click();
  await expect(edicion).toHaveCount(0);
  await expect(fila(page, mina)).toContainText("Abastecimiento");
  await expect(fila(page, mina)).not.toContainText("Hualgayoc");

  // Buscar por la marca deja solo este lugar; algo que no existe, el aviso.
  const buscador = page.getByLabel("Buscar lugar");
  await buscador.fill(marca);
  await expect(tabla(page).getByRole("row")).toHaveCount(2); // encabezado + el lugar
  await buscador.fill(`zzz-${marca}`);
  await expect(page.getByText("Ningún lugar coincide con la búsqueda.")).toBeVisible();
  await buscador.fill("");

  // Desactivar: pasa a Inactivo y baja al final de la lista; reactivar lo devuelve.
  await page.getByRole("button", { name: `Desactivar ${mina}` }).click();
  await expect(fila(page, mina)).toContainText("Inactivo");
  await expect(page.getByText(/· \d+ inactivos?/)).toBeVisible();
  const filas = tabla(page).getByRole("row");
  await expect(filas.last()).toContainText(mina);
  await page.getByRole("button", { name: `Activar ${mina}` }).click();
  await expect(fila(page, mina)).toContainText("Activo");

  // Quedó guardado en el servidor, no solo en pantalla.
  const lista = await page.request.get("/api/erp/combustible/lugares");
  const guardado = (
    (await lista.json()).data as { nombre: string; tipo: string; activo: boolean }[]
  ).find((l) => l.nombre === mina);
  expect(guardado).toMatchObject({ tipo: "abastecimiento", activo: true });
});

test("un lugar desactivado no se ofrece al programar un viaje", async ({ page }) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoId = await primerGrifoActivo(page);

  const crear = async (nombre: string) => {
    const r = await page.request.post("/api/erp/combustible/lugares", {
      data: { nombre, tipo: "ciudad" },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).id as string;
  };
  const vigente = `Vigente ${marca}`;
  const baja = `Baja ${marca}`;
  await crear(vigente);
  const bajaId = await crear(baja);
  const desactivar = await page.request.patch(`/api/erp/combustible/lugares/${bajaId}`, {
    data: { activo: false },
  });
  expect(desactivar.status()).toBe(200);

  const conductor = `Conductor ${marca}`;
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: `VQ-${marca}`,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: conductor,
      conductor_dni: `4${Math.floor(1e6 + Math.random() * 9e6)}`,
      grifo_interno_id: grifoId,
    },
  });
  expect(equipo.status()).toBe(201);

  await abrirViajes(page);
  await page.getByRole("button", { name: "Nuevo viaje" }).click();
  await page.getByRole("button", { name: "Conductor", exact: true }).click();
  await page.locator('li[role="option"]').filter({ hasText: conductor }).click();

  const sale = page.getByLabel("Sale de", { exact: true });
  await expect(sale.locator("option", { hasText: vigente })).toHaveCount(1);
  await expect(sale.locator("option", { hasText: baja })).toHaveCount(0);
});

test("un viaje cuyo lugar se desactivó se puede corregir sin cambiarlo", async ({ page }) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoId = await primerGrifoActivo(page);

  const crear = async (nombre: string) => {
    const r = await page.request.post("/api/erp/combustible/lugares", {
      data: { nombre, tipo: "mina" },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).id as string;
  };
  const origen = await crear(`Origen ${marca}`);
  const destinoNombre = `Destino ${marca}`;
  const destino = await crear(destinoNombre);
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: `VQ-${marca}`,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: `Conductor ${marca}`,
      conductor_dni: `4${Math.floor(1e6 + Math.random() * 9e6)}`,
      grifo_interno_id: grifoId,
    },
  });
  expect(equipo.status()).toBe(201);
  const hace = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const viaje = await page.request.post("/api/erp/combustible/viajes", {
    data: {
      equipo_id: (await equipo.json()).id,
      origen_id: Number(origen),
      destino_id: Number(destino),
      inicio_en: hace(10),
      fin_en: hace(9),
    },
  });
  expect(viaje.status(), await viaje.text()).toBe(201);
  const numero = (await viaje.json()).numero as number;

  // Después de la salida, alguien desactiva el destino.
  const baja = await page.request.patch(`/api/erp/combustible/lugares/${destino}`, {
    data: { activo: false },
  });
  expect(baja.status()).toBe(200);

  await abrirViajes(page);
  await page.getByRole("button", { name: `Corregir viaje V-${numero}` }).click();
  // El desplegable sigue mostrando el lugar del viaje (marcado), y el formulario se puede enviar.
  const destinoSelect = page.getByLabel("Destino", { exact: true });
  await expect(destinoSelect.locator("option:checked")).toHaveText(`${destinoNombre} (inactivo)`);
  await page.getByLabel("Motivo de la corrección").fill("corrección de prueba automatizada");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Corregir viaje V-${numero}` })).toHaveCount(0);
});

test("el perfil Lectura no ve el botón de Lugares", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toLowerCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);

  const email = `lectura-lugares-${marca}@mincoreerp.test`;
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
      pestanas: [{ modulo: "combustible", pestana: "viajes", permitido: true }],
      motivo: "spec e2e: Lectura con Viajes habilitado",
    },
  });
  expect(habilitar.status(), await habilitar.text()).toBe(200);

  const contexto = await browser.newContext();
  const lectura = await contexto.newPage();
  try {
    await lectura.goto("/");
    await lectura.getByLabel("Correo").fill(email);
    await lectura.getByLabel("Contraseña").fill(temporal);
    await lectura.getByRole("button", { name: "Ingresar" }).click();
    await lectura.locator("#passwordActual").fill(temporal);
    await lectura.locator("#passwordNueva").fill(`${temporal}Nueva`);
    await lectura.locator("#confirmacion").fill(`${temporal}Nueva`);
    await lectura.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(lectura.getByRole("button", { name: "Dashboard" })).toBeVisible();

    await abrirViajes(lectura);
    await expect(lectura.getByRole("heading", { name: "Viajes" })).toBeVisible();
    for (const nombre of ["Lugares", "Nuevo viaje"]) {
      await expect(lectura.getByRole("button", { name: nombre, exact: true })).toHaveCount(0);
    }
    // Y la API tampoco le deja escribir.
    const escribir = await lectura.request.post("/api/erp/combustible/lugares", {
      data: { nombre: `Intruso ${marca}`, tipo: "mina" },
    });
    expect(escribir.status()).toBe(403);
  } finally {
    await contexto.close();
    // El usuario de prueba se da de baja para no consumir cupo.
    await page.request.patch(`/api/erp/usuarios/${usuarioId}/estado`, {
      data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
    });
  }
});
