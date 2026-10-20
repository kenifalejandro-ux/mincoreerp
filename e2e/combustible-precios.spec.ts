/** e2e/combustible-precios.spec.ts
 *
 * La pantalla Precios unificada (combustible + urea en una tabla). Los tests de
 * servidor ya cubren el endpoint masivo; lo que solo se ve en un navegador es
 * la cadena completa de la pantalla: que un tanque o proveedor SIN precio se
 * avise, que un cambio masivo llegue a todos los marcados, que un salto grande
 * no se pueda cargar sin confirmar, que un precio programado no pase por
 * vigente, y que anular pida motivo.
 *
 * El tenant e2e es compartido y los specs corren en paralelo: todo lo que se
 * crea acá lleva una marca única y las aserciones miran solo esas filas.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

const unico = () => randomBytes(3).toString("hex").toUpperCase();

async function abrirPrecios(page: Page) {
  const mostrar = page.getByRole("button", { name: "Mostrar menú" });
  if (await mostrar.isVisible()) await mostrar.click();
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Precios", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Precios", exact: true })).toBeVisible();
}

/** Un tanque de diésel y dos proveedores de ruta, creados por API. */
async function sembrar(page: Page, marca: string) {
  const grifoInternoId = await primerGrifoActivo(page);
  const tanque = await page.request.post("/api/erp/combustible", {
    data: {
      codigo: `PR-${marca}`,
      tanque_nombre: `Tanque precios ${marca}`,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 5000,
      nivel_actual: 1000,
      requiere_documento: false,
      grifo_interno_id: grifoInternoId,
    },
  });
  expect(tanque.status(), "no se pudo crear el tanque de prueba").toBe(201);
  const proveedores: string[] = [];
  for (const sufijo of ["A", "B"]) {
    const nombre = `PRIMAX ${marca}-${sufijo}`;
    const r = await page.request.post("/api/erp/combustible/grifos", { data: { nombre } });
    expect(r.status(), "no se pudo crear el proveedor de prueba").toBe(201);
    proveedores.push(nombre);
  }
  return { tanqueNombre: `Tanque precios ${marca}`, proveedores };
}

/** La fila de la tabla de una tanque o proveedor, por su nombre. */
const fila = (page: Page, nombre: string) =>
  page.locator("tbody tr").filter({ hasText: nombre }).first();

