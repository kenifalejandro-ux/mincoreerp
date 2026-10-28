/**tests/combustible-compra-ruta-galones.test.ts
 *
 * Una compra en ruta no tiene tanque y el formulario la pide en galones: 20 gal
 * pesan 75.7 L en TODAS las cuentas de litros de Combustible (tope diario,
 * consumo excedido, ratio urea/diésel, reportes), no solo en Viajes. La urea
 * sigue en litros.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { CombustibleRepository } from "../src/modules/combustible/combustible.repository";
import { LITROS_POR_GALON } from "../src/server/shared/utils/unidades";

const password = "ClaveDePrueba123";
const LITROS_20_GAL = 20 * LITROS_POR_GALON;

describe("combustible: la compra en ruta pesa en galones en todas las cuentas de litros", () => {
  const admin = request.agent(app);
  const repo = new CombustibleRepository();
  let tenantId: string;
  let equipoId: number;
  const antes = new Date(Date.now() - 24 * 3_600_000);
  const desde = antes.toISOString();
  const hasta = new Date(Date.now() + 3_600_000).toISOString();

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    equipoId = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("TR"),
        tipo: "TRAILER",
        tipo_medidor: "odometro",
      })
    ).body.id;
    const grifo = (
      await admin.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("GRIFO"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
    const compra = await admin.post("/api/erp/combustible/compras-ruta").send({
      cliente_uuid: crypto.randomUUID(),
      grifo_id: grifo,
      comprobante_tipo: "boleta",
      comprobante_numero: idUnico("B"),
      equipo_id: equipoId,
      despachado_en: new Date(Date.now() - 3_600_000).toISOString(),
      combustible: {
        tipo_combustible: "diesel_b5",
        cantidad: 20,
        costo_unitario: 17.5,
        lectura_odometro: 1100,
        horas_abastecidas: 5,
      },
      urea: { lineas: [{ presentacion: "bolsa", cantidad_bultos: 2, costo_unitario: 30 }] },
    });
    expect(compra.status, JSON.stringify(compra.body)).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("consumo excedido y vales para consumo cuentan 20 gal como 75.7 L", async () => {
    const litros = await withTenant(tenantId, (c) =>
      repo.findLitrosDesde(c, tenantId, equipoId, antes)
    );
    expect(litros).toBeCloseTo(LITROS_20_GAL, 2);

    const vales = await withTenant(tenantId, (c) =>
      repo.findValesParaConsumo(c, tenantId, { equipoId, desde, hasta, limite: 100 })
    );
    expect(vales.map((v) => Number(v.litros))).toEqual([expect.closeTo(LITROS_20_GAL, 2)]);
  });

  it("el tope diario, el despachado por período y por día cuentan lo mismo", async () => {
    const acum = await withTenant(tenantId, (c) =>
      repo.findAcumuladoDiario(c, tenantId, "combustible", { equipoId }, hasta)
    );
    expect(Number(acum.totalL)).toBeCloseTo(LITROS_20_GAL, 2);

    const entre = await withTenant(tenantId, (c) =>
      repo.findDespachadoEntre(c, tenantId, desde, hasta)
    );
    expect(Number(entre.litros)).toBeCloseTo(LITROS_20_GAL, 2);

    const porDia = await withTenant(tenantId, (c) =>
      repo.findDespachadoPorDiaYActor(c, tenantId, 3)
    );
    const total = porDia
      .filter((f) => f.equipoId === equipoId)
      .reduce((a, f) => a + Number(f.litros), 0);
    // Solo combustible: la urea (8 L) no se suma al diésel.
    expect(total).toBeCloseTo(LITROS_20_GAL, 2);
  });

  it("el ratio urea/diésel usa 75.7 L de diésel y la urea sigue en litros (8 L)", async () => {
    const r = await withTenant(tenantId, (c) =>
      repo.findRatioUreaDiesel(c, tenantId, equipoId, hasta, 3)
    );
    expect(r.litrosDiesel).toBeCloseTo(LITROS_20_GAL, 2);
    expect(r.litrosUrea).toBeCloseTo(8, 2);
  });

  it("la urea de la misma boleta sigue en litros: el tope de urea da 8 L, no 30 L", async () => {
    const acum = await withTenant(tenantId, (c) =>
      repo.findAcumuladoDiario(c, tenantId, "urea", { equipoId }, hasta)
    );
    expect(acum.totalL).toBeCloseTo(8, 2);

    const porDia = await withTenant(tenantId, (c) => repo.findUreaPorDiaYEquipo(c, tenantId, 3));
    const suma = (campo: "ureaL" | "dieselL") =>
      porDia.filter((f) => f.equipoId === equipoId).reduce((a, f) => a + f[campo], 0);
    expect(suma("ureaL")).toBeCloseTo(8, 2);
    expect(suma("dieselL")).toBeCloseTo(LITROS_20_GAL, 2);
  });
});
