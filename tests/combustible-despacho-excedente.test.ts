/** tests/combustible-despacho-excedente.test.ts
 *
 * El excedente cargado directo de la cisterna a una unidad (0112): queda
 * PENDIENTE y se regulariza con un despacho de origen 'excedente_recepcion'
 * que lleva vale y medidor, cuesta lo de la factura, y NO descuenta del
 * tanque (ese combustible nunca entró a él).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

describe("combustible: despacho del excedente directo a unidades (0112)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let proveedor: number;
  let seq = 0;

  async function conRol(rol: string): Promise<Agente> {
    const agente = request.agent(app);
    const dni = String(88100000 + Math.floor(Math.random() * 800000) + seq++);
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
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function equipo() {
    const r = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "EXCAVADORA", tipo_medidor: "horometro" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  /** Tanque lleno y flexible, y una recepción de 240 que va entera a la
   *  unidad. Devuelve lo que hace falta para despacharla. */
  async function excedentePendiente() {
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
    });
    expect(t.status).toBe(201);
    const equipoId = await equipo();
    const rec = await admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: t.body.id,
      grifo_id: proveedor,
      cantidad: 240,
      costo_unitario: 17.25,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "equipo", cantidad: 240, equipo_id: equipoId }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const pendientes = await admin.get("/api/erp/combustible/despachos/excedentes-pendientes");
    const linea = pendientes.body.find(
      (p: { recepcion_id: string }) => Number(p.recepcion_id) === Number(rec.body.id)
    );
    expect(linea).toBeDefined();
    return { tanqueId: t.body.id as number, equipoId, recepcionId: rec.body.id, linea };
  }

  const vale = (
    ag: Agente,
    lineaId: number,
    equipoId: number,
    extra: Record<string, unknown> = {}
  ) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: "EXC",
      n_vale: 1000 + seq++,
      cantidad: 240,
      lectura_horometro: 500 + seq,
      costo_unitario: 1,
      ...extra,
    });

  const nivelTeorico = async (id: number) =>
    Number((await admin.get(`/api/erp/combustible/${id}`)).body.nivel_teorico);

  it("el despacho regulariza el pendiente, cuesta lo de la factura y NO descuenta del tanque", async () => {
    const { tanqueId, equipoId, linea } = await excedentePendiente();
    expect(Number(linea.cantidad)).toBe(240);
    expect(linea.unidad).toBe("gal");
    const antes = await nivelTeorico(tanqueId);

    const r = await vale(admin, Number(linea.id), equipoId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.origen).toBe("excedente_recepcion");
    expect(r.body.combustible_id).toBeNull();
    expect(Number(r.body.tanque_excedente_id)).toBe(tanqueId);
    // El costo lo pone el servidor desde la factura, no el body (que mandó 1).
    expect(Number(r.body.costo_unitario)).toBe(17.25);

    expect(await nivelTeorico(tanqueId)).toBe(antes);

    const pendientes = await admin.get("/api/erp/combustible/despachos/excedentes-pendientes");
    expect(pendientes.body.some((p: { id: string }) => p.id === linea.id)).toBe(false);

    // Aparece en el historial de despachos propios, no en el de compras.
    const propios = await admin
      .get("/api/erp/combustible/despachos")
      .query({ origen: "tanque_propio", pageSize: 100 });
    const fila = propios.body.data.find((d: { id: string }) => d.id === r.body.id);
    expect(fila).toBeDefined();
    // El historial dice de qué tanque vino el excedente (sin descontarle nada).
    expect(fila.tanque_excedente_codigo).toBeTruthy();
    const compras = await admin
      .get("/api/erp/combustible/despachos")
      .query({ origen: "compra_externa", pageSize: 100 });
    expect(compras.body.data.some((d: { id: string }) => d.id === r.body.id)).toBe(false);
  });

  it("un pendiente no se despacha dos veces", async () => {
    const { equipoId, linea } = await excedentePendiente();
    expect((await vale(admin, Number(linea.id), equipoId)).status).toBe(201);
    const otra = await vale(admin, Number(linea.id), equipoId);
    expect(otra.status).toBe(400);
    expect(otra.body.error).toContain("no está pendiente");
  });

  it("la unidad, la cantidad y el combustible tienen que coincidir con el pendiente", async () => {
    const { equipoId, linea } = await excedentePendiente();
    const otroEquipo = await equipo();
    expect((await vale(admin, Number(linea.id), otroEquipo)).status).toBe(400);
    expect((await vale(admin, Number(linea.id), equipoId, { cantidad: 200 })).status).toBe(400);
    expect(
      (await vale(admin, Number(linea.id), equipoId, { tipo_combustible: "gasolina_90" })).status
    ).toBe(400);
  });

  it("no admite campos de tanque (contómetro, combustible_id) y exige vale", async () => {
    const { tanqueId, equipoId, linea } = await excedentePendiente();
    expect(
      (await vale(admin, Number(linea.id), equipoId, { combustible_id: tanqueId })).status
    ).toBe(400);
    expect(
      (await vale(admin, Number(linea.id), equipoId, { lectura_contometro: 240 })).status
    ).toBe(400);
    expect(
      (await vale(admin, Number(linea.id), equipoId, { serie_talonario: undefined })).status
    ).toBe(400);
  });

  it("el grifero lo puede registrar; el conductor de ruta no", async () => {
    const { equipoId, linea } = await excedentePendiente();
    const conductor = await conRol("conductor_ruta");
    expect((await vale(conductor, Number(linea.id), equipoId)).status).toBe(403);
    const grifero = await conRol("grifero");
    const r = await vale(grifero, Number(linea.id), equipoId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("anular la recepción con su excedente despachado se bloquea; anulado el vale, vuelve a pendiente", async () => {
    const { recepcionId, equipoId, linea } = await excedentePendiente();
    const d = await vale(admin, Number(linea.id), equipoId);
    expect(d.status).toBe(201);

    const bloqueada = await admin
      .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
      .send({ motivo: "error" });
    expect(bloqueada.status).toBe(409);

    const anulado = await admin
      .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
      .send({ motivo: "vale mal cargado" });
    expect(anulado.status).toBe(200);
    const pendientes = await admin.get("/api/erp/combustible/despachos/excedentes-pendientes");
    expect(pendientes.body.some((p: { id: string }) => p.id === linea.id)).toBe(true);

    // Y ahora sí se puede anular la recepción; el pendiente desaparece.
    const ok = await admin
      .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
      .send({ motivo: "error" });
    expect(ok.status).toBe(200);
    const despues = await admin.get("/api/erp/combustible/despachos/excedentes-pendientes");
    expect(despues.body.some((p: { id: string }) => p.id === linea.id)).toBe(false);
  });

  it("el vale usa la misma secuencia del talonario: un número repetido da 409", async () => {
    const a = await excedentePendiente();
    const b = await excedentePendiente();
    const n = 90000 + seq++;
    expect(
      (await vale(admin, Number(a.linea.id), a.equipoId, { n_vale: n, serie_talonario: "DUP" }))
        .status
    ).toBe(201);
    expect(
      (await vale(admin, Number(b.linea.id), b.equipoId, { n_vale: n, serie_talonario: "DUP" }))
        .status
    ).toBe(409);
  });
});
