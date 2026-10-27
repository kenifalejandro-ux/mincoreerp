/** e2e/combustible-mi-viaje-sin-senal.spec.ts
 *
 * "Mi viaje" sin señal (0148): el conductor llega a la parada y sale de ella con la red cortada.
 * Las dos marcas quedan en el celular (el viaje ya se ve avanzado) y, al volver la señal, la cola
 * las envía solas y EN ORDEN. Es el único test que ejercita la cadena real: fetch que falla →
 * apiFetch encola en IndexedDB → vuelve la red → el servidor recibe llegada y salida.
 */
import { test, expect } from "@playwright/test";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  iniciarMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";

test("llegar a la parada y salir sin señal queda guardado y se envía en orden al volver la red", async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const v = await prepararViajeDeConductor(page);
  await entrarAMiViaje(page, v);
  const odometro = page.getByLabel(/que marca el tablero/);
  await iniciarMiViaje(page, "100");
  await expect(page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true })).toBeVisible();

  // ── Se corta la red ──────────────────────────────────────────────────
  await context.setOffline(true);

  await page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true }).click();
  await odometro.fill("150");
  await page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true }).click();
  await expect(page.getByText(/Sin señal: quedó guardado en el celular/)).toBeVisible();
  // El viaje ya se ve avanzado aunque la marca siga en la cola.
  await expect(page.getByRole("button", { name: `Salir hacia ${v.a}`, exact: true })).toBeVisible();
  await expect(page.getByText("Pendiente de enviar")).toBeVisible();

  await page.getByRole("button", { name: `Salir hacia ${v.a}`, exact: true }).click();
  await odometro.fill("150");
  await page.getByRole("button", { name: `Salir hacia ${v.a}`, exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Llegué a ${v.a} · terminar viaje` })
  ).toBeVisible();

  // ── Vuelve la red: la cola envía las dos marcas, y en orden ──────────
  await context.setOffline(false);
  await expect
    .poll(
      async () => {
        const mios = await page.request.get("/api/erp/combustible/viajes/mios");
        if (!mios.ok()) return "sin respuesta";
        const viaje = (
          (await mios.json()).data as {
            id: string;
            paradas: { llegada_en: string | null; salida_en: string | null }[];
          }[]
        ).find((x) => x.id === v.viajeId);
        const p = viaje?.paradas[1];
        if (!p?.llegada_en || !p.salida_en) return "falta una marca";
        return Date.parse(p.salida_en) > Date.parse(p.llegada_en) ? "en orden" : "desordenadas";
      },
      {
        message: "la llegada y la salida tienen que llegar al servidor, en ese orden",
        timeout: 60_000,
      }
    )
    .toBe("en orden");
  await expect(page.getByText("Pendiente de enviar")).toBeHidden();

  await darDeBajaAlConductor(page, v);
});
