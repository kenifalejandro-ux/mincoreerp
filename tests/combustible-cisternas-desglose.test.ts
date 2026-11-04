/** tests/combustible-cisternas-desglose.test.ts
 *
 * La tarjeta de la cisterna cuenta la historia de la recepción: cuánto dejó el proveedor en total,
 * cuánto entró al tanque, adónde fue el sobrante y el kardex de lo que quedó en la cisterna, con el
 * saldo después de cada fila. Nada de eso mueve el kardex del tanque: ahí solo entra lo que cupo.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const BASE = "/api/erp/combustible";

interface Movimiento {
  tipo: string;
  cantidad: string;
  destino: string | null;
  saldo: number;
}
interface LineaDeReparto {
  destino: string;
  cantidad: string;
  destino_nombre: string | null;
}
interface Cisterna {
  id: string;
  recepcion_id: string;
  cantidad: string;
  saldo: string;
  al_tanque: string;
  entregado: string;
  reparto: LineaDeReparto[];
  movimientos: Movimiento[];
}

describe("combustible: desglose y kardex de la cisterna", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let proveedor: number;
  let principal: number;
  let nVale = 9000;
  let seq = 0;

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

  const lista = async (estado: "saldo" | "historial"): Promise<Cisterna[]> =>
    (await admin.get(`${BASE}/despachos/cisternas?estado=${estado}`)).body;

  /** Tanque con 500 de espacio: llegan 1200, 500 entran y 700 se reparten. */
  async function recepcionConSobrante() {
    const tq = await tanque(2000, 1500);
    const tanqueta = (await admin.post(`${BASE}/tanquetas`).send({ grifo_interno_id: principal }))
      .body;
    const rec = await admin.post(`${BASE}/recepciones`).send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad: 1200,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [
        { destino: "cisterna", cantidad: 400 },
        { destino: "cubeta", cantidad: 200, tanqueta_id: Number(tanqueta.id) },
        { destino: "devolucion", cantidad: 100 },
      ],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const c = (await lista("saldo")).find((x) => Number(x.recepcion_id) === Number(rec.body.id))!;
    expect(c).toBeDefined();
    return { recepcionId: Number(rec.body.id), cisterna: c, tanqueta, tanqueId: tq };
  }

  async function aUnidad(lineaId: number, cantidad: number) {
    const equipo = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: principal,
    });
    const r = await admin.post(`${BASE}/despachos`).send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo.body.id,
      serie_talonario: "DSG",
      n_vale: nVale++,
      cantidad,
      lectura_horometro: 100 + seq++,
      costo_unitario: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  async function aTanqueta(lineaId: number, cantidad: number) {
    const t = (await admin.post(`${BASE}/tanquetas`).send({ grifo_interno_id: principal })).body;
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
    return r.body.id as string;
  }

  it("dice cuánto dejó el proveedor, cuánto entró al tanque y adónde fue el sobrante", async () => {
    const { cisterna, tanqueta } = await recepcionConSobrante();
    expect(Number(cisterna.entregado)).toBe(1200);
    expect(Number(cisterna.al_tanque)).toBe(500);
    const reparto = new Map(cisterna.reparto.map((l) => [l.destino, l]));
    expect(Number(reparto.get("cisterna")!.cantidad)).toBe(400);
    expect(Number(reparto.get("cubeta")!.cantidad)).toBe(200);
    expect(reparto.get("cubeta")!.destino_nombre).toBe(tanqueta.codigo);
    expect(Number(reparto.get("devolucion")!.cantidad)).toBe(100);
    // Lo que entró al tanque más todo el reparto es exactamente lo entregado.
    const sobrante = cisterna.reparto.reduce((s, l) => s + Number(l.cantidad), 0);
    expect(Number(cisterna.al_tanque) + sobrante).toBe(Number(cisterna.entregado));
  });

  it("el kardex de la cisterna lleva el saldo después de cada fila y cierra en lo que queda", async () => {
    const { recepcionId, cisterna } = await recepcionConSobrante();
    await aTanqueta(Number(cisterna.id), 100);
    await aUnidad(Number(cisterna.id), 50);
    const c = (await lista("saldo")).find((x) => Number(x.recepcion_id) === recepcionId)!;
    expect(c.movimientos.map((m) => [m.tipo, Number(m.cantidad), m.saldo])).toEqual([
      ["entrada", 400, 400],
      ["tanqueta", 100, 300],
      ["unidad", 50, 250],
    ]);
    expect(c.movimientos.at(-1)!.saldo).toBe(Number(c.saldo));
  });

  it("una salida anulada sale del kardex y los saldos se recalculan", async () => {
    const { recepcionId, cisterna } = await recepcionConSobrante();
    const primera = await aTanqueta(Number(cisterna.id), 100);
    await aUnidad(Number(cisterna.id), 50);
    const a = await admin
      .patch(`${BASE}/despachos/${primera}/anular`)
      .send({ motivo: "se cargó a otra tanqueta" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const c = (await lista("saldo")).find((x) => Number(x.recepcion_id) === recepcionId)!;
    expect(c.movimientos.map((m) => [m.tipo, m.saldo])).toEqual([
      ["entrada", 400],
      ["unidad", 350],
    ]);
  });

  it("una cisterna vaciada, en el historial, termina su kardex en cero", async () => {
    const { recepcionId, cisterna } = await recepcionConSobrante();
    await aTanqueta(Number(cisterna.id), 250);
    await aTanqueta(Number(cisterna.id), 150);
    const c = (await lista("historial")).find((x) => Number(x.recepcion_id) === recepcionId)!;
    expect(c).toBeDefined();
    expect(c.movimientos.at(-1)!.saldo).toBe(0);
    expect(Number(c.entregado)).toBe(1200);
  });

  it("el sobrante no entra al kardex del tanque: ahí solo está lo que cupo", async () => {
    const { tanqueId } = await recepcionConSobrante();
    const hoy = new Date();
    const desde = new Date(hoy.getTime() - 86_400_000).toISOString();
    const hasta = new Date(hoy.getTime() + 86_400_000).toISOString();
    const k = await admin.get(`${BASE}/${tanqueId}/kardex`).query({ desde, hasta });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    const entradas = (k.body.filas ?? k.body.movimientos ?? k.body.data ?? []).filter(
      (f: { tipo: string }) => f.tipo === "recepcion"
    );
    expect(entradas.map((f: { entrada: string }) => Number(f.entrada))).toEqual([500]);
  });
});
