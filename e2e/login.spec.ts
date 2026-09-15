/** e2e/login.spec.ts
 *
 * Golden path de login: sin mocks, contra el sistema completo (Express +
 * build real de React + Postgres). El tenant y usuario de prueba los siembra
 * el workflow (o quien corra esto en local) con `npm run tenant:create`
 * antes de levantar el server — ver E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD.
 *
 * No hay campo "Empresa" y tampoco hace falta ninguno: desde la migración
 * 0087 quien entra con correo tiene una cuenta, y con perfil en una sola
 * empresa la sesión se emite directo. Es el flujo de la enorme mayoría de
 * usuarios. (VITE_DEFAULT_TENANT_SLUG sigue apuntando al tenant sembrado,
 * pero ya solo lo usa el login por DNI, que sí necesita empresa -- ver
 * acceso-por-dni.spec.ts.)
 */
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";

const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;

if (!email || !password) {
  throw new Error(
    "Faltan E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD -- hay que sembrar el tenant/usuario de prueba antes de correr este spec (ver README o el job e2e-tests de ci.yml)"
  );
}

test("un usuario válido inicia sesión y llega al dashboard", async ({ page }) => {
  await loginPorUI(page, email, password);
  await expect(page.getByLabel("Correo")).not.toBeVisible();
});
