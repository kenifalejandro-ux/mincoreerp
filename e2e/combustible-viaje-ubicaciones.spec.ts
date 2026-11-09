/** e2e/combustible-viaje-ubicaciones.spec.ts
 *
 * Ubicación del viaje (0182) desde la oficina: el admin anota dónde está la unidad (un lugar del
 * catálogo y un texto libre), ve el historial y la última ubicación en el detalle y en la lista, y
 * el formulario avisa de una hora imposible. Un perfil de solo lectura ve el historial pero no el
 * botón. El preparativo va por API (ver el fixture).
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

async function abrirDetalleEnLaOficina(oficina: Page, v: ViajeDeConductor) {
  await oficina
    .getByRole("button", { name: /^Gestión operacional de flota Abrir submenú$/ })
    .click();
  await oficina.getByRole("button", { name: "Viajes" }).click();
  await oficina
    .getByRole("row")
    .filter({ hasText: `${v.a} → ${v.b} → ${v.a}` })
    .first()
    .click();
}

async function viajeEnCurso(page: Page): Promise<ViajeDeConductor> {
  const v = await prepararViajeDeConductor(page);
  await entrarAMiViaje(page, v);
  await iniciarMiViaje(page, "100");
  await expect(page.getByRole("button", { name: `Llegué a ${v.b}`, exact: true })).toBeVisible();
  return v;
}

test("la oficina anota ubicaciones del viaje: catálogo y texto libre, con historial, última y avisos", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const v = await viajeEnCurso(page);
  const contexto = await browser.newContext();
  try {
    const oficina = await contexto.newPage();
    const admin = adminA();
    await loginPorUI(oficina, admin.email, admin.password);
    await abrirDetalleEnLaOficina(oficina, v);

    await expect(oficina.getByText("Todavía no hay ubicaciones anotadas.")).toBeVisible();
    const registrar = oficina.getByRole("button", { name: "Registrar ubicación" });
    // «Poner al día» tiene sus propios atajos con el mismo nombre: aquí solo los de la ubicación.
    const atajos = oficina.getByLabel("Cuándo estaba ahí").locator("xpath=..");

    // Sin lugar no se manda nada.
    await registrar.click();
    await expect(oficina.getByRole("alert")).toContainText("Elige un lugar o escribe dónde está");

    // Un lugar del catálogo, con la hora de ahora. El viaje acaba de empezar: «Ahora» cae en el
    // minuto de la salida y se tiene que aceptar (la hora se ajusta a la salida).
    await oficina.getByLabel("Dónde está").fill(v.a);
    await oficina.getByRole("option", { name: v.a, exact: true }).click();
    await atajos.getByRole("button", { name: "Ahora", exact: true }).click();
    await oficina.getByLabel("Nota (opcional)").fill("Según el GPS");
    await registrar.click();
    await expect(oficina.getByText("Ubicación registrada.")).toBeVisible();
    const historial = oficina.getByRole("list", { name: "Historial de ubicaciones" });
    await expect(historial.getByRole("listitem")).toHaveCount(1);
    await expect(historial).toContainText(v.a);
    await expect(historial).toContainText("Según el GPS");

    // Una hora anterior a la salida se avisa antes de mandar, y no suma un punto.
    await oficina.getByLabel("Dónde está").fill("Grifo viejo");
    await oficina.getByRole("option", { name: "Usar «Grifo viejo»" }).click();
    await atajos.getByRole("button", { name: "Hace 6 h", exact: true }).click();
    await registrar.click();
    await expect(oficina.getByRole("alert")).toContainText("posterior a la salida");
    await expect(historial.getByRole("listitem")).toHaveCount(1);

    // Una hora futura tampoco.
    await oficina.getByLabel("Cuándo estaba ahí").fill("2099-01-01T10:00");
    await registrar.click();
    await expect(oficina.getByRole("alert")).toContainText("no puede ser futura");

    // Texto libre: queda el que se escribió, y es la última.
    await atajos.getByRole("button", { name: "Ahora", exact: true }).click();
    await registrar.click();
    await expect(oficina.getByText("Ubicación registrada.")).toBeVisible();
    await expect(historial.getByRole("listitem")).toHaveCount(2);
    await expect(historial.getByRole("listitem").first()).toContainText("Grifo viejo");

    // El servidor guardó los dos, el último primero, uno del catálogo y otro libre.
    const detalle = await oficina.request.get(`/api/erp/viajes/${v.viajeId}`);
    const viaje = (await detalle.json()).viaje as {
      ubicaciones: { texto: string; lugar_id: number | null; origen: string }[];
      ultima_ubicacion: { texto: string };
    };
    expect(viaje.ubicaciones.map((u) => u.texto)).toEqual(["Grifo viejo", v.a]);
    expect(viaje.ubicaciones[0].lugar_id).toBeNull();
    expect(viaje.ubicaciones[1].lugar_id).not.toBeNull();
    expect(viaje.ubicaciones.every((u) => u.origen === "oficina")).toBe(true);
    expect(viaje.ultima_ubicacion.texto).toBe("Grifo viejo");

    // La lista de viajes muestra la última.
    await expect(
      oficina
        .getByRole("row")
        .filter({ hasText: `${v.a} → ${v.b} → ${v.a}` })
        .first()
    ).toContainText("Grifo viejo", { timeout: 30_000 });
  } finally {
    await contexto.close();
    await darDeBajaAlConductor(page, v);
  }
});

test("un perfil de solo lectura ve las ubicaciones pero no puede registrar", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const v = await viajeEnCurso(page);
  const contexto = await browser.newContext();
  let lectura: { dni: string } | null = null;
  try {
    // La oficina deja una ubicación por API.
    const oficina = await contexto.newPage();
    const admin = adminA();
    await loginPorUI(oficina, admin.email, admin.password);
    const anotada = await oficina.request.post(`/api/erp/viajes/${v.viajeId}/ubicaciones`, {
      data: { texto: "Peaje de Chao" },
    });
    expect(anotada.status()).toBe(201);

    // Un usuario de solo lectura.
    const dni = `96${v.dni.slice(2)}`;
    const password = `Lectura-${v.marca}-9x`;
    const alta = await oficina.request.post("/api/erp/usuarios", {
      data: { nombre: `Lectura ${v.marca}`, dni, password, rol: "lectura" },
    });
    expect(alta.status()).toBe(201);
    lectura = { dni };

    const celular = await contexto.newPage();
    const login = await celular.request.post("/api/auth/login", {
      data: { identificador: dni, password },
    });
    expect(login.status()).toBe(200);
    await celular.goto("/");
    const nueva = `Nueva-${v.marca}-7y`;
    await celular.getByLabel("Contraseña temporal").fill(password);
    await celular.getByLabel("Nueva contraseña", { exact: true }).fill(nueva);
    await celular.getByLabel("Confirmar nueva contraseña").fill(nueva);
    await celular.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(celular.getByRole("button", { name: "Dashboard" })).toBeVisible({
      timeout: 20_000,
    });
    await abrirDetalleEnLaOficina(celular, v);
    await expect(celular.getByText("Peaje de Chao").first()).toBeVisible();
    await expect(celular.getByRole("button", { name: "Registrar ubicación" })).toHaveCount(0);
    const intento = await celular.request.post(`/api/erp/viajes/${v.viajeId}/ubicaciones`, {
      data: { texto: "No debería" },
    });
    expect(intento.status()).toBe(403);
  } finally {
    await contexto.close();
    await darDeBajaAlConductor(page, v);
    if (lectura) {
      const lista = await page.request.get("/api/erp/usuarios");
      const u = ((await lista.json()).data as { id: string; dni: string }[]).find(
        (x) => x.dni === lectura!.dni
      );
      if (u) {
        await page.request.patch(`/api/erp/usuarios/${u.id}/estado`, {
          data: { estado: "inactivo", motivo: "Usuario de prueba automatizada" },
        });
      }
    }
  }
});
