/** e2e/mantenimiento-importar.spec.ts
 *
 * Importar equipos desde un Excel, y el Centro de control del ecosistema «Gestión de mantenimiento» (M1,
 * etapa 3), por navegador, con una empresa que tiene SOLO el módulo `mantenimiento`.
 *
 * 1. Con cero equipos el Centro invita a registrarlos; el Excel se lee, muestra la vista previa y al confirmar
 *    los equipos entran con su área (y las áreas nuevas se crean y se avisan).
 * 2. El Centro refleja lo importado: totales y reparto por área.
 * 3. Un archivo con una placa ya registrada se rechaza ENTERO, diciendo la fila y la columna, y no entra nada.
 * 4. Un archivo sin los encabezados pide las columnas, y uno con una lectura que no es número dice en qué fila.
 *
 * El Excel se arma aquí mismo con la librería del cliente (la misma que lo lee en el navegador).
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

import { test, expect, type Page } from "@playwright/test";

import { crearEmpresaSola, entrarPorPrimeraVez } from "./fixtures/empresaSola";

// xlsx solo está instalado en client/ (es una carpeta, no un archivo: no se puede importar como módulo ES).
const XLSX = createRequire(import.meta.url)(
  "../client/node_modules/xlsx"
) as typeof import("../client/node_modules/xlsx");

const ENCABEZADO = ["Placa", "Tipo", "Marca", "Modelo", "Medidor", "Lectura", "Propiedad", "Área"];

function archivoExcel(filas: unknown[][], nombre = "equipos.xlsx") {
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), "Equipos");
  const buffer = XLSX.write(libro, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return {
    name: nombre,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  };
}

async function alCentro(page: Page, empresa: Awaited<ReturnType<typeof crearEmpresaSola>>) {
  const menu = page.getByRole("complementary", { name: "Menú de Gestión de mantenimiento" });
  await entrarPorPrimeraVez(page, empresa, menu);
  await expect(page.getByRole("heading", { name: "Centro de control", level: 1 })).toBeVisible();
  return menu;
}

test("importar un Excel crea los equipos y el Centro los cuenta por área", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const empresa = await crearEmpresaSola(request, "mantenimiento", "importar");
  const menu = await alCentro(page, empresa);

  // Sin equipos, el Centro invita a registrarlos.
  await expect(page.getByRole("heading", { name: "Todavía no hay equipos" })).toBeVisible();
  await page.getByRole("button", { name: "Ir a Equipos" }).click();
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();

  // Se elige el archivo: aparece la vista previa y todavía no se guardó nada.
  const archivo = archivoExcel([
    ENCABEZADO,
    [`AKM-${marca}`, "Volquete", "VOLVO", "FH", "Horómetro", 4890.5, "Propia", "Cantera"],
    [`REX-${marca}`, "Retroexcavadora", "SANY", "", "horas", 1740, "Propia", "Cantera"],
    [`CEB-${marca}`, "Camioneta", "TOYOTA", "", "Odómetro", 48300, "Alquilada", "Taller"],
    [`HRN-${marca}`, "Horno", "", "", "", 0, "Propia", ""],
  ]);
  await page.locator('input[type="file"]').setInputFiles(archivo);
  const vista = page.getByRole("heading", { name: "Confirmar importación" });
  await expect(vista).toBeVisible();
  await expect(page.getByText("Se van a importar")).toContainText("4");
  await expect(page.getByText("Nada se guardó todavía")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(`AKM-${marca}`) })).toHaveCount(1);
  // La vista previa es lo único que hay: la lista de atrás sigue vacía.
  await page.getByRole("button", { name: "Rechazar" }).click();
  await expect(vista).toBeHidden();
  await expect(page.getByText("Todavía no hay equipos registrados.")).toBeVisible();

  // Esta vez se confirma.
  await page.locator('input[type="file"]').setInputFiles(archivo);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Se importaron 4 equipos correctamente.")).toBeVisible();
  await expect(page.getByText("Se crearon las áreas Cantera, Taller")).toBeVisible();
  const fila = (placa: string) => page.getByRole("row", { name: new RegExp(`${placa}-${marca}`) });
  await expect(fila("AKM")).toContainText("Cantera");
  await expect(fila("AKM")).toContainText("4,890.5 h");
  await expect(fila("CEB")).toContainText("48,300 km");
  await expect(fila("CEB")).toContainText("Alquilada");
  await expect(fila("HRN")).toContainText("Sin área");

  // El Centro refleja lo importado.
  await menu.getByRole("button", { name: "Centro de control" }).click();
  const resumen = page.getByRole("region", { name: "Resumen de equipos" });
  await expect(resumen).toContainText("Equipos4");
  await expect(resumen).toContainText("Propios3");
  await expect(resumen).toContainText("Alquilados1");
  await expect(resumen).toContainText("Sin área1");
  const reparto = page
    .getByRole("heading", { name: "Equipos por área" })
    .locator("xpath=ancestor::section[1]");
  await expect(reparto.getByRole("listitem").first()).toContainText("Cantera");
  await expect(reparto.getByRole("listitem").first()).toContainText("2");
});

test("un archivo con una placa repetida se rechaza entero, con su fila y su columna", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const marca = randomBytes(2).toString("hex").toUpperCase();
  const empresa = await crearEmpresaSola(request, "mantenimiento", "rechazo");
  const menu = await alCentro(page, empresa);
  // El equipo se crea antes de abrir Equipos (recargar justo después del cambio de clave obligatorio vuelve a
  // pedir la clave): así la lista ya lo trae.
  const creado = await page.request.post("/api/erp/mantenimiento/equipos", {
    data: { placa_codigo: `YA-${marca}`, tipo: "Volquete" },
  });
  expect(creado.status(), await creado.text()).toBe(201);
  await menu.getByRole("button", { name: "Equipos" }).click();
  await expect(page.getByRole("row", { name: new RegExp(`YA-${marca}`) })).toBeVisible({
    timeout: 20_000,
  });

  // La segunda fila usa una placa que la empresa ya tiene (con otras mayúsculas).
  await page
    .locator('input[type="file"]')
    .setInputFiles(
      archivoExcel([
        ENCABEZADO,
        [`NUEVO-${marca}`, "Volquete"],
        [`ya-${marca}`.toLowerCase(), "Camioneta"],
      ])
    );
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText(/Fila 3 \(columna "placa_codigo"\)/)).toBeVisible();
  await expect(page.getByText(/ya está registrado/)).toBeVisible();
  // La primera fila estaba bien, pero no entró.
  await expect(page.getByRole("row", { name: new RegExp(`NUEVO-${marca}`) })).toHaveCount(0);
});

test("un archivo sin encabezados o con una lectura inválida dice qué corregir", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const empresa = await crearEmpresaSola(request, "mantenimiento", "planilla");
  const menu = await alCentro(page, empresa);
  await menu.getByRole("button", { name: "Equipos" }).click();
  await expect(page.getByRole("heading", { name: "Equipos", level: 1 })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(
    archivoExcel([
      ["Nombre", "Edad"],
      ["x", 1],
    ])
  );
  await expect(page.getByText(/Placa y Tipo son obligatorias/)).toBeVisible();

  await page
    .locator('input[type="file"]')
    .setInputFiles(
      archivoExcel([ENCABEZADO, ["A-1", "Volquete"], ["A-2", "Volquete", "", "", "", "abc"]])
    );
  await expect(page.getByText("Fila 3: la lectura «abc» no es un número.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Confirmar importación" })).toHaveCount(0);
});
