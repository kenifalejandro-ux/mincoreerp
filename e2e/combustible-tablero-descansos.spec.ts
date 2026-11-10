/** e2e/combustible-tablero-descansos.spec.ts
 *
 * El encargado, desde el detalle de un viaje en curso: marca el descanso del conductor (con motivo
 * obligatorio), puede registrar una llegada aunque el descanso siga abierto (no hay orden de
 * registro), lo termina y registra por él la llegada que se olvidó, con su fecha y hora reales
 * («Registrar llegada»: «Fue antes», hora, motivo y odómetro). El preparativo va por API; no hace falta una cuenta de conductor porque la
 * oficina marca por él.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("el encargado marca el descanso y la llegada por el conductor, y no avanza con el descanso abierto", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoId = await primerGrifoActivo(page);

  const lugar = async (nombre: string) => {
    const r = await page.request.post("/api/erp/viajes/lugares", { data: { nombre } });
    expect(r.status()).toBe(201);
    return Number((await r.json()).id);
  };
  const a = `Huamachuco ${marca}`;
  const b = `Bambamarca ${marca}`;
  const idA = await lugar(a);
  const idB = await lugar(b);
  const equipo = await page.request.post("/api/erp/equipos", {
    data: {
      placa_codigo: `VQ-${marca}`,
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: `Conductor ${marca}`,
      conductor_dni: `4${Math.floor(1e6 + Math.random() * 9e6)}`,
      grifo_interno_id: grifoId,
    },
  });
  expect(equipo.status()).toBe(201);
  const programado = await page.request.post("/api/erp/viajes", {
    data: { equipo_id: (await equipo.json()).id, paradas: [idA, idB, idA] },
  });
  expect(programado.status()).toBe(201);
  const viaje = await programado.json();
  // Salió hace 3 horas: la llegada que se olvidó cae «hace 1 h», después de esa salida.
  const salida = await page.request.post(`/api/erp/viajes/${viaje.id}/iniciar`, {
    data: {
      medidor_inicio: 100,
      inicio_en: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      motivo: "preparativo del e2e",
    },
  });
  expect(salida.status()).toBe(200);

  await page.getByRole("button", { name: /^Gestión operacional de flota Abrir submenú$/ }).click();
  await page.getByRole("button", { name: "Viajes" }).click();
  await page.getByRole("button", { name: `Ver viaje V-${viaje.numero}` }).click();
  await expect(page.getByText("Sin descansos.")).toBeVisible();

  // El motivo es obligatorio: sin elegirlo, el botón está apagado.
  const marcarDescanso = page.getByRole("button", { name: "Marcar descanso (encargado)" });
  await expect(marcarDescanso).toBeDisabled();
  await page.getByRole("button", { name: "Dormir" }).click();
  await marcarDescanso.click();
  await expect(page.getByText(/marcado por la oficina/)).toBeVisible();

  // Con el descanso abierto el registro no se bloquea: solo se avisa en el banner.
  await expect(page.getByRole("button", { name: "Registrar llegada" })).toBeEnabled();
  await page.getByRole("button", { name: "Terminar descanso (encargado)" }).click();

  // Registra la llegada a B, con su hora real (hace 1 h), motivo y odómetro.
  const local = (ms: number) => {
    const d = new Date(ms);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  await page.getByRole("button", { name: "Registrar llegada" }).click();
  await page.getByRole("button", { name: b, exact: true }).click();
  await page.getByRole("button", { name: "Fue antes" }).click();
  await page.getByLabel("Fecha y hora").fill(local(Date.now() - 3_600_000));
  const registrar = page.getByRole("button", { name: "Registrar", exact: true });
  await registrar.click(); // falta el motivo
  await expect(page.getByRole("alert")).toContainText("motivo");
  await page.getByRole("button", { name: "Sin señal" }).click();
  await page.getByRole("button", { name: /^Agregar odómetro/ }).click();
  await page.getByLabel(/Odómetro/).fill("150");
  await registrar.click();
  await expect(page.getByText("Llegada registrada.")).toBeVisible();

  const lista = await page.request.get(`/api/erp/viajes/${viaje.id}`);
  const detalle = (await lista.json()).viaje as {
    paradas: { llegada_en: string | null; llegada_medidor: string | number | null }[];
    descansos: { fin_en: string | null; inicio_por: string; fin_por: string | null }[];
  };
  expect(detalle.paradas[1].llegada_en).toBeTruthy();
  expect(Number(detalle.paradas[1].llegada_medidor)).toBe(150);
  expect(detalle.descansos).toHaveLength(1);
  expect(detalle.descansos[0]).toMatchObject({ inicio_por: "oficina", fin_por: "oficina" });
});
