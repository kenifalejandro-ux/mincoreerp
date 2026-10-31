/** e2e/combustible-conductor-historiales.spec.ts
 *
 * Los dos historiales del conductor, cada uno en su pantalla:
 *   - Compra en ruta: SUS boletas a un proveedor.
 *   - Tanques: SUS cargas desde una tanqueta.
 *
 * Antes, Tanques pintaba el mismo historial de boletas que Compra en ruta. Qué
 * prueba y por qué en un navegador real: los tests de servidor ya cubren el
 * permiso (403 en los otros orígenes) y la cola de pendientes. Lo que solo se
 * ve acá es la pantalla de cada conductor: que cada pestaña muestre lo suyo y
 * que un conductor NO vea lo del otro.
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginPorUI } from "./fixtures/auth";
import {
  darDeBajaAlConductor,
  entrarAMiViaje,
  type ViajeDeConductor,
} from "./fixtures/conductorConViaje";
import { adminA } from "./fixtures/entorno";
import { primerGrifoActivo } from "./fixtures/grifos";

test("el conductor ve sus boletas en Compra en ruta y sus cargas en Tanques @celular", async ({
  page,
}) => {
  // Siembra por API, dos entradas de conductor y dos pantallas cada una.
  test.setTimeout(150_000);
  const marca = randomBytes(3).toString("hex").toUpperCase();
  const admin = adminA();
  await loginPorUI(page, admin.email, admin.password);
  const grifoInternoId = await primerGrifoActivo(page);

  const crear = async (ruta: string, data: object, esperado = 201) => {
    const r = await page.request.post(ruta, { data });
    expect(r.status(), `${ruta}: ${await r.text()}`).toBe(esperado);
    return (await r.json()) as Record<string, unknown>;
  };

  const nuevo = (prefijo: string, nombre: string) => ({
    dni: `${prefijo}${randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6)}`,
    password: `Clave-${marca}-9x`,
    nombre,
  });
  const a = nuevo("96", `Conductor A ${marca}`);
  const b = nuevo("95", `Conductor B ${marca}`);
  for (const c of [a, b]) await crear("/api/erp/usuarios", { ...c, rol: "conductor_ruta" });

  const tanque = await crear("/api/erp/combustible", {
    codigo: `HMH-${marca}`,
    tanque_nombre: `Huamachuco ${marca}`,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 10000,
    nivel_actual: 8000,
    requiere_documento: false,
    grifo_interno_id: grifoInternoId,
  });
  const tanqueta = await crear("/api/erp/combustible/tanquetas", {
    grifo_interno_id: grifoInternoId,
    codigo: `TQ-${marca}`,
  });
  const placa = `VH-${marca}`;
  const equipo = await crear("/api/erp/equipos", {
    placa_codigo: placa,
    tipo: "VOLQUETE",
    tipo_medidor: "horometro",
    // La unidad queda a cargo del conductor A: solo así puede cargarla.
    conductor_nombre: a.nombre,
    conductor_dni: a.dni,
    grifo_interno_id: grifoInternoId,
  });
  const proveedor = await crear("/api/erp/combustible/grifos", {
    nombre: `PRIMAX ${marca}`,
    abastece_ruta: true,
    abastece_tanque: false,
  });

  // Se llena la tanqueta desde el tanque y se asigna a la unidad.
  await crear("/api/erp/combustible/despachos", {
    origen: "tanque_propio",
    combustible_id: tanque.id,
    tipo_combustible: "diesel_b5",
    tipo_destino: "reserva_cubeta",
    tanqueta_destino_id: Number(tanqueta.id),
    serie_talonario: `P${marca}`,
    n_vale: 1,
    cantidad: 120,
    lectura_contometro: 120,
    costo_unitario: 16,
  });
  const asignada = await page.request.put(`/api/erp/combustible/tanquetas/${tanqueta.id}/asignar`, {
    data: { equipo_id: equipo.id, serie_talonario: `C${marca}`, n_vale: 1 },
  });
  expect(asignada.status(), await asignada.text()).toBe(200);

  const numeroBoleta = `B001-${marca}`;
  // La sesión del conductor A (con la clave propia que la temporal obliga).
  const credenciales = (c: { dni: string; password: string }) => ({
    a: "",
    b: "",
    dni: c.dni,
    password: c.password,
    marca,
    viajeId: "",
    numero: 0,
  });
  const comoA: ViajeDeConductor = credenciales(a);
  const comoB: ViajeDeConductor = { ...credenciales(b), relevo: undefined };
  const paraBaja: ViajeDeConductor = {
    ...comoA,
    relevo: { dni: b.dni, password: b.password, nombre: b.nombre },
  };

  try {
    await page.request.post("/api/auth/logout");
    await entrarAMiViaje(page, comoA);

    // ── Lo que hace el conductor A: una carga desde la tanqueta y una boleta ──
    const carga = await page.request.post("/api/erp/combustible/despachos", {
      data: {
        origen: "tanqueta",
        tanqueta_origen_id: Number(tanqueta.id),
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipo.id,
        cantidad: 10,
        lectura_horometro: 1000,
      },
    });
    expect(carga.status(), await carga.text()).toBe(201);
    const compra = await page.request.post("/api/erp/combustible/despachos", {
      data: {
        origen: "compra_externa",
        grifo_id: proveedor.id,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipo.id,
        comprobante_tipo: "boleta",
        comprobante_numero: numeroBoleta,
        cantidad: 40,
        lectura_horometro: 1100,
        horas_abastecidas: 12,
        costo_unitario: 17.5,
        despachado_en: new Date().toISOString(),
      },
    });
    expect(compra.status(), await compra.text()).toBe(201);

    // ── Tanques: su carga, y NO la boleta ──────────────────────────────────
    await page.getByRole("button", { name: "Tanques" }).click();
    await expect(page.getByRole("heading", { name: "Mis cargas desde tanqueta" })).toBeVisible();
    const filaCarga = page.getByRole("row").filter({ hasText: tanqueta.codigo as string });
    await expect(filaCarga).toHaveCount(1);
    await expect(filaCarga).toContainText(placa);
    await expect(filaCarga).toContainText("10 gal");
    await expect(page.getByText(numeroBoleta)).toHaveCount(0);

    // ── Compra en ruta: su boleta, y NO la carga ───────────────────────────
    await page.getByRole("button", { name: "Compra en ruta" }).click();
    await expect(page.getByRole("heading", { name: "Compra en ruta" })).toBeVisible();
    await expect(page.getByText(numeroBoleta)).toBeVisible();
    await expect(page.getByText(tanqueta.codigo as string)).toHaveCount(0);

    // ── Sin señal: el historial avisa en vez de quedarse cargando ──────────
    await page.getByRole("button", { name: "Tanques" }).click();
    await expect(filaCarga).toHaveCount(1);
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Consultar" }).click();
    await expect(page.getByText(/Sin conexión: no se pudo cargar el historial/)).toBeVisible();
    await page.context().setOffline(false);
    await page.getByRole("button", { name: "Consultar" }).click();
    await expect(filaCarga).toHaveCount(1);

    // ── El conductor B no ve nada de lo de A ───────────────────────────────
    await page.request.post("/api/auth/logout");
    await entrarAMiViaje(page, comoB);
    await page.getByRole("button", { name: "Tanques" }).click();
    await expect(page.getByText("Todavía no hay cargas desde tanqueta registradas.")).toBeVisible();
    await expect(page.getByText(tanqueta.codigo as string)).toHaveCount(0);
    await page.getByRole("button", { name: "Compra en ruta" }).click();
    await expect(page.getByText("Todavía no hay compras en ruta registradas.")).toBeVisible();
    await expect(page.getByText(numeroBoleta)).toHaveCount(0);
  } finally {
    await page.context().setOffline(false);
    await darDeBajaAlConductor(page, paraBaja);
  }
});
