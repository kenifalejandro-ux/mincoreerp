/** tests/combustible-cisterna.test.ts
 *
 * El excedente que se queda en la cisterna del proveedor (0168): queda como
 * SALDO y se reparte con despachos de origen 'excedente_recepcion', a unidades
 * (con vale y medidor) o a tanquetas (sin unidad no lleva vale). Nunca pasa del
 * saldo, ni con dos vales a la vez, y no toca el tanque.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

interface Cisterna {
  id: string;
  cantidad: string;
  saldo: string;
  recepcion_id: string;
  costo_unitario: string;
  unidad: string;
}

describe("combustible: excedente que se queda en la cisterna (0168)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let proveedor: number;
  let principal: number;
  let seq = 0;
  let nVale = 2000;

  async function conRol(rol: string): Promise<Agente> {
    const agente = request.agent(app);
    const dni = String(88300000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return agente;
  }

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    proveedor = (
      await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("CISTERNA") })
    ).body.id;
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function equipo() {
    const r = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("CI"),
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  const nuevaTanqueta = async () =>
    Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );

  const listar = async (): Promise<Cisterna[]> =>
    (await admin.get("/api/erp/combustible/despachos/cisternas-con-saldo")).body;

  /** Tanque lleno y flexible, y una recepción de 1000 que se queda entera en
   *  la cisterna. */
  async function cisternaConSaldo(cantidad = 1000) {
    const t = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque Cancha",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 2000,
      nivel_actual: 2000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: principal,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const rec = await admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: t.body.id,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "cisterna", cantidad }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const linea = (await listar()).find((c) => Number(c.recepcion_id) === Number(rec.body.id));
    expect(linea).toBeDefined();
    return { tanqueId: t.body.id as number, recepcionId: rec.body.id, lineaId: Number(linea!.id) };
  }

  const aUnidad = (
    ag: Agente,
    lineaId: number,
    equipoId: number,
    cantidad: number,
    extra: Record<string, unknown> = {}
  ) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: "CIS",
      n_vale: nVale++,
      cantidad,
      lectura_horometro: 100 + seq++,
      costo_unitario: 1,
      ...extra,
    });

  const aTanqueta = (
    lineaId: number,
    tanquetaId: number,
    cantidad: number,
    extra: Record<string, unknown> = {}
  ) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tanquetaId,
      cantidad,
      costo_unitario: 1,
      cliente_uuid: randomUUID(),
      ...extra,
    });

  const saldoDe = async (lineaId: number) =>
    Number((await listar()).find((c) => Number(c.id) === lineaId)?.saldo ?? 0);

  const nivelTeorico = async (id: number) =>
    Number((await admin.get(`/api/erp/combustible/${id}`)).body.nivel_teorico);

  it("la recepción deja el saldo en la cisterna, no en el tanque ni como pendiente", async () => {
    const { tanqueId, lineaId } = await cisternaConSaldo();
    expect(await saldoDe(lineaId)).toBe(1000);
    expect(await nivelTeorico(tanqueId)).toBe(2000);
    const pendientes = await admin.get("/api/erp/combustible/despachos/excedentes-pendientes");
    expect(pendientes.body.some((p: { id: string }) => Number(p.id) === lineaId)).toBe(false);
  });

  it("varias salidas a unidades bajan el saldo, cuestan lo de la factura y no tocan el tanque", async () => {
    const { tanqueId, lineaId } = await cisternaConSaldo();
    const unidad = await equipo();

    const r1 = await aUnidad(admin, lineaId, unidad, 300);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.combustible_id).toBeNull();
    expect(Number(r1.body.tanque_excedente_id)).toBe(tanqueId);
    expect(Number(r1.body.costo_unitario)).toBe(16.5);
    expect((await aUnidad(admin, lineaId, unidad, 450)).status).toBe(201);

    expect(await saldoDe(lineaId)).toBe(250);
    expect(await nivelTeorico(tanqueId)).toBe(2000);

    const demas = await aUnidad(admin, lineaId, unidad, 250.5);
    expect(demas.status).toBe(400);
    expect(demas.body.error).toContain("tiene 250");
    // Un número absurdo es un 400, no un 500.
    expect((await aUnidad(admin, lineaId, unidad, 1e20)).status).toBe(400);

    expect((await aUnidad(admin, lineaId, unidad, 250)).status).toBe(201);
    expect((await listar()).some((c) => Number(c.id) === lineaId)).toBe(false);
    const vacia = await aUnidad(admin, lineaId, unidad, 1);
    expect(vacia.status).toBe(400);
    expect(vacia.body.error).toContain("no tiene saldo");
  });

  it("dos vales a la vez no se llevan más de lo que queda", async () => {
    const { lineaId } = await cisternaConSaldo(500);
    const unidad = await equipo();
    const [a, b] = await Promise.all([
      aUnidad(admin, lineaId, unidad, 300),
      aUnidad(admin, lineaId, unidad, 300),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect(await saldoDe(lineaId)).toBe(200);
  });

  it("pasar a una tanqueta suma a su saldo; sin unidad no lleva vale, y el historial nombra la cisterna", async () => {
    const { lineaId } = await cisternaConSaldo();
    const tanqueta = await nuevaTanqueta();

    const r = await aTanqueta(lineaId, tanqueta, 280);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.serie_talonario).toBeNull();
    expect(Number(r.body.costo_unitario)).toBe(16.5);
    expect(await saldoDe(lineaId)).toBe(720);

    const t = (await admin.get("/api/erp/combustible/tanquetas")).body.find(
      (x: { id: string }) => Number(x.id) === tanqueta
    );
    expect(Number(t.saldo)).toBe(280);
    const historial = await admin.get(`/api/erp/combustible/tanquetas/${tanqueta}/historial`);
    const entrada = historial.body.find((m: { id: string }) => m.id === String(r.body.id));
    expect(entrada.tipo).toBe("prevision");
    expect(entrada.tanque_codigo).toContain("la cisterna de");

    // Llena: no entra más que su capacidad.
    const llena = await aTanqueta(lineaId, tanqueta, 1);
    expect(llena.status).toBe(400);
    expect(llena.body.error).toContain("la tanqueta");
  });

  it("a una tanqueta con unidad exige vale; sin vale exige cliente_uuid; nunca medidor", async () => {
    const { lineaId } = await cisternaConSaldo();
    const unidad = await equipo();
    const tanqueta = await nuevaTanqueta();

    expect((await aTanqueta(lineaId, tanqueta, 100, { tanqueta_equipo_id: unidad })).status).toBe(
      400
    );
    expect((await aTanqueta(lineaId, tanqueta, 100, { cliente_uuid: undefined })).status).toBe(400);
    expect((await aTanqueta(lineaId, tanqueta, 100, { lectura_horometro: 50 })).status).toBe(400);

    const conVale = await aTanqueta(lineaId, tanqueta, 100, {
      tanqueta_equipo_id: unidad,
      serie_talonario: "CIS",
      n_vale: nVale++,
    });
    expect(conVale.status, JSON.stringify(conVale.body)).toBe(201);
    expect(await saldoDe(lineaId)).toBe(900);
  });

  it("el excedente directo a una unidad sigue siendo uno solo y no va a una tanqueta", async () => {
    const t = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque Cancha",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 2000,
      nivel_actual: 2000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: principal,
    });
    const unidad = await equipo();
    const rec = await admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: t.body.id,
      grifo_id: proveedor,
      cantidad: 200,
      costo_unitario: 16.5,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "equipo", cantidad: 200, equipo_id: unidad }],
    });
    expect(rec.status).toBe(201);
    const pendiente = (
      await admin.get("/api/erp/combustible/despachos/excedentes-pendientes")
    ).body.find((p: { recepcion_id: string }) => Number(p.recepcion_id) === Number(rec.body.id));

    const tanqueta = await nuevaTanqueta();
    const aTq = await aTanqueta(Number(pendiente.id), tanqueta, 200);
    expect(aTq.status).toBe(400);
    expect(aTq.body.error).toContain("no está en una cisterna");

    const [a, b] = await Promise.all([
      aUnidad(admin, Number(pendiente.id), unidad, 200),
      aUnidad(admin, Number(pendiente.id), unidad, 200),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
  });

  it("el grifero reparte la cisterna; el conductor de ruta y Lectura no", async () => {
    const { lineaId } = await cisternaConSaldo();
    const unidad = await equipo();
    const conductor = await conRol("conductor_ruta");
    expect((await aUnidad(conductor, lineaId, unidad, 100)).status).toBe(403);
    const lectura = await conRol("lectura");
    expect((await aUnidad(lectura, lineaId, unidad, 100)).status).toBe(403);
    expect((await lectura.get("/api/erp/combustible/despachos/cisternas-con-saldo")).status).toBe(
      403
    );
    const grifero = await conRol("grifero");
    const r = await aUnidad(grifero, lineaId, unidad, 100);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("anular la recepción con salidas se bloquea; anulada la salida, el saldo vuelve", async () => {
    const { recepcionId, lineaId } = await cisternaConSaldo();
    const unidad = await equipo();
    const d = await aUnidad(admin, lineaId, unidad, 400);
    expect(d.status).toBe(201);

    const bloqueada = await admin
      .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
      .send({ motivo: "error" });
    expect(bloqueada.status).toBe(409);

    const anulado = await admin
      .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
      .send({ motivo: "vale mal cargado" });
    expect(anulado.status, JSON.stringify(anulado.body)).toBe(200);
    expect(await saldoDe(lineaId)).toBe(1000);

    const ok = await admin
      .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
      .send({ motivo: "error" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await listar()).some((c) => Number(c.id) === lineaId)).toBe(false);
  });
});
