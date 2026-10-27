/** e2e/combustible-mi-viaje-descanso.spec.ts
 *
 * "Mi viaje" con descansos (0151): el conductor descansa en ruta, el viaje no avanza hasta que lo
 * termina, y todo funciona también sin señal (la cola envía el inicio y el fin, en orden). El
 * preparativo va por API (ver el fixture).
 */
import { test, expect, type Page } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  iniciarMiViaje,
  prepararViajeDeConductor,
  type ViajeDeConductor,
} from "./fixtures/conductorConViaje";
import { adminA } from "./fixtures/entorno";

interface DescansoApi {
  motivo: string | null;
  inicio_en: string;
  fin_en: string | null;
}

async function descansosDelServidor(page: Page, v: ViajeDeConductor): Promise<DescansoApi[]> {
  const mios = await page.request.get("/api/erp/combustible/viajes/mios");
  if (!mios.ok()) return [];
  const viaje = (
    (await mios.json()).data as { id: string; descansos: DescansoApi[] | null }[]
  ).find((x) => x.id === v.viajeId);
  return viaje?.descansos ?? [];
}

test("el conductor descansa: el viaje no avanza hasta que lo termina, con motivo o con uno escrito", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const v = await prepararViajeDeConductor(page);
  await entrarAMiViaje(page, v);
  await iniciarMiViaje(page, "100");
  const llegar = page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true });
  await expect(llegar).toBeVisible();

  // Con motivo de la lista.
  await page.getByRole("button", { name: "Descansar" }).click();
  await page.getByRole("button", { name: "Dormir" }).click();
  await page.getByRole("button", { name: "Empezar descanso" }).click();
  await expect(page.getByText("Descansando · Dormir")).toBeVisible();
  await expect(llegar).toBeHidden(); // con el descanso abierto el viaje no avanza
  await page.getByRole("button", { name: "Terminar descanso" }).click();
  await expect(page.getByText("Descanso terminado.")).toBeVisible();
  await expect(llegar).toBeVisible();

  // Con un motivo escrito.
  await page.getByRole("button", { name: "Descansar" }).click();
  await page.getByRole("button", { name: "Otro" }).click();
  await page.getByLabel("Escribe el motivo").fill("Calor");
  await page.getByRole("button", { name: "Empezar descanso" }).click();
  await expect(page.getByText("Descansando · Calor")).toBeVisible();
  await page.getByRole("button", { name: "Terminar descanso" }).click();
  await expect(llegar).toBeVisible();

  const descansos = await descansosDelServidor(page, v);
  expect(descansos.map((d) => d.motivo)).toEqual(["Dormir", "Calor"]);
  expect(descansos.every((d) => d.fin_en)).toBe(true);

  await darDeBajaAlConductor(page, v);
});

test("descansar sin señal queda guardado y se envía en orden al volver la red", async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const v = await prepararViajeDeConductor(page);
  await entrarAMiViaje(page, v);
  await iniciarMiViaje(page, "100");
  const llegar = page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true });
  await expect(llegar).toBeVisible();

  // ── Se corta la red ──────────────────────────────────────────────────
  await context.setOffline(true);

  await page.getByRole("button", { name: "Descansar" }).click();
  await page.getByRole("button", { name: "Empezar descanso" }).click();
  await expect(page.getByText(/Sin señal: quedó guardado en el celular/)).toBeVisible();
  // Ya se ve aunque siga en la cola: lo dice la etiqueta del viaje y el aviso de abajo.
  await expect(page.getByText("Descansando").first()).toBeVisible();
  await expect(llegar).toBeHidden();
  // La hora de cada marca se toma al tocar el botón: se deja pasar un momento entre las dos.
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Terminar descanso" }).click();
  await expect(llegar).toBeVisible();

  // ── Vuelve la red: la cola envía el inicio y el fin, y en orden ───────
  await context.setOffline(false);
  await expect
    .poll(
      async () => {
        const d = await descansosDelServidor(page, v);
        if (d.length === 0 || !d[0].fin_en) return "falta una marca";
        return Date.parse(d[0].fin_en) > Date.parse(d[0].inicio_en) ? "en orden" : "desordenado";
      },
      {
        message: "el inicio y el fin del descanso tienen que llegar, en ese orden",
        timeout: 60_000,
      }
    )
    .toBe("en orden");
  expect(await descansosDelServidor(page, v)).toHaveLength(1);
  await expect(page.getByText("Pendiente de enviar")).toBeHidden();

  await darDeBajaAlConductor(page, v);
});

test("una avería o un tráfico dicen qué pasó, en el celular y en el panel del encargado", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const v = await prepararViajeDeConductor(page);
  const contexto = await browser.newContext();
  try {
    // La oficina deja el viaje abierto en el panel.
    const oficina = await contexto.newPage();
    const admin = adminA();
    await loginPorUI(oficina, admin.email, admin.password);
    await oficina.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await oficina.getByRole("button", { name: "Viajes" }).click();

    await entrarAMiViaje(page, v);
    await iniciarMiViaje(page, "100");
    const llegar = page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true });
    await expect(llegar).toBeVisible();

    // Avería: no pide texto; el viaje pasa a "En avería", y el panel de la oficina también.
    await page.getByRole("button", { name: "Descansar" }).click();
    await page.getByRole("button", { name: "Avería" }).click();
    await page.getByRole("button", { name: "Empezar descanso" }).click();
    await expect(page.getByText("En avería", { exact: true }).first()).toBeVisible();
    const fila = oficina.getByRole("row").filter({ hasText: `${v.a} → ${v.b} → ${v.a}` });
    await expect(fila.getByText("En avería", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Terminar descanso" }).click();
    await expect(llegar).toBeVisible();
    await expect(fila.getByText("En avería", { exact: true })).toHaveCount(0, { timeout: 30_000 });

    // Tráfico: pide escribir qué pasó.
    await page.getByRole("button", { name: "Descansar" }).click();
    await page.getByRole("button", { name: "Tráfico" }).click();
    await page.getByLabel("Escribe el motivo").fill("obras en la vía");
    await page.getByRole("button", { name: "Empezar descanso" }).click();
    await expect(page.getByText("Detenido por tráfico · obras en la vía")).toBeVisible();
    await expect(fila.getByText("Detenido por tráfico", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Terminar descanso" }).click();
  } finally {
    await contexto.close();
  }
  await darDeBajaAlConductor(page, v);
});
