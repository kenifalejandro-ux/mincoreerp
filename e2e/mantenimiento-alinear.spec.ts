/** e2e/mantenimiento-alinear.spec.ts
 *
 * El ecosistema «Gestión de mantenimiento» alineado con la maqueta aprobada: barra superior, menú con sus grupos y
 * «Pronto», Centro, y la ventana «Importar» con «Desde Operaciones».
 *
 * 1. Con Mantenimiento + Flota (+ Checklists): la barra trae buscador, campana y el perfil; el menú muestra lo que
 *    existe y lo que llega («Pronto», solo de módulos que la persona tiene); las unidades que registró Flota salen
 *    como por completar (insignia, aviso del Centro, franja) y «Desde Operaciones» las completa sin copiarlas.
 * 2. El buscador de la barra encuentra una unidad y lleva a Equipos con el texto puesto.
 * 3. Sin Flota no hay pestaña «Desde Operaciones» ni franja ni insignia.
 *
 * Cada empresa es nueva (no hay API para borrarlas): la base de los e2e es efímera en CI. Se siembra por API
 * ANTES de entrar al ecosistema, y se navega por el menú (recargar tras el cambio de clave la vuelve a pedir).
 */
import { randomBytes } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

type Empresa = Awaited<ReturnType<typeof crearEmpresaSola>>;

const MENU = "Menú de Gestión de mantenimiento";
const menuDe = (page: Page) => page.getByRole("complementary", { name: MENU });