test.describe("Precios unificados", () => {
  test("sin precio se avisa, el cambio masivo llega a todos, el programado no rige y anular pide motivo", async ({
    page,
  }) => {
    const marca = `E2E${unico()}`;
    const admin = adminA();
    await loginPorUI(page, admin.email, admin.password);
    const { tanqueNombre, proveedores } = await sembrar(page, marca);
    await abrirPrecios(page);

    // ── 1. Lo recién creado aparece SIN precio, y la barra ámbar lo cuenta ──
    for (const destino of [tanqueNombre, ...proveedores]) {
      await expect(fila(page, destino)).toContainText("Sin precio");
    }
    await expect(page.getByText(/\d+ sin precio\./)).toBeVisible();

    // ── 2. Cambio masivo: el mismo precio al tanque y a un proveedor ────────
    await fila(page, tanqueNombre).getByRole("button", { name: "Cargar precio" }).click();
    const dialogo = page.getByRole("dialog", { name: "Precio" });
    // Abierto desde una fila, solo esa viene marcada.
    await expect(dialogo.getByLabel(tanqueNombre)).toBeChecked();
    await dialogo.locator("#precio-valor").fill("24.8");
    await dialogo.getByRole("button", { name: "Cargar precio" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Precio cargado" })).toBeVisible();
    await expect(fila(page, tanqueNombre)).toContainText("S/ 24.80");

    // Compra a proveedor de ruta: se marcan los dos proveedores de esta prueba.
    await page.getByRole("button", { name: "Nuevo precio" }).click();
    await dialogo.locator("#precio-tipo").selectOption("externa");
    await dialogo.getByLabel("Todos", { exact: true }).uncheck();
    for (const nombre of proveedores) await dialogo.getByLabel(nombre).check();
    await dialogo.locator("#precio-valor").fill("25.6");
    await dialogo.getByRole("button", { name: "Cargar precio" }).click();
    for (const nombre of proveedores) {
      await expect(fila(page, nombre)).toContainText("S/ 25.60");
    }

    // ── 3. Un salto grande no se carga sin confirmar ────────────────────────
    await fila(page, tanqueNombre).getByRole("button", { name: "Cambiar precio" }).click();
    await dialogo.locator("#precio-valor").fill("248");
    const cargar = dialogo.getByRole("button", { name: "Cargar precio" });
    await expect(dialogo.getByText(/\+900\.0 %/)).toBeVisible();
    await expect(cargar).toBeDisabled();
    await dialogo.getByLabel("Confirmo que el precio nuevo es correcto").check();
    await expect(cargar).toBeEnabled();
    // Cambiar el precio después de confirmar vuelve a pedir la confirmación.
    await dialogo.locator("#precio-valor").fill("2480");
    await expect(cargar).toBeDisabled();
    // Un cambio normal no pide confirmación.
    await dialogo.locator("#precio-valor").fill("26.5");
    await expect(dialogo.getByLabel("Confirmo que el precio nuevo es correcto")).toHaveCount(0);
    await expect(cargar).toBeEnabled();

    // ── 4. Un precio con fecha futura queda PROGRAMADO y no cambia el vigente ─
    const manana = new Date(Date.now() + 24 * 3600_000);
    const p = (n: number) => String(n).padStart(2, "0");
    await dialogo
      .locator("#precio-desde")
      .fill(
        `${manana.getFullYear()}-${p(manana.getMonth() + 1)}-${p(manana.getDate())}T${p(manana.getHours())}:${p(manana.getMinutes())}`
      );
    await expect(dialogo.getByText(/Quedará como programado/)).toBeVisible();
    await cargar.click();
    await expect(fila(page, tanqueNombre)).toContainText("Programado: S/ 26.50");
    await expect(fila(page, tanqueNombre)).toContainText("S/ 24.80");

    // ── 5. Anular exige motivo y vuelve a regir el anterior ─────────────────
    await fila(page, proveedores[0]).getByRole("button", { name: "Cambiar precio" }).click();
    await dialogo.locator("#precio-valor").fill("27");
    await dialogo.getByRole("button", { name: "Cargar precio" }).click();
    await expect(fila(page, proveedores[0])).toContainText("S/ 27.00");
    await fila(page, proveedores[0]).getByRole("button", { name: "Historial" }).click();
    await page.getByRole("button", { name: "Anular", exact: true }).first().click();
    const anular = page.getByRole("dialog", { name: "Anular precio" });
    const confirmar = anular.getByRole("button", { name: "Anular precio" });
    await expect(confirmar).toBeDisabled();
    await anular.locator("#precio-motivo").fill("se digitó mal");
    await expect(confirmar).toBeEnabled();
    await confirmar.click();
    await expect(page.getByRole("status").filter({ hasText: "Precio anulado" })).toBeVisible();
    await expect(fila(page, proveedores[0])).toContainText("S/ 25.60");
    await expect(page.getByText("Motivo: se digitó mal")).toBeVisible();

    // Al servidor le llegó lo mismo que se ve (el segundo proveedor no se tocó).
    const lista = await (await page.request.get("/api/erp/combustible/precios")).json();
    const deMarca = (lista as { grifo_nombre: string | null; anulada_en: string | null }[]).filter(
      (x) => x.grifo_nombre?.includes(marca)
    );
    expect(deMarca.filter((x) => x.anulada_en !== null)).toHaveLength(1);
  });

  test("Lectura con Precios habilitado ve la lista pero ningún botón de escritura", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const marca = `E2E${unico()}`;
    const admin = adminA();
    await loginPorUI(page, admin.email, admin.password);
    const { tanqueNombre } = await sembrar(page, marca);

    // Un usuario de Lectura con el módulo Combustible y la pestaña Precios.
    const email = `lectura-${marca.toLowerCase()}@mincoreerp.test`;
    const temporal = `Temporal!${marca}2026`;
    const alta = await page.request.post("/api/erp/usuarios", {
      data: { nombre: `Lectura ${marca}`, email, password: temporal, rol: "lectura" },
    });
    expect(alta.status(), await alta.text()).toBe(201);
    const usuarioId = (await alta.json()).id as string;
    const actuales = await (
      await page.request.get(`/api/erp/usuarios/${usuarioId}/permisos`)
    ).json();
    const habilitar = await page.request.put(`/api/erp/usuarios/${usuarioId}/permisos`, {
      data: {
        modulos: actuales.modulos.map(
          (m: { modulo: string; asignado: boolean; nivel: string }) => ({
            modulo: m.modulo,
            asignado: m.modulo === "combustible" ? true : m.asignado,
            nivel: m.nivel,
          })
        ),
        pestanas: [{ modulo: "combustible", pestana: "tanques:precios", permitido: true }],
        motivo: "spec e2e: Lectura con Precios habilitado",
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
      // Un usuario nuevo nace con clave temporal: la cambia antes de entrar.
      await lectura.locator("#passwordActual").fill(temporal);
      await lectura.locator("#passwordNueva").fill(`${temporal}Nueva`);
      await lectura.locator("#confirmacion").fill(`${temporal}Nueva`);
      await lectura.getByRole("button", { name: "Guardar y continuar" }).click();
      await expect(lectura.getByRole("button", { name: "Dashboard" })).toBeVisible();

      await abrirPrecios(lectura);
      // Ve la lista (consulta)...
      await expect(fila(lectura, tanqueNombre)).toBeVisible();
      // ...pero ningún botón que escriba, ni en la cabecera ni en las filas.
      for (const nombre of ["Nuevo precio", "Cargar precio", "Cambiar precio", "Anular"]) {
        await expect(lectura.getByRole("button", { name: nombre })).toHaveCount(0);
      }
    } finally {
      await contexto.close();
    }
  });
});
