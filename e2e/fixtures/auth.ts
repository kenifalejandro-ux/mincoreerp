/** e2e/fixtures/auth.ts
 *
 * Login por UI, extraído de login.spec.ts (que lo prueba de punta a punta)
 * y aislamiento-tenants.spec.ts (que solo lo necesita como paso previo
 * para conseguir una cookie de sesión real del navegador) -- antes de esto
 * la misma secuencia de 5 líneas vivía duplicada en los dos archivos.
 *
 * Sin ruteo por URL (SPA de una sola pantalla que cambia de tab por
 * estado) -- la señal real de que el login funcionó es que el shell
 * autenticado (sidebar con el tab "Dashboard") reemplazó al formulario.
 *
 * PENDIENTE (revisión de código, hallazgo 6.1.1/6.1.2): esta fixture y el
 * gate de e2e-tests ya corren y bloquean el CD (vía workflow_run de
 * ci.yml), pero el job todavía no está marcado como Required en el
 * ruleset de branch protection de GitHub -- eso es configuración del
 * repo en GitHub, no código, así que sigue como el próximo paso manual
 * (mismo paso que ya se hizo con Lint).
 */
import { type Page, expect } from "@playwright/test";

export async function loginPorUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  // El primer pintado del panel inicial puede tardar más de los 5 s por defecto cuando la
  // máquina está cargada (varios specs seguidos): el login ya funcionó, solo falta esperar.
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
}
