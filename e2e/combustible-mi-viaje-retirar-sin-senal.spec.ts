/** e2e/combustible-mi-viaje-retirar-sin-senal.spec.ts
 *
 * Quien entregó el mando (y sigue al volante) retira la entrega SIN señal: queda en la cola, se ve
 * retirada en su pantalla y se envía sola al volver la red. Un reenvío (la respuesta se perdió y la
 * cola reintenta) no da error y no cambia nada: el servidor decide por el estado, no usa el
 * `cliente_uuid` del retiro. El preparativo va por API (ver el fixture).
 */
import { test, expect } from "@playwright/test";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  iniciarMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";

test("retirar la entrega sin señal queda guardado, se envía al volver la red y reenviarlo no cambia nada ni da error", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const v = await prepararViajeDeConductor(page, { conRelevo: true });
  await entrarAMiViaje(page, v);
  await iniciarMiViaje(page, "100");
  await expect(page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true })).toBeVisible();
  try {
    // Cada respuesta del servidor a un retiro: la cola reenvía la marca guardada.
    const retiros: { estado: number; cuerpo: unknown }[] = [];
    page.on("response", (r) => {
      if (
        r.request().method() === "POST" &&
        r.url().endsWith(`/viajes/${v.viajeId}/mando/retirar`)
      ) {
        retiros.push({ estado: r.status(), cuerpo: r.request().postDataJSON() });
      }
    });

    const pendiente = async () => {
      const mios = await page.request.get("/api/erp/combustible/viajes/mios");
      const fila = ((await mios.json()).data as { id: string; entrega_pendiente: unknown }[]).find(
        (x) => x.id === v.viajeId
      );
      expect(fila, "el viaje tiene que seguir en /viajes/mios").toBeTruthy();
      return Boolean(fila!.entrega_pendiente);
    };

    // ── Entrega el mando CON señal: queda pendiente en el servidor ─────────
    await page.getByRole("button", { name: "Entregar el mando" }).click();
    await page.getByLabel(/que marca el tablero al entregar/).fill("150");
    await page.getByRole("button", { name: "Entregar el mando" }).click();
    await expect(page.getByText(/Esperando que .* acepte el mando/)).toBeVisible();
    expect(await pendiente()).toBe(true);

    // ── Lo retira SIN señal ────────────────────────────────────────────────
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Retirar la entrega" }).click();
    await expect(page.getByText(/Sin señal: quedó guardado en el celular/)).toBeVisible();
    // Ya se ve retirada aunque siga en la cola, y avisa que falta enviarla.
    await expect(page.getByText(/Esperando que .* acepte el mando/)).toBeHidden();
    await expect(page.getByRole("button", { name: "Entregar el mando" })).toBeVisible();
    await expect(page.getByText("Pendiente de enviar")).toBeVisible();

    // ── Vuelve la red: la cola envía el retiro ─────────────────────────────
    await page.context().setOffline(false);
    await expect
      .poll(async () => (await pendiente()) === false, {
        message: "la cola tiene que enviar el retiro",
        timeout: 60_000,
      })
      .toBe(true);
    await expect(page.getByText("Pendiente de enviar")).toBeHidden();
    const aceptados = retiros.filter((r) => r.estado === 200);
    expect(aceptados).toHaveLength(1);

    // ── Un reenvío (la respuesta se perdió y la cola reintenta): el viaje vuelve como quedó ──
    const reenvio = await page.request.post(
      `/api/erp/combustible/viajes/${v.viajeId}/mando/retirar`,
      {
        data: aceptados[0].cuerpo as object,
      }
    );
    expect(reenvio.status()).toBe(200);
    expect(await pendiente()).toBe(false);
  } finally {
    await darDeBajaAlConductor(page, v);
  }
});
