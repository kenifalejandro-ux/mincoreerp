/** e2e/combustible-mi-viaje-paradas.spec.ts
 *
 * "Mi viaje" con un viaje de ida y vuelta (0148): el conductor sale, llega a la parada, sale de
 * nuevo y termina al volver al punto de salida. El preparativo va por API: los lugares, la unidad
 * con su conductor, el viaje programado y la cuenta del conductor (que se da de baja al final:
 * la cuota de usuarios cuenta los activos).
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("el conductor hace un viaje de ida y vuelta: llega, sale y termina", async ({ page }) => {
  test.setTimeout(120_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoId = await primerGrifoActivo(page);

  const lugar = async (nombre: string) => {
    const r = await page.request.post("/api/erp/combustible/lugares", { data: { nombre } });
    expect(r.status()).toBe(201);
    return Number((await r.json()).id);
  };
  const a = `Huamachuco ${marca}`;
  const b = `Bambamarca ${marca}`;
  const idA = await lugar(a);
  const idB = await lugar(b);

  const dni = `98${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`;
  const password = `Clave-${marca}-9x`;
  const nombre = `Conductor ${marca}`;
  const alta = await page.request.post("/api/erp/usuarios", {
    data: { nombre, dni, password, rol: "conductor_ruta" },
  });
  expect(alta.status()).toBe(201);

  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: `VQ-${marca}`,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: nombre,
      conductor_dni: dni,
      grifo_interno_id: grifoId,
    },
  });
  expect(equipo.status()).toBe(201);
  const programado = await page.request.post("/api/erp/combustible/viajes", {
    data: { equipo_id: (await equipo.json()).id, paradas: [idA, idB, idA] },
  });
  expect(programado.status()).toBe(201);
  const viajeId = (await programado.json()).id as string;

  // Entra el conductor y abre Mi viaje.
  const login = await page.request.post("/api/auth/login", {
    data: { identificador: dni, password },
  });
  expect(login.status()).toBe(200);
  await page.goto("/");
  // La clave temporal obliga a poner una propia antes de entrar.
  const nueva = `Nueva-${marca}-7y`;
  await page.getByLabel("Contraseña temporal").fill(password);
  await page.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
  await page.getByLabel("Confirmar nueva contraseña").fill(nueva);
  await page.getByRole("button", { name: "Guardar y continuar" }).click();
  // El conductor no tiene Dashboard: espera su menú de Combustible.
  await page.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Mi viaje" }).click();

  const odometro = page.getByLabel(/que marca el tablero/);
  await page.getByRole("button", { name: "Revisar mi viaje" }).click();
  await page.getByRole("button", { name: "Confirmo los datos" }).click();
  await odometro.fill("100");
  await page.getByRole("button", { name: "Iniciar viaje" }).click();

  // En ruta hacia la parada: un solo botón; llegar a B no cierra el viaje.
  await page.getByRole("button", { name: `Llegué a ${b}`, exact: true }).click();
  await odometro.fill("150");
  await page.getByRole("button", { name: `Llegué a ${b}`, exact: true }).click();
  await expect(page.getByText("Llegada registrada.")).toBeVisible();

  // En la parada: sale hacia A; el odómetro viene con la lectura de la llegada.
  await page.getByRole("button", { name: `Salir hacia ${a}`, exact: true }).click();
  await expect(odometro).toHaveValue("150");
  await page.getByRole("button", { name: `Salir hacia ${a}`, exact: true }).click();
  await expect(page.getByText(/Salida registrada/)).toBeVisible();

  // Llegar a la última parada cierra el viaje.
  await page.getByRole("button", { name: `Llegué a ${a} · terminar viaje` }).click();
  await odometro.fill("250");
  await page.getByRole("button", { name: `Llegué a ${a} · terminar viaje` }).click();
  await expect(page.getByText("Viaje terminado.")).toBeVisible();

  const mios = await page.request.get("/api/erp/combustible/viajes/mios");
  const cerrado = ((await mios.json()).data as { id: string; estado: string }[]).find(
    (v) => v.id === viajeId
  );
  expect(cerrado?.estado).toBe("cerrado");

  // Limpieza: el conductor se da de baja para no consumir cupo de usuarios.
  await page.request.post("/api/auth/logout");
  await loginPorUI(page, admin.email, admin.password);
  const lista = await page.request.get("/api/erp/usuarios");
  const usuario = ((await lista.json()).data as { id: string; dni: string }[]).find(
    (u) => u.dni === dni
  );
  expect(usuario).toBeTruthy();
  const baja = await page.request.patch(`/api/erp/usuarios/${usuario!.id}/estado`, {
    data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
  });
  expect(baja.ok()).toBeTruthy();
});
