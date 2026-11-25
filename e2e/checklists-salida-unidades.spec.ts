/** e2e/checklists-salida-unidades.spec.ts
 *
 * La salida de unidades, en el navegador:
 *
 * 1. El administrador da la casilla; la pregunta crítica hay que responderla; una falla menor queda «Por
 *    autorizar», quien la llenó no puede decidirla y otra persona la niega con motivo: no sale y hay orden.
 * 2. Sin señal: el checklist con falla menor entra y queda por autorizar; decidir pide señal.
 * 3. Sin la casilla no se ofrece decidir.
 *
 * Cada test crea su propia empresa (no hay API para borrarlas: la base de los e2e es efímera en CI).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { botonRegistrar } from "./fixtures/checklists";
import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

const PLANTILLA = "Pre-uso camioneta";
const AUTORIZAR = { modulo: "checklists", pestana: "salida:autorizar", permitido: true };

/** Acepta todos los avisos del navegador y los va guardando. */
function escucharAvisos(page: Page): string[] {
  const avisos: string[] = [];
  page.on("dialog", (d) => {
    avisos.push(d.message());
    void d.accept();
  });
  return avisos;
}

async function sembrarPlantilla(page: Page) {
  const r = await page.request.post("/api/erp/checklists/plantillas", {
    data: {
      nombre: PLANTILLA,
      items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
    },
  });
  expect(r.status(), await r.text()).toBe(201);
}

/** Un operador que entra con DNI. Devuelve con qué entra y su id. */
async function crearOperador(page: Page, nombre: string) {
  const dni = `93${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const password = `Operador-${randomBytes(2).toString("hex")}-9x`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre, dni, password, rol: "operador" },
  });
  expect(alta.status(), await alta.text()).toBe(201);
  const lista = await (await page.request.get("/api/erp/usuarios")).json();
  const usuarios = (Array.isArray(lista) ? lista : (lista.data ?? lista.usuarios)) as {
    id: string;
    nombre: string;
  }[];
  return { dni, password, id: usuarios.find((u) => u.nombre === nombre)!.id };
}

/** Sale y entra como ese operador (la primera vez le piden cambiar la clave) hasta ver Checklists. */
async function entrarComo(page: Page, quien: { dni: string; password: string }) {
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: quien.dni, password: quien.password },
  });
  expect(login.status(), await login.text()).toBe(200);
  await page.goto("/");
  const nueva = `Nueva-${randomBytes(2).toString("hex")}-7y`;
  await page.getByLabel("Contraseña temporal").fill(quien.password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
  await page.getByLabel("Confirmar nueva contraseña").fill(nueva);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();
  await expect(page.getByRole("button", { name: "Nuevo Checklist" })).toBeVisible({
    timeout: 20_000,
  });
}

/** La vista cargó sus listas al entrar, antes de sembrar: se sale y se vuelve para que las pida de nuevo. */
async function volverAChecklists(page: Page) {
  await page.getByRole("button", { name: "Órdenes de Trabajo" }).first().click();
  await page.getByRole("button", { name: "Checklists" }).first().click();
}

async function abrirFormulario(page: Page) {
  await page.getByRole("button", { name: "Nuevo Checklist" }).click();
  await page.getByLabel("Plantilla").selectOption({ label: PLANTILLA });
  await page.getByLabel(/^Activo o lugar/).fill("Camioneta 3");
  await expect(page.getByLabel("Respuesta: Frenos")).toHaveValue("");
}

const listado = async (page: Page, modulo: "checklists" | "ordenes_trabajo") =>
  (await (await page.request.get(`/api/erp/${modulo}?pageSize=50`)).json()).data as Record<
    string,
    unknown
  >[];

const filtro = (page: Page) => page.getByRole("button", { name: /^Por autorizar/ });

test("la falla menor la decide otra persona con la casilla, con motivo", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, ["checklists", "ordenes_trabajo"], "salida");
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: "Checklists" }).first()
  );
  await sembrarPlantilla(page);
  const supervisor = await crearOperador(page, "Supervisor SSOMA");
  const avisos = escucharAvisos(page);

  // ── La casilla se marca en Administración ─────────────────────────────
  await page.getByRole("button", { name: "Administración" }).click();
  await page.getByRole("button", { name: "Configuración" }).click();
  await page.getByRole("button", { name: /Supervisor SSOMA/ }).click();
  const casillas = page.getByRole("region", { name: "Salida de unidades" });
  await expect(casillas.getByLabel("Puede omitir preguntas críticas")).not.toBeChecked();
  await casillas.getByLabel("Autoriza la salida de unidades").check();
  const guardado = page.waitForResponse(
    (r) => r.url().includes("/permisos") && r.request().method() === "PUT"
  );
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  expect((await guardado).status()).toBe(200);

  // ── Sin responder la crítica no se registra ───────────────────────────
  await page.getByRole("button", { name: "Checklists" }).first().click();
  await abrirFormulario(page);
  await botonRegistrar(page).click();
  await expect.poll(() => avisos.at(-1)).toContain("Falta responder: Frenos");
  expect(await listado(page, "checklists")).toHaveLength(0);

  await page.getByLabel("Respuesta: Frenos").selectOption("bien");
  await page.getByLabel("Respuesta: Luces").selectOption("malo");
  await botonRegistrar(page).click();
  await expect.poll(() => avisos.at(-1)).toContain("autoricen");
  // Quien lo llenó no decide.
  await expect(page.getByText("Lo llenaste tú: lo decide otra persona.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Decidir salida" })).toHaveCount(0);

  // ── El supervisor la niega ────────────────────────────────────────────
  await entrarComo(page, supervisor);
  await filtro(page).click();
  await page.getByRole("button", { name: "Decidir salida" }).click();
  const d = page.getByRole("dialog", { name: /Decidir la salida/ });
  await expect(d.getByText("Luces")).toBeVisible();
  await d.getByRole("button", { name: "No autorizar" }).click();
  await expect(d.getByRole("alert")).toContainText("motivo");
  await d.getByLabel("Motivo").fill("Sale de noche");
  await d.getByRole("button", { name: "No autorizar" }).click();
  await expect(page.getByText("No hay salidas esperando autorización.")).toBeVisible();

  await filtro(page).click();
  await expect(page.getByText("No autorizada: no sale")).toBeVisible();
  await expect(page.getByText("Supervisor SSOMA: Sale de noche")).toBeVisible();
  const [orden] = await listado(page, "ordenes_trabajo");
  expect(orden).toMatchObject({ prioridad: "alta", unidad_no_opera: true });
  await expect(page.getByText(`Orden de trabajo #${orden.id}`)).toBeVisible();
});

