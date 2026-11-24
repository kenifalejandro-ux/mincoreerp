/** e2e/roles-mecanico-operario.spec.ts
 *
 * Los perfiles de mantenimiento «Mecánico» y «Operario» (migración 0202), por navegador.
 *
 * Por qué hace falta un navegador y no alcanza `tests/roles-mecanico-operario.test.ts`: ese test prueba que el
 * servidor da de alta el rol y que NO le asigna módulos. Lo que solo se ve en pantalla es (1) que el formulario
 * de Usuarios ofrezca los dos perfiles y (2) que alguien que entra SIN ningún módulo (es lo que son hoy estos
 * perfiles, hasta que una entrega les abra el suyo) no se quede con una pantalla rota o en blanco: es lo primero
 * que ve esa persona.
 *
 * Al final da de baja a los dos usuarios: la cuota de usuarios del tenant cuenta los activos (ver
 * platformCuotas.service.ts), y sin la baja este spec se comería dos cupos por corrida.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";

test("el formulario ofrece Mecánico y Operario y el mecánico entra sin módulos sin pantalla rota @celular", async ({
  page,
}) => {
  // Dos altas, un cambio de clave, tres inicios de sesión y dos bajas: no cabe en los 30 s de siempre.
  test.setTimeout(90_000);
  const admin = adminA();
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const dniDe = () =>
    `96${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const mecanico = {
    dni: dniDe(),
    password: `Mecanico-${marca}-9x`,
    nombre: `Mecánico E2E ${marca}`,
  };
  const operario = {
    dni: dniDe(),
    password: `Operario-${marca}-9x`,
    nombre: `Operario E2E ${marca}`,
  };

  await loginPorUI(page, admin.email, admin.password);

  // ── 1. El formulario de alta ofrece los dos perfiles ────────────────
  await page.getByRole("button", { name: "Administración" }).click();
  await expect(page.getByRole("heading", { name: "Usuarios" })).toBeVisible();
  await page.getByRole("button", { name: "Nuevo usuario" }).click();
  await expect(page.getByRole("group").getByText("Mecánico", { exact: true })).toBeVisible();
  await expect(page.getByRole("group").getByText("Operario", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // ── 2. Alta de los dos (por la API: lo que se prueba es lo que viene después) ──
  for (const [persona, rol] of [
    [mecanico, "mecanico"],
    [operario, "operario"],
  ] as const) {
    const alta = await page.request.post("/api/erp/usuarios", {
      data: { nombre: persona.nombre, dni: persona.dni, password: persona.password, rol },
    });
    expect(alta.status(), await alta.text()).toBe(201);
  }

  // ── 3. El mecánico entra y no ve ningún módulo, pero la app funciona ──
  await page.request.post("/api/auth/logout");
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: mecanico.dni, password: mecanico.password },
  });
  expect(login.status()).toBe(200);
  await page.goto("/");
  const nueva = `Nueva-${marca}-7y`;
  await page.getByLabel("Contraseña temporal").fill(mecanico.password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
  await page.getByLabel("Confirmar nueva contraseña").fill(nueva);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();

  // Sale del cambio de clave y llega a una pantalla que se puede usar: hay forma de cerrar sesión y no hay
  // pantalla de error ni módulos del ERP.
  await expect(page.getByRole("button", { name: "Salir" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/algo salió mal|error inesperado/i)).toHaveCount(0);
  for (const modulo of ["Combustible", "Equipos", "Checklists", "IPERC", "Órdenes de Trabajo"]) {
    await expect(page.getByRole("button", { name: modulo, exact: true })).toHaveCount(0);
  }
  // Y el servidor tampoco le abre nada si lo pide a mano.
  const combustible = await page.request.get("/api/erp/combustible");
  expect([401, 403]).toContain(combustible.status());

  // ── Limpieza: dar de baja a los dos ─────────────────────────────────
  await page.request.post("/api/auth/logout");
  await loginPorUI(page, admin.email, admin.password);
  const lista = await page.request.get("/api/erp/usuarios");
  const usuarios = (await lista.json()).data as { id: string; dni: string }[];
  for (const dni of [mecanico.dni, operario.dni]) {
    const usuario = usuarios.find((u) => u.dni === dni);
    expect(usuario).toBeTruthy();
    const baja = await page.request.patch(`/api/erp/usuarios/${usuario!.id}/estado`, {
      data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
    });
    expect(baja.ok()).toBeTruthy();
  }
});
