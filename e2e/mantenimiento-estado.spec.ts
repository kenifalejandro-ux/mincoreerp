/** e2e/mantenimiento-estado.spec.ts
 *
 * El estado de cada unidad en Mantenimiento → Equipos (M5):
 *
 * 1. Con Checklists y Órdenes de trabajo: la falla crítica detiene la unidad y se ve qué pasa; la detenida sale
 *    primero y los filtros la separan; al cerrar la orden queda operativa; una falla menor la deja esperando.
 * 2. Con solo Mantenimiento todas salen operativas, sin errores.
 *
 * Cada test crea su propia empresa (no hay API para borrarlas: la base de los e2e es efímera en CI).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

const menu = (page: Page) =>
  page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
const irA = (page: Page, seccion: string) =>
  menu(page)
    .getByRole("button", { name: new RegExp(`^${seccion}`) })
    .click();
/** La lista se lee al abrir la sección: se sale y se vuelve (recargar pediría otra vez la clave). */
async function releerEquipos(page: Page) {
  await irA(page, "Centro de mantenimiento");
  await irA(page, "Equipos");
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();
}
const fila = (page: Page, placa: string) => page.getByRole("row", { name: new RegExp(placa) });
const filtro = (page: Page, nombre: RegExp) =>
  page.getByRole("group", { name: "Estado de las unidades" }).getByRole("button", { name: nombre });

async function registrar(page: Page, placa: string) {
  const r = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: { placa_codigo: placa, tipo: "Volquete" },
  });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id as number;
}

test("las órdenes y los checklists mandan en el estado, con su motivo y sus filtros", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const [sana, detenida] = [`AAA-${marca}`, `ZZZ-${marca}`];
  const empresa = await crearEmpresaSola(
    request,
    ["mantenimiento", "checklists", "ordenes_trabajo"],
    "estado"
  );
  const entrada = page.getByRole("button", { name: /^Gestión de mantenimiento/ }).first();
  await entrarPorPrimeraVez(page, empresa, entrada);
  await registrar(page, sana);
  const equipoId = await registrar(page, detenida);
  const plantilla = await page.request.post("/api/erp/checklists/plantillas", {
    data: {
      nombre: "Pre-uso",
      items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
    },
  });
  expect(plantilla.status()).toBe(201);
  const plantillaId = (await plantilla.json()).id as number;
  const llenar = async (mala: string) => {
    const r = await page.request.post("/api/erp/checklists", {
      data: {
        plantilla_id: plantillaId,
        equipo_id: equipoId,
        items: ["Frenos", "Luces"].map((descripcion) => ({
          descripcion,
          estado: descripcion === mala ? "malo" : "bien",
        })),
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()) as { orden_trabajo_id: number };
  };
  const { orden_trabajo_id: orden } = await llenar("Frenos");

  await entrada.click();
  if (!(await menu(page).isVisible())) {
    await page
      .getByRole("button", { name: /Centro de mantenimiento/ })
      .first()
      .click();
  }
  await irA(page, "Equipos");

  // ── Detenida, primero y con lo que pasa ───────────────────────────────
  await expect(page.locator("tbody tr").first()).toContainText(detenida);
  await expect(fila(page, detenida)).toContainText("Detenida");
  await expect(fila(page, detenida)).toContainText(`OT #${orden}`);
  await expect(fila(page, sana)).toContainText("Operativa");
  await filtro(page, /^Detenidas \(1\)/).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await filtro(page, /^Operativas \(1\)/).click();
  await expect(page.locator("tbody tr")).toContainText([sana]);
  await filtro(page, /^Todas \(2\)/).click();

  // ── Se cierra la orden: operativa ─────────────────────────────────────
  const cierre = await page.request.patch(`/api/erp/ordenes_trabajo/${orden}/estado`, {
    data: { estado: "cancelada" },
  });
  expect(cierre.status()).toBe(200);
  await releerEquipos(page);
  await expect(fila(page, detenida)).toContainText("Operativa");

  // ── Falla menor: espera autorización ──────────────────────────────────
  await llenar("Luces");
  await releerEquipos(page);
  await expect(fila(page, detenida)).toContainText("Detenida");
  await expect(fila(page, detenida)).toContainText("Espera autorización: Luces");
});

test("con solo Mantenimiento todas salen operativas", async ({ page, request }) => {
  test.setTimeout(180_000);
  const placa = `SOL-${randomBytes(2).toString("hex").toUpperCase()}`;
  const empresa = await crearEmpresaSola(request, "mantenimiento", "estado-solo");
  await entrarPorPrimeraVez(page, empresa, menu(page));
  await registrar(page, placa);
  await irA(page, "Equipos");
  await expect(fila(page, placa)).toContainText("Operativa");
  await expect(filtro(page, /^Detenidas \(0\)/)).toBeVisible();
  await filtro(page, /^Detenidas/).click();
  await expect(page.getByText("Sin resultados")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
