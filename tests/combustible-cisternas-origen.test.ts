/** tests/combustible-cisternas-origen.test.ts
 *
 * Lo que el panel de la cisterna suma a su desglose y su kardex: de dónde viene (documento, quién la
 * registró, transportista), lo que decía el documento contra lo descargado con la tolerancia de la
 * empresa, y en cada movimiento quién lo registró y su vale. Todo aditivo: lo que ya salía sigue igual.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const BASE = "/api/erp/combustible";
const password = "ClaveDePrueba123";

interface Movimiento {
  tipo: string;
  cantidad: string;
  destino: string | null;
  por: string | null;
  vale: string | null;
  saldo: number;
}
interface Cisterna {
  recepcion_id: string;
  id: string;
  saldo: string;
  tipo_documento: string | null;
  numero_documento: string | null;
  registrada_por_nombre: string | null;
  compra_id: string | null;
  transportista: string | null;
  transportista_ruc: string | null;
  compra_cantidad: string | null;
  compra_unidad: string | null;
  diferencia_compra_galones: string | null;
  tolerancia_galones: string | number;
  movimientos: Movimiento[];
}

const hoy = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());

describe("combustible: origen y movimientos de la cisterna", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let proveedor: number;
  let sede: number;
  let documento = 0;
  let nVale = 3000;
  let seq = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    proveedor = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("PROV") })).body.id;
    sede = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(capacidad: number, nivel: number) {
    const r = await admin.post(BASE).send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: sede,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  const lista = async (): Promise<Cisterna[]> =>
    (await admin.get(`${BASE}/despachos/cisternas?estado=saldo`)).body;
  const de = async (recepcionId: number | string) =>
    (await lista()).find((c) => String(c.recepcion_id) === String(recepcionId))!;

  /** Una cisterna con 400 de sobrante; con `compra`, viene de una compra con su documento. */
  async function cisterna(compra?: { cantidad: number; transportista?: string }) {
    const tq = await tanque(1100, 1000);
    let compraId: number | undefined;
    if (compra) {
      const c = await admin.post(`${BASE}/compras-cisterna`).send({
        grifo_interno_id: sede,
        grifo_id: proveedor,
        tipo_combustible: "diesel_b5",
        tipo_documento: "guia_remision",
        numero_documento: `TRR1-${++documento}`,
        fecha_compra: hoy(),
        llegada_estimada: hoy(),
        cantidad_facturada: compra.cantidad,
        costo_unitario: 24.5,
        ...(compra.transportista
          ? { transportista: compra.transportista, transportista_ruc: "20602504655" }
          : {}),
      });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      compraId = Number(c.body.id);
    }
    const rec = await admin.post(`${BASE}/recepciones`).send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad: 500,
      costo_unitario: 24.5,
      ...(compraId
        ? { compra_id: compraId }
        : { tipo_documento: "factura", numero_documento: `F-${++documento}` }),
      reparto_excedente: [{ destino: "cisterna", cantidad: 400 }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    return { recepcionId: Number(rec.body.id), tq };
  }

  async function aUnidad(lineaId: number, cantidad: number) {
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: sede,
    });
    const vale = nVale++;
    const r = await admin.post(`${BASE}/despachos`).send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: eq.body.id,
      serie_talonario: "ORG",
      n_vale: vale,
      cantidad,
      lectura_horometro: 100 + seq++,
      costo_unitario: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return `ORG-${vale}`;
  }

  async function aTanqueta(lineaId: number, cantidad: number) {
    const t = (await admin.post(`${BASE}/tanquetas`).send({ grifo_interno_id: sede })).body;
    const r = await admin.post(`${BASE}/despachos`).send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: Number(t.id),
      cantidad,
      costo_unitario: 1,
      cliente_uuid: randomUUID(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }

  it("una cisterna de una compra trae su documento, quién la registró, el transportista y la diferencia", async () => {
    // Se entregan 500 (100 al tanque y 400 de sobrante); el documento decía 505.
    const { recepcionId } = await cisterna({
      cantidad: 505,
      transportista: "CORPORACION KIME S.A.C.",
    });
    const c = await de(recepcionId);
    expect(c.tipo_documento).toBe("guia_remision");
    expect(c.numero_documento).toMatch(/^TRR1-/);
    expect(c.registrada_por_nombre).toBeTruthy();
    expect(c.transportista).toBe("CORPORACION KIME S.A.C.");
    expect(c.transportista_ruc).toBe("20602504655");
    expect(Number(c.compra_cantidad)).toBe(505);
    expect(c.compra_unidad).toBe("gal");
    expect(Number(c.diferencia_compra_galones)).toBe(-5);
    expect(Number(c.tolerancia_galones)).toBe(3);
  });

  it("sin compra, el documento de la recepción sale pero el transporte y la diferencia vienen vacíos", async () => {
    const { recepcionId } = await cisterna();
    const c = await de(recepcionId);
    expect(c.tipo_documento).toBe("factura");
    expect(c.numero_documento).toMatch(/^F-/);
    expect(c.registrada_por_nombre).toBeTruthy();
    expect(c.compra_id).toBeNull();
    expect(c.transportista).toBeNull();
    expect(c.diferencia_compra_galones).toBeNull();
    expect(c.compra_cantidad).toBeNull();
  });

  it("la tolerancia que viaja es la de la empresa: al cambiarla, cambia", async () => {
    const { recepcionId } = await cisterna({ cantidad: 505 });
    expect(Number((await de(recepcionId)).tolerancia_galones)).toBe(3);
    const fijar = await admin
      .put(`${BASE}/compras-cisterna/tolerancia`)
      .send({ tolerancia_galones: 10 });
    expect(fijar.status, JSON.stringify(fijar.body)).toBe(200);
    try {
      expect(Number((await de(recepcionId)).tolerancia_galones)).toBe(10);
    } finally {
      await admin.put(`${BASE}/compras-cisterna/tolerancia`).send({ tolerancia_galones: 3 });
    }
  });

  it("cada movimiento dice quién lo registró, y las salidas a unidad traen su vale", async () => {
    const { recepcionId, tq } = await cisterna({ cantidad: 900 });
    const c0 = await de(recepcionId);
    const vale = await aUnidad(Number(c0.id), 100);
    await aTanqueta(Number(c0.id), 50);
    // Un pase al tanque (sin vale): otro tanque de la misma sede con espacio.
    const destino = await tanque(1000, 700);
    const pase = await admin.post(`${BASE}/despachos/cisterna-al-tanque`).send({
      cliente_uuid: randomUUID(),
      linea_id: Number(c0.id),
      combustible_id: destino,
      cantidad: 100,
    });
    expect(pase.status, JSON.stringify(pase.body)).toBe(201);
    void tq;

    const c = await de(recepcionId);
    const porTipo = new Map(c.movimientos.map((m) => [m.tipo, m]));
    expect(c.movimientos.map((m) => m.tipo)).toEqual(["entrada", "unidad", "tanqueta", "tanque"]);
    for (const m of c.movimientos) expect(m.por, m.tipo).toBeTruthy();
    expect(porTipo.get("unidad")!.vale).toBe(vale);
    // Sin vale: la entrada, la salida a una tanqueta y el pase al tanque.
    expect(porTipo.get("entrada")!.vale).toBeNull();
    expect(porTipo.get("tanqueta")!.vale).toBeNull();
    expect(porTipo.get("tanque")!.vale).toBeNull();
    // Y el saldo por fila sigue siendo el de siempre.
    expect(c.movimientos.map((m) => m.saldo)).toEqual([400, 300, 250, 150]);
  });

  it("una salida anulada no aparece, y las demás conservan su vale", async () => {
    const { recepcionId } = await cisterna({ cantidad: 900 });
    const c0 = await de(recepcionId);
    await aUnidad(Number(c0.id), 100);
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: sede,
    });
    const vale2 = nVale++;
    const d2 = await admin.post(`${BASE}/despachos`).send({
      origen: "excedente_recepcion",
      excedente_linea_id: Number(c0.id),
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: eq.body.id,
      serie_talonario: "ORG",
      n_vale: vale2,
      cantidad: 60,
      lectura_horometro: 300 + seq++,
      costo_unitario: 1,
    });
    expect(d2.status, JSON.stringify(d2.body)).toBe(201);
    const a = await admin
      .patch(`${BASE}/despachos/${d2.body.id}/anular`)
      .send({ motivo: "vale mal cargado" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const c = await de(recepcionId);
    expect(c.movimientos).toHaveLength(2);
    expect(c.movimientos.map((m) => m.vale)).not.toContain(`ORG-${vale2}`);
  });
});
