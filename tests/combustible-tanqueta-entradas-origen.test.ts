/** tests/combustible-tanqueta-entradas-origen.test.ts
 *
 * La tarjeta de la tanqueta dice de dónde entró lo que tiene: "del tanque" (reserva en cubeta,
 * sale de un tanque y está en su kardex), "de la cisterna" (el sobrante que la recepción mandó
 * directo y lo repartido después desde la cisterna: nunca pasó por un tanque) y "de otra
 * tanqueta". Las tres cifras tienen que sumar lo que la tanqueta tiene, y anular una salida
 * devuelve su parte.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const BASE = "/api/erp/combustible";

interface FilaTanqueta {
  id: string;
  saldo: string;
  libre: string;
  entradas: string;
  entradas_prevision: string;
  entradas_cisterna: string;
  entradas_traslado: string;
}

describe("combustible: de dónde entró lo que tiene la tanqueta", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let proveedor: number;
  let principal: number;
  let nVale = 7000;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    proveedor = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("PROV") })).body.id;
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(capacidad: number, nivel: number) {
    const r = await admin.post(BASE).send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque Cancha",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  async function tanqueta() {
    const r = await admin.post(`${BASE}/tanquetas`).send({ grifo_interno_id: principal });
    expect(r.status).toBe(201);
    return Number(r.body.id);
  }

  const ver = async (id: number): Promise<FilaTanqueta> =>
    (await admin.get(`${BASE}/tanquetas`)).body.find((t: FilaTanqueta) => Number(t.id) === id);

  const cifras = (t: FilaTanqueta) => ({
    tanque: Number(t.entradas_prevision),
    cisterna: Number(t.entradas_cisterna),
    otra: Number(t.entradas_traslado),
  });

  /** Reserva en cubeta: sale de un tanque con nivel y entra a la tanqueta. */
  async function deTanque(tanquetaId: number, cantidad: number) {
    const tq = await tanque(10000, 8000);
    const r = await admin.post(`${BASE}/despachos`).send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tanquetaId,
      serie_talonario: "OEN",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  /** Una recepción con el tanque lleno: todo lo recibido es sobrante y queda en la cisterna. */
  async function lineaDeCisterna(cantidad: number) {
    const tq = await tanque(2000, 2000);
    const rec = await admin.post(`${BASE}/recepciones`).send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "cisterna", cantidad }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const saldos = await admin.get(`${BASE}/despachos/cisternas?estado=saldo`);
    const c = saldos.body.find(
      (x: { recepcion_id: string }) => x.recepcion_id === String(rec.body.id)
    );
    expect(c).toBeDefined();
    return Number(c.id);
  }

  async function deCisterna(tanquetaId: number, lineaId: number, cantidad: number) {
    const r = await admin.post(`${BASE}/despachos`).send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tanquetaId,
      cantidad,
      costo_unitario: 1,
      cliente_uuid: randomUUID(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  /** El sobrante de la misma recepción mandado directo a la tanqueta (sin pasar por la cisterna). */
  async function sobranteDirecto(tanquetaId: number, cantidad: number) {
    const tq = await tanque(2000, 2000);
    const r = await admin.post(`${BASE}/recepciones`).send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "cubeta", cantidad, tanqueta_id: tanquetaId }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  it("lo que sale de un tanque cuenta como 'del tanque', no como de la cisterna", async () => {
    const t = await tanqueta();
    await deTanque(t, 100);
    const fila = await ver(t);
    expect(cifras(fila)).toEqual({ tanque: 100, cisterna: 0, otra: 0 });
    expect(Number(fila.saldo)).toBe(100);
  });

  it("lo repartido desde la cisterna cuenta como 'de la cisterna', no como del tanque", async () => {
    const t = await tanqueta();
    const linea = await lineaDeCisterna(500);
    await deCisterna(t, linea, 80);
    const fila = await ver(t);
    expect(cifras(fila)).toEqual({ tanque: 0, cisterna: 80, otra: 0 });
    expect(Number(fila.saldo)).toBe(80);
  });

  it("el sobrante mandado directo en la recepción también es 'de la cisterna'", async () => {
    const t = await tanqueta();
    await sobranteDirecto(t, 60);
    const fila = await ver(t);
    expect(cifras(fila)).toEqual({ tanque: 0, cisterna: 60, otra: 0 });
  });

  it("las cifras suman lo que la tanqueta tiene, y el saldo y el espacio libre no cambian", async () => {
    const t = await tanqueta();
    await deTanque(t, 100);
    await deCisterna(t, await lineaDeCisterna(500), 80);
    await sobranteDirecto(t, 50);
    const fila = await ver(t);
    const c = cifras(fila);
    expect(c).toEqual({ tanque: 100, cisterna: 130, otra: 0 });
    expect(c.tanque + c.cisterna + c.otra).toBe(Number(fila.entradas));
    expect(Number(fila.saldo)).toBe(230);
    expect(Number(fila.libre)).toBe(280 - 230);
  });

  it("una salida anulada de la cisterna devuelve su parte; la de un tanque, la suya", async () => {
    const t = await tanqueta();
    const vale = await deTanque(t, 100);
    const salida = await deCisterna(t, await lineaDeCisterna(500), 80);

    const a = await admin
      .patch(`${BASE}/despachos/${salida}/anular`)
      .send({ motivo: "se cargó a otra tanqueta" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(cifras(await ver(t))).toEqual({ tanque: 100, cisterna: 0, otra: 0 });

    const b = await admin
      .patch(`${BASE}/despachos/${vale}/anular`)
      .send({ motivo: "vale mal cargado" });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const fila = await ver(t);
    expect(cifras(fila)).toEqual({ tanque: 0, cisterna: 0, otra: 0 });
    expect(Number(fila.saldo)).toBe(0);
  });

  it("una recepción anulada con sobrante directo a la tanqueta devuelve su parte", async () => {
    const t = await tanqueta();
    const recepcion = await sobranteDirecto(t, 60);
    const a = await admin
      .patch(`${BASE}/recepciones/${recepcion}/anular`)
      .send({ motivo: "guía equivocada" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(cifras(await ver(t))).toEqual({ tanque: 0, cisterna: 0, otra: 0 });
  });
});
