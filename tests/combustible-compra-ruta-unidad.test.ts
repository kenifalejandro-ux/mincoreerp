/**tests/combustible-compra-ruta-unidad.test.ts
 *
 * La unidad de la compra en ruta (migración 0158): la boleta dice galones o
 * litros y el sistema guarda lo que dice, sin convertir. Sin unidad (la cola sin
 * señal de antes del cambio) son galones.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { CombustibleRepository } from "../src/modules/combustible/combustible.repository";
import { LITROS_POR_GALON } from "../src/server/shared/utils/unidades";

const password = "ClaveDePrueba123";

describe("combustible: la unidad de la compra en ruta (0158)", () => {
  const admin = request.agent(app);
  const repo = new CombustibleRepository();
  let tenantId: string;
  let equipoId: number;
  let grifo: number;
  let odometro = 2000;
  const antes = new Date(Date.now() - 24 * 3_600_000);

  const cuerpo = (combustible: Record<string, unknown>) => ({
    cliente_uuid: crypto.randomUUID(),
    grifo_id: grifo,
    comprobante_tipo: "boleta",
    comprobante_numero: idUnico("B"),
    equipo_id: equipoId,
    despachado_en: new Date(Date.now() - 3_600_000).toISOString(),
    combustible: {
      tipo_combustible: "diesel_b5",
      costo_unitario: 4.5,
      lectura_odometro: (odometro += 10),
      horas_abastecidas: 5,
      ...combustible,
    },
  });
  const litrosDeLaUnidad = () =>
    withTenant(tenantId, (c) => repo.findLitrosDesde(c, tenantId, equipoId, antes));

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
    grifo = (
      await admin.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("GRIFO"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("una compra de 70 L cuenta 70 L (no 264 L) y el historial dice 70 L", async () => {
    const r = await admin
      .post("/api/erp/combustible/compras-ruta")
      .send(cuerpo({ cantidad: 70, unidad: "L" }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await litrosDeLaUnidad()).toBeCloseTo(70, 2);

    const h = await admin.get("/api/erp/combustible/compras-ruta");
    const cantidades = (h.body as { combustible: { galones: number; unidad: string } | null }[])
      .filter((b) => b.combustible)
      .map((b) => `${b.combustible!.galones} ${b.combustible!.unidad}`);
    expect(cantidades).toContain("70 L");
  });

  it("sin unidad (cola sin señal de antes del cambio) son galones", async () => {
    const antesL = await litrosDeLaUnidad();
    const r = await admin.post("/api/erp/combustible/compras-ruta").send(cuerpo({ cantidad: 10 }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await litrosDeLaUnidad()) - antesL).toBeCloseTo(10 * LITROS_POR_GALON, 2);
    const h = await admin.get("/api/erp/combustible/compras-ruta");
    const cantidades = (h.body as { combustible: { galones: number; unidad: string } | null }[])
      .filter((b) => b.combustible)
      .map((b) => `${b.combustible!.galones} ${b.combustible!.unidad}`);
    expect(cantidades).toContain("10 gal");
  });

  it("el reintento con el mismo uuid no duplica, aunque llegue con otra unidad: queda la primera", async () => {
    const body = cuerpo({ cantidad: 25, unidad: "L" });
    const antesL = await litrosDeLaUnidad();
    expect((await admin.post("/api/erp/combustible/compras-ruta").send(body)).status).toBe(201);
    const otra = await admin
      .post("/api/erp/combustible/compras-ruta")
      .send({ ...body, combustible: { ...body.combustible, unidad: "gal" } });
    expect(otra.status, JSON.stringify(otra.body)).toBe(200);
    expect((await litrosDeLaUnidad()) - antesL).toBeCloseTo(25, 2);
    const h = await admin.get("/api/erp/combustible/compras-ruta");
    const fila = (
      h.body as {
        comprobante_numero: string;
        combustible: { galones: number; unidad: string } | null;
      }[]
    ).find((b) => b.comprobante_numero === body.comprobante_numero);
    expect(`${fila?.combustible?.galones} ${fila?.combustible?.unidad}`).toBe("25 L");
  });

  it("un despacho directo sin cantidad_unidad (queda NULL) son galones; con 'L', litros", async () => {
    const despacho = (extra: Record<string, unknown>) =>
      admin.post("/api/erp/combustible/despachos").send({
        origen: "compra_externa",
        grifo_id: grifo,
        producto: "combustible",
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipoId,
        comprobante_tipo: "boleta",
        comprobante_numero: idUnico("D"),
        cantidad: 10,
        costo_unitario: 4.5,
        lectura_odometro: (odometro += 10),
        horas_abastecidas: 5,
        despachado_en: new Date(Date.now() - 3_600_000).toISOString(),
        ...extra,
      });
    const base = await litrosDeLaUnidad();
    const sinUnidad = await despacho({});
    expect(sinUnidad.status, JSON.stringify(sinUnidad.body)).toBe(201);
    expect(sinUnidad.body.cantidad_unidad ?? null).toBeNull();
    const despues = await litrosDeLaUnidad();
    expect(despues - base).toBeCloseTo(10 * LITROS_POR_GALON, 2);
    const enLitros = await despacho({ cantidad_unidad: "L" });
    expect(enLitros.status, JSON.stringify(enLitros.body)).toBe(201);
    expect((await litrosDeLaUnidad()) - despues).toBeCloseTo(10, 2);
  });

  it("la base rechaza una unidad en un despacho que no es compra externa de combustible", async () => {
    const u = await admin.post("/api/erp/combustible/compras-ruta").send({
      ...cuerpo({ cantidad: 1 }),
      combustible: undefined,
      urea: { lineas: [{ presentacion: "bolsa", cantidad_bultos: 1, costo_unitario: 30 }] },
    });
    // Sin urea sembrada en este tenant puede no existir el envase: la prueba solo
    // vale con una fila de urea, así que si no se pudo crear se avisa y se corta.
    expect(u.status, `no se pudo crear la urea de prueba: ${JSON.stringify(u.body)}`).toBe(201);
    await expect(
      withTenant(tenantId, (c) =>
        c.query(
          `UPDATE combustible_despachos SET cantidad_unidad = 'L'
            WHERE id = (SELECT id FROM combustible_despachos
                         WHERE tenant_id = $1 AND producto = 'urea' LIMIT 1)`,
          [tenantId]
        )
      )
    ).rejects.toThrow(/cantidad_unidad_check/);
  });

  it("una unidad inválida da 400, no 500", async () => {
    const r = await admin
      .post("/api/erp/combustible/compras-ruta")
      .send(cuerpo({ cantidad: 5, unidad: "galon" }));
    expect(r.status).toBe(400);
  });

  it("la unidad no se acepta fuera de la compra externa de combustible", async () => {
    const r = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: 1,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: "S1",
      n_vale: 1,
      cantidad: 5,
      cantidad_unidad: "L",
      lectura_contometro: 5,
      costo_unitario: 4,
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("cantidad_unidad");
  });
});
