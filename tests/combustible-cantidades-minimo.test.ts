/** tests/combustible-cantidades-minimo.test.ts
 *
 * Una cantidad menor a una centésima daba 500: la columna es NUMERIC(14,2) con
 * CHECK (cantidad > 0), Postgres redondeaba 0.004 a 0.00 y el CHECK fallaba. Una
 * cola sin señal reintenta los 5xx, así que ese registro quedaba trabado. Ahora
 * es 400 con su mensaje (y la cola lo descarta).
 *
 * El mínimo es de una centésima y NO "múltiplo de 0.01": lo que ya se aceptaba
 * con 3 decimales (un contómetro de 12.345) se sigue aceptando y se guarda
 * redondeado, como hasta hoy. Acá se vigila las dos cosas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { crearCompraRutaSchema } from "../src/server/schemas/combustible.schema";

describe("combustible: cantidades de al menos una centésima", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let proveedor: number;
  let principal: number;
  let unidad: number;
  let nVale = 5000;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    proveedor = (
      await admin
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("Prov"), abastece_tanque: true })
    ).body.id;
    unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(nivel: number, capacidad: number, flexible = false) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
      nivel_minimo: 100,
      modo_vigilancia: "sin_vigilar",
      requiere_documento: false,
      ...(flexible ? { modo_excedente_recepcion: "flexible" } : {}),
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  const recepcion = (tq: number, cantidad: number, extra: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: 16.5,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: new Date().toISOString(),
      ...extra,
    });

  const valeDelTanque = (tq: number, cantidad: number, contometro = cantidad) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: unidad,
      serie_talonario: "MN",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: contometro,
      lectura_horometro: 100 + nVale,
      costo_unitario: 1,
    });

  it("la cantidad de una recepción: 0.004 y 0.001 son 400; 0.01 pasa", async () => {
    const tq = await tanque(1000, 10000);
    for (const cantidad of [0.004, 0.001]) {
      const r = await recepcion(tq, cantidad);
      expect(r.status, `cantidad ${cantidad}: ${JSON.stringify(r.body)}`).toBe(400);
    }
    expect((await recepcion(tq, 0.01)).status).toBe(201);
  });

  it("una línea del reparto del excedente: 0.004 es 400, no 500", async () => {
    const lleno = await tanque(2000, 2000, true);
    const r = await recepcion(lleno, 100, {
      reparto_excedente: [
        { destino: "cisterna", cantidad: 99.996 },
        { destino: "cisterna", cantidad: 0.004 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    // Y un reparto en centésimas sigue pasando.
    const ok = await recepcion(lleno, 100, {
      reparto_excedente: [
        { destino: "cisterna", cantidad: 99.99 },
        { destino: "cisterna", cantidad: 0.01 },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("el vale del tanque propio: 0.004 es 400; uno de 3 decimales por encima de 0.01 se sigue aceptando", async () => {
    const tq = await tanque(1000, 10000);
    for (const cantidad of [0.004, 0.001]) {
      const r = await valeDelTanque(tq, cantidad);
      expect(r.status, `cantidad ${cantidad}: ${JSON.stringify(r.body)}`).toBe(400);
    }
    // Un contómetro de 3 decimales: no cambia lo que ya se aceptaba (se guarda redondeado).
    const tres = await valeDelTanque(tq, 12.345);
    expect(tres.status, JSON.stringify(tres.body)).toBe(201);
    expect((await valeDelTanque(tq, 0.01)).status).toBe(201);
  });

  it("la salida de la cisterna a una unidad: 0.004 es 400, no 500", async () => {
    const lleno = await tanque(2000, 2000, true);
    const rec = await recepcion(lleno, 500, {
      reparto_excedente: [{ destino: "cisterna", cantidad: 500 }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const linea = (await admin.get("/api/erp/combustible/despachos/cisternas-con-saldo")).body.find(
      (c: { recepcion_id: string }) => Number(c.recepcion_id) === Number(rec.body.id)
    );
    const salida = (cantidad: number) =>
      admin.post("/api/erp/combustible/despachos").send({
        origen: "excedente_recepcion",
        excedente_linea_id: Number(linea.id),
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: unidad,
        serie_talonario: "MS",
        n_vale: nVale++,
        cantidad,
        lectura_horometro: 100 + nVale,
        costo_unitario: 1,
      });
    for (const cantidad of [0.004, 0.001]) {
      const r = await salida(cantidad);
      expect(r.status, `cantidad ${cantidad}: ${JSON.stringify(r.body)}`).toBe(400);
    }
    expect((await salida(0.01)).status).toBe(201);
  });

  it("la boleta de una compra en ruta: la cantidad de combustible debe ser de al menos 0.01", () => {
    const boleta = (cantidad: number) =>
      crearCompraRutaSchema.safeParse({
        cliente_uuid: crypto.randomUUID(),
        grifo_id: 1,
        comprobante_tipo: "boleta",
        comprobante_numero: "B001-1",
        equipo_id: 1,
        combustible: {
          tipo_combustible: "diesel_b5",
          cantidad,
          costo_unitario: 17.5,
          lectura_horometro: 1000,
          horas_abastecidas: 12,
        },
      });
    expect(boleta(0.004).success).toBe(false);
    expect(boleta(0.001).success).toBe(false);
    expect(boleta(0.01).success).toBe(true);
    expect(boleta(40).success).toBe(true);
  });
});