test("la barra, el menú y «Desde Operaciones» siguen la maqueta con Mantenimiento y Flota", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const empresa: Empresa = await crearEmpresaSola(
    request,
    ["mantenimiento", "flota", "checklists"],
    "alinear"
  );
  await entrarPorPrimeraVez(
    page,
    empresa,
    page.getByRole("button", { name: /^Gestión de mantenimiento/ }).first()
  );

  // Dos unidades las registra Flota; una la registra Mantenimiento (ya viene completa).
  const flota = [`BRK-${marca}`, `CAM-${marca}`];
  for (const placa of flota) {
    const r = await page.request.post("/api/erp/equipos", {
      data: { placa_codigo: placa, tipo: "Camioneta", marca: "TOYOTA", modelo: "HILUX" },
    });
    expect(r.status(), await r.text()).toBe(201);
  }
  const area = await page.request.post("/api/erp/mantenimiento/areas", {
    data: { nombre: "Cantera Sur" },
  });
  expect(area.status()).toBe(201);
  const propia = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: { placa_codigo: `MNT-${marca}`, tipo: "Volquete", medidor: "horometro", lectura: 10 },
  });
  expect(propia.status(), await propia.text()).toBe(201);

  await page
    .getByRole("button", { name: /^Gestión de mantenimiento/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Centro de mantenimiento" }).click();
  const menu = menuDe(page);
  await expect(menu).toBeVisible();

  // ── Barra superior ────────────────────────────────────────────────────
  await expect(page.getByPlaceholder("Buscar unidad, OT, checklist...")).toBeVisible();
  await page.getByRole("button", { name: "Alertas" }).click();
  await expect(page.getByText("Sin alertas por ahora")).toBeVisible();
  await page.getByRole("button", { name: "Alertas" }).click();
  await expect(page.getByText("Administrador")).toBeVisible();

  // ── Menú: lo que existe abre; lo que llega sale apagado con «Pronto» ──
  await expect(menu.getByText("Operación", { exact: true })).toBeVisible();
  await expect(menu.getByText("Seguimiento", { exact: true })).toBeVisible();
  for (const pronto of ["Checklists", "Mantenimiento preventivo", "Indicadores", "Historial"]) {
    const entrada = menu.getByRole("button", { name: new RegExp(`^${pronto}.*Pronto`) });
    await expect(entrada, `${pronto} debería salir apagada con «Pronto»`).toBeDisabled();
  }
  await expect(menu.getByRole("button", { name: /^Configuración/ })).toBeEnabled();
  // Órdenes de trabajo, Almacén e IPERC: la persona no tiene esos módulos, no hay entrada.
  await expect(menu.getByRole("button", { name: /Órdenes de trabajo/ })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: /Almacén/ })).toHaveCount(0);
  await expect(menu.getByText("Integración activa")).toBeVisible();

  // ── Centro: saludo, tarjetas, aviso real y lo que llega ───────────────
  await expect(
    page.getByRole("heading", { name: /^(Buenos días|Buenas tardes|Buenas noches)$/, level: 1 })
  ).toBeVisible();
  // Sin Órdenes de trabajo no hay «Nueva OT».
  await expect(page.getByRole("button", { name: "Nueva OT" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Programar MP/ })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Resumen del mantenimiento" })).toContainText(
    "Unidades operativas3 de 3"
  );
  await expect(page.getByText("Requieren tu atención")).toBeVisible();
  await expect(page.getByText("2 unidades de Operaciones por completar")).toBeVisible();
  // Sin Órdenes de trabajo, en el sitio de «Órdenes por tipo» va «Por estado».
  for (const panel of [
    "Estado de la flota",
    "Actividad del turno",
    "Por estado",
    "Estado por área",
  ]) {
    await expect(page.getByRole("heading", { name: panel })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Órdenes por tipo" })).toHaveCount(0);

  // ── Equipos: insignia en el menú y franja azul ────────────────────────
  await expect(menu.getByLabel("2 por completar")).toBeVisible();
  await menu.getByRole("button", { name: /^Equipos/ }).click();
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();
  const franja = page.getByRole("region", { name: "Unidades de Operaciones por completar" });
  await expect(franja).toContainText("2 unidades de Operaciones por completar");

  // ── «Desde Operaciones»: casillas, propiedad y área; no copia, completa ─
  await franja.getByRole("button", { name: /Revisar e importar/ }).click();
  const ventana = page.getByRole("dialog", { name: "Importar equipos" });
  await expect(ventana.getByRole("tab", { name: /Desde Operaciones/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(ventana.getByRole("tab", { name: /Desde Excel/ })).toBeVisible();
  await expect(ventana.getByText(flota[0])).toBeVisible();
  await expect(ventana.getByText(flota[1])).toBeVisible();
  await expect(ventana.getByRole("button", { name: "Importar 2" })).toBeVisible();
  // Se desmarca una: solo se completa la otra.
  await ventana.getByRole("checkbox").nth(1).uncheck();
  await ventana.getByLabel("Propiedad").selectOption("alquilada");
  await ventana.getByLabel("Área").selectOption({ label: "Cantera Sur" });
  await ventana.getByRole("button", { name: "Importar 1" }).click();
  await expect(ventana.getByText("1 equipo importado")).toBeVisible();
  await ventana.getByRole("button", { name: "Continuar" }).click();
  await expect(ventana).toBeHidden();

  // La completada tiene su área y su propiedad; la insignia y la franja bajan a 1.
  const fila = (texto: string) => page.getByRole("row", { name: new RegExp(texto) });
  await expect(fila(flota[0])).toContainText("Cantera Sur");
  await expect(fila(flota[0])).toContainText("Alquilada");
  await expect(menu.getByLabel("1 por completar")).toBeVisible();
  await expect(franja).toContainText("1 unidad de Operaciones por completar");

  // La que quedó pendiente se completa después; con 0 desaparecen la franja y la insignia.
  await franja.getByRole("button", { name: /Revisar e importar/ }).click();
  await ventana.getByRole("button", { name: "Importar 1" }).click();
  await expect(ventana.getByText("1 equipo importado")).toBeVisible();
  await ventana.getByRole("button", { name: "Continuar" }).click();
  await expect(franja).toHaveCount(0);
  await expect(menu.getByLabel(/por completar/)).toHaveCount(0);

  // Y ya no hay nada que importar desde Operaciones.
  await page.getByRole("button", { name: "Importar", exact: true }).click();
  await ventana.getByRole("tab", { name: /Desde Operaciones/ }).click();
  await expect(ventana.getByRole("heading", { name: "Todo al día" })).toBeVisible();
  await ventana.getByRole("button", { name: "Cancelar" }).click();

  // ── El buscador de la barra lleva a Equipos con el texto puesto ───────
  await menu.getByRole("button", { name: /^Centro de mantenimiento/ }).click();
  const buscador = page.getByPlaceholder("Buscar unidad, OT, checklist...");
  await buscador.fill(`CAM-${marca}`);
  await page.getByRole("option", { name: new RegExp(`CAM-${marca}`) }).click();
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();
  await expect(page.getByPlaceholder(/Buscar por placa/)).toHaveValue(`CAM-${marca}`);
  await expect(page.getByRole("row", { name: new RegExp(`BRK-${marca}`) })).toHaveCount(0);
});

test("sin Flota no hay pestaña «Desde Operaciones», ni franja, ni insignia", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "alinear-sin-flota");
  const menu = menuDe(page);
  await entrarPorPrimeraVez(page, empresa, menu);
  await menu.getByRole("button", { name: /^Equipos/ }).click();
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();

  await expect(
    page.getByRole("region", { name: "Unidades de Operaciones por completar" })
  ).toHaveCount(0);
  await expect(menu.getByLabel(/por completar/)).toHaveCount(0);
  // Sin Flota tampoco la tarjeta de integración.
  await expect(menu.getByText("Integración activa")).toHaveCount(0);

  await page.getByRole("button", { name: "Importar", exact: true }).click();
  const ventana = page.getByRole("dialog", { name: "Importar equipos" });
  await expect(ventana.getByRole("tab", { name: /Desde Excel/ })).toBeVisible();
  await expect(ventana.getByRole("tab", { name: /Desde Operaciones/ })).toHaveCount(0);
  await expect(ventana.getByText("Arrastra tu archivo Excel aquí")).toBeVisible();
});
