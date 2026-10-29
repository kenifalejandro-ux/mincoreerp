/** e2e/combustible-viaje-descanso-encargado.spec.ts
 *
 * El relevo que no maneja se pone a descansar: su descanso no frena la unidad y la oficina lo
 * termina desde el detalle del viaje, señalándolo y con motivo (mínimo 3 letras). El preparativo va
 * por API (ver el fixture).
 */
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  iniciarMiViaje,
  prepararViajeDeConductor,
} from "./fixtures/conductorConViaje";
import { adminA } from "./fixtures/entorno";

test("la oficina termina el descanso del relevo que no maneja: pide motivo y manda el descanso señalado", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const v = await prepararViajeDeConductor(page, { conRelevo: true });
  const relevo = v.relevo!;
  const contextoRelevo = await browser.newContext();
  const contextoOficina = await browser.newContext();
  try {
    // El titular sale manejando.
    await entrarAMiViaje(page, v);
    await iniciarMiViaje(page, "100");
    const llegar = page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true });
    await expect(llegar).toBeVisible();

    // El relevo (que no maneja) se pone a descansar; que no frena la unidad lo prueba
    // `detiene === false` más abajo.
    const celularRelevo = await contextoRelevo.newPage();
    await entrarAMiViaje(celularRelevo, v, relevo);
    const inicio = await celularRelevo.request.post(
      `/api/erp/combustible/viajes/${v.viajeId}/descanso-mio`,
      { data: { motivo: "Dormir" } }
    );
    expect(inicio.status()).toBe(200);

    // La oficina abre el detalle del viaje.
    const oficina = await contextoOficina.newPage();
    const admin = adminA();
    await loginPorUI(oficina, admin.email, admin.password);
    await oficina.getByRole("button", { name: /^Combustible Abrir submenú$/ }).click();
    await oficina.getByRole("button", { name: "Viajes" }).click();
    await oficina
      .getByRole("row")
      .filter({ hasText: `${v.a} → ${v.b} → ${v.a}` })
      .first()
      .click();

    const campo = oficina.getByLabel(`Motivo para terminar el descanso de ${relevo.nombre}`);
    const boton = oficina.getByRole("button", {
      name: `Terminar descanso de ${relevo.nombre} (encargado)`,
      exact: true,
    });
    await expect(campo).toBeVisible();
    await expect(boton).toBeDisabled();

    // Con menos de 3 letras no se puede (los espacios no cuentan); con 3 o más sí.
    await campo.fill("ok");
    await expect(boton).toBeDisabled();
    await campo.fill("  a ");
    await expect(boton).toBeDisabled();
    await campo.fill("abc");
    await expect(boton).toBeEnabled();
    await campo.fill("Ya descansó, hay que seguir");
    await expect(boton).toBeEnabled();

    const envio = oficina.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith(`/viajes/${v.viajeId}/descanso/terminar`)
    );
    await boton.click();
    const cuerpo = (await envio).postDataJSON() as { descanso_id?: unknown; motivo?: string };
    expect(cuerpo.motivo).toBe("Ya descansó, hay que seguir");

    // El servidor lo cerró, y era el descanso que se señaló.
    await expect(campo).toBeHidden();
    const detalle = await oficina.request.get(`/api/erp/combustible/viajes/${v.viajeId}`);
    const descansos = (
      (await detalle.json()).viaje as {
        descansos: {
          id: number;
          fin_en: string | null;
          detiene: boolean;
          fin_por: string | null;
        }[];
      }
    ).descansos;
    expect(descansos).toHaveLength(1);
    expect(descansos[0].fin_en).toBeTruthy();
    expect(descansos[0].detiene).toBe(false);
    expect(descansos[0].fin_por).toBe("oficina");
    expect(cuerpo.descanso_id).toBeTruthy();
    expect(String(cuerpo.descanso_id)).toBe(String(descansos[0].id));
  } finally {
    await contextoRelevo.close();
    await contextoOficina.close();
    await darDeBajaAlConductor(page, v);
  }
});
