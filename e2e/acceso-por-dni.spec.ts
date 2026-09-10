/** e2e/acceso-por-dni.spec.ts
 *
 * El circuito completo del pedido del cliente, por navegador: el admin da de
 * alta a alguien de cancha SIN correo, le dicta la clave, y esa persona entra
 * con su DNI.
 *
 * Por qué hace falta un navegador y no alcanzan los tests de servidor:
 * `tests/auth-acceso-por-dni.test.ts` y `tests/usuarios-tenant.test.ts` ya
 * prueban la API entera (24 casos). Lo que ninguno de los dos puede probar es
 * el CABLEADO del cliente -- que la pestaña Usuarios aparezca para un admin,
 * que el formulario mande `dni` y no `email`, y sobre todo que la clave
 * temporal que la pantalla muestra sea la misma que el servidor guardó. Si
 * ese último detalle se rompe, todos los tests de servidor siguen en verde y
 * el grifero igual no puede entrar.
 *
 * Al final da de baja al usuario que creó, y no por prolijidad: la cuota de
 * usuarios del tenant cuenta los ACTIVOS (ver platformCuotas.service.ts), así
 * que sin la baja este spec se comería un cupo por corrida y empezaría a
 * fallar en CI semanas después, lejos de cualquier cambio que lo explique.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("el admin da de alta a alguien de cancha y esa persona entra con su DNI", async ({ page }) => {
  const admin = adminA();
  // 8 dígitos como un DNI real, con prefijo 99 para no chocar nunca con uno
  // de verdad si este spec llegara a correr contra datos reales.
  const dni = `99${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const nombre = `Grifero E2E ${dni}`;

  await loginPorUI(page, admin.email, admin.password);

  await page.getByRole("button", { name: "Usuarios" }).click();
  await expect(page.getByRole("heading", { name: "Usuarios" })).toBeVisible();

  await page.getByRole("button", { name: "+ Nuevo usuario" }).click();
  await page.getByLabel("Nombre y apellido").fill(nombre);
  await page.getByLabel("DNI").fill(dni);

  // La clave la propone la pantalla; se lee del campo para poder usarla
  // después, igual que el admin la leería para dictarla.
  const clave = await page.getByLabel("Clave temporal").inputValue();
  expect(clave.length).toBeGreaterThanOrEqual(8);

  await page.getByRole("button", { name: "Crear usuario" }).click();

  // Se muestra UNA vez y no se puede recuperar: si esto no aparece, el admin
  // se queda sin la clave que acaba de crear.
  await expect(page.getByRole("heading", { name: "Usuario creado" })).toBeVisible();
  await expect(page.getByText(clave, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Ya la anoté" }).click();

  await expect(page.getByRole("cell", { name: nombre })).toBeVisible();

  // ── Y ahora, la prueba de fuego: que pueda entrar ────────────────────
  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page.getByLabel("Correo o DNI")).toBeVisible();

  await page.getByLabel("Correo o DNI").fill(dni);
  await page.getByLabel("Contraseña").fill(clave);
  await page.getByRole("button", { name: "Ingresar" }).click();

  // No llega al dashboard: la clave temporal obliga a cambiarla primero, así
  // el admin no se queda sabiendo la contraseña con la que su grifero firma.
  await expect(page.getByRole("heading", { name: "Poné tu propia contraseña" })).toBeVisible();

  // ── Limpieza: dejarlo inactivo para no consumir cupo ─────────────────
  await page.getByRole("button", { name: "No sos vos? Cerrar sesión" }).click();
  await loginPorUI(page, admin.email, admin.password);
  await page.getByRole("button", { name: "Usuarios" }).click();
  await page
    .getByRole("row", { name: new RegExp(dni) })
    .getByRole("button", { name: "Dar de baja" })
    .click();
  await page.getByLabel("Motivo").fill("Usuario de prueba automatizada");
  await page.getByRole("button", { name: "Dar de baja", exact: true }).last().click();
  await expect(page.getByRole("row", { name: new RegExp(dni) })).toContainText("Dado de baja");
});
