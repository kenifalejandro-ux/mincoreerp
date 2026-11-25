/** e2e/fixtures/empresaSola.ts
 *
 * Una empresa de prueba con UN solo módulo habilitado, para comprobar en el navegador que ese módulo funciona
 * solo (regla de autonomía de módulos). No hay API para borrar empresas: la de cada test queda en la base de
 * los e2e, que es efímera en CI.
 */
import { randomBytes } from "node:crypto";

import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { leerEnv } from "./entorno";

export interface EmpresaSola {
  email: string;
  password: string;
  tenantId: string;
}

/** Crea la empresa por la API de plataforma y deja habilitado solo `modulo` (o solo esos módulos, si se
 *  pasa una lista: para probar una combinación, por ejemplo Mantenimiento y Checklists sin Flota). */
export async function crearEmpresaSola(
  request: APIRequestContext,
  modulo: string | string[],
  etiqueta: string
): Promise<EmpresaSola> {
  const habilitados = ([] as string[]).concat(modulo);
  const marca = randomBytes(3).toString("hex").toLowerCase();
  const BEARER = { Authorization: `Bearer ${leerEnv("PLATFORM_ADMIN_TOKEN")}` };
  const password = `Solo!${marca}2026`;
  const email = `${etiqueta}-${marca}@mincoreerp.test`;
  const creada = await request.post("/api/platform/tenants", {
    headers: BEARER,
    data: {
      tenantNombre: `Solo ${habilitados.join("+")} ${etiqueta} ${marca}`,
      tenantSlug: `solo-${etiqueta}-${marca}`,
      adminNombre: `Admin ${etiqueta}`,
      adminEmail: email,
      adminPassword: password,
    },
  });
  expect(creada.ok(), await creada.text()).toBeTruthy();
  const tenantId = (await creada.json()).tenant.id as string;
  const actuales = await request.get(`/api/platform/tenants/${tenantId}/modulos`, {
    headers: BEARER,
  });
  const modulos = (await actuales.json()).modulos as { modulo: string }[];
  const apagar = await request.put(`/api/platform/tenants/${tenantId}/modulos`, {
    headers: BEARER,
    data: {
      configuraciones: modulos.map((m) => ({
        modulo: m.modulo,
        estado: habilitados.includes(m.modulo) ? "habilitado" : "deshabilitado",
      })),
    },
  });
  expect(apagar.ok(), await apagar.text()).toBeTruthy();
  return { email, password, tenantId };
}

/** Entra con la clave temporal de la cuenta nueva (cambio obligatorio la primera vez) y espera a que
 *  aparezca `listo` (algo que solo se ve ya dentro). */
export async function entrarPorPrimeraVez(
  page: Page,
  empresa: EmpresaSola,
  listo: ReturnType<Page["locator"]>
): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Correo").fill(empresa.email);
  await page.getByLabel("Contraseña").fill(empresa.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  const cambio = page.locator("#passwordActual");
  await cambio.or(listo).first().waitFor({ timeout: 20_000 });
  if (await cambio.isVisible()) {
    await cambio.fill(empresa.password);
    await page.locator("#passwordNueva").fill(`${empresa.password}Nueva`);
    await page.locator("#confirmacion").fill(`${empresa.password}Nueva`);
    await page.getByRole("button", { name: "Guardar y continuar" }).click();
  }
  await expect(listo).toBeVisible({ timeout: 20_000 });
}