test("sin señal: el checklist queda por autorizar al enviarse, y decidir pide señal", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, ["checklists", "ordenes_trabajo"], "salida-off");
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: "Checklists" }).first()
  );
  await sembrarPlantilla(page);
  const supervisor = await crearOperador(page, "Supervisor de turno");
  const permiso = await page.request.put(`/api/erp/usuarios/${supervisor.id}/permisos`, {
    data: {
      modulos: [{ modulo: "checklists", asignado: true, nivel: "operar" }],
      pestanas: [AUTORIZAR],
    },
  });
  expect(permiso.status(), await permiso.text()).toBe(200);
  await volverAChecklists(page);
  const avisos = escucharAvisos(page);

  await abrirFormulario(page);
  await context.setOffline(true);
  await page.getByLabel("Respuesta: Frenos").selectOption("bien");
  await page.getByLabel("Respuesta: Luces").selectOption("malo");
  await botonRegistrar(page).click();
  await expect.poll(() => avisos.at(-1)).toContain("espera autorización");
  await context.setOffline(false);
  await expect(page.getByRole("cell", { name: /Por autorizar/ })).toBeVisible({ timeout: 45_000 });
  expect(await listado(page, "checklists")).toHaveLength(1);
  expect(await listado(page, "ordenes_trabajo")).toHaveLength(0);

  await entrarComo(page, supervisor);
  await page.getByRole("button", { name: "Decidir salida" }).click();
  const d = page.getByRole("dialog", { name: /Decidir la salida/ });
  await d.getByLabel("Motivo").fill("Viaja de día");
  await context.setOffline(true);
  await d.getByRole("button", { name: "Autorizar salida" }).click();
  await expect(d.getByRole("alert")).toContainText("necesita señal");
  await context.setOffline(false);
  await d.getByRole("button", { name: "Autorizar salida" }).click();
  await expect(page.getByText("Salida autorizada")).toBeVisible();
});

test("sin la casilla no se ofrece decidir", async ({ page, request }) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, ["checklists", "ordenes_trabajo"], "salida-no");
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: "Checklists" }).first()
  );
  await sembrarPlantilla(page);
  const operador = await crearOperador(page, "Operador sin casilla");
  const lista = await (await page.request.get("/api/erp/checklists/plantillas")).json();
  const creado = await page.request.post("/api/erp/checklists", {
    data: {
      plantilla_id: lista.data[0].id,
      activo_texto: "Camioneta 3",
      items: [
        { descripcion: "Frenos", estado: "bien" },
        { descripcion: "Luces", estado: "malo" },
      ],
    },
  });
  expect(creado.status(), await creado.text()).toBe(201);

  await entrarComo(page, operador);
  await expect(page.getByRole("cell", { name: /Por autorizar/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decidir salida" })).toHaveCount(0);
  const directo = await page.request.patch(
    `/api/erp/checklists/${(await creado.json()).id}/salida`,
    {
      data: { autoriza: true, motivo: "Intento" },
    }
  );
  expect(directo.status()).toBe(403);
});
