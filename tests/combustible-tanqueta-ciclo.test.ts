/** tests/combustible-tanqueta-ciclo.test.ts
 *
 * El ciclo de la tanqueta (migración 0114):
 *   3c. se llena desde el tanque con un vale a "reserva en cubeta" que dice a
 *       cuál tanqueta (descuenta del tanque, suma a la tanqueta);
 *   3b. el conductor carga en ruta desde ella con el medidor de la unidad
 *       (no toca el tanque, resta de la tanqueta, cuesta lo que entró).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

describe("combustible: tanqueta llenada desde el tanque y descargada en ruta (0114)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let conductor: Agente;
  let grifero: Agente;
  let principal: number;
  let otroGrifo: number;
  let volquete: number;
  let seq = 0;
  let nVale = 1;

  async function conRol(rol: string): Promise<Agente> {
    const agente = request.agent(app);
    const dni = String(87500000 + Math.floor(Math.random() * 400000) + seq++);
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
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    principal = sedes[0].grifos[0].id;
    otroGrifo = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: idUnico("Grifo") })
    ).body.id;
    volquete = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    conductor = await conRol("conductor_ruta");
    grifero = await conRol("grifero");
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(extra: Record<string, unknown> = {}) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Huamachuco",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 8000,
      requiere_documento: false,
      grifo_interno_id: principal,
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  async function tanqueta(grifo = principal) {
    const r = await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: grifo });
    expect(r.status).toBe(201);
    return Number(r.body.id);
  }

  const llenar = (tanqueId: number, tanquetaId: number, cantidad: number) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tanquetaId,
      serie_talonario: "HMC",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });

  const cargarEnRuta = (
    ag: Agente,
    tanquetaId: number,
    cantidad: number,
    extra: Record<string, unknown> = {}
  ) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanqueta",
      tanqueta_origen_id: tanquetaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: volquete,
      cantidad,
      lectura_horometro: 1000 + seq++ * 10,
      ...extra,
    });

  const saldo = async (id: number) => {
    const r = await admin.get("/api/erp/combustible/tanquetas");
    return Number(r.body.find((t: { id: string }) => Number(t.id) === id).saldo);
  };
  const nivelTeorico = async (id: number) =>
    Number((await admin.get(`/api/erp/combustible/${id}`)).body.nivel_teorico);

  it("3c: el vale a reserva llena la tanqueta y descuenta del tanque", async () => {
    const tq = await tanque();
    const tqt = await tanqueta();
    const antes = await nivelTeorico(tq);
    const r = await llenar(tq, tqt, 280);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number(r.body.tanqueta_destino_id)).toBe(tqt);
    expect(await saldo(tqt)).toBe(280);
    expect(await nivelTeorico(tq)).toBe(antes - 280);
  });

  it("3c: no entra más que su espacio, ni desde otra sede, ni desde un tanque en litros", async () => {
    const tq = await tanque();
    const tqt = await tanqueta();
    expect((await llenar(tq, tqt, 200)).status).toBe(201);
    const pasada = await llenar(tq, tqt, 100);
    expect(pasada.status).toBe(400);
    expect(pasada.body.error).toContain("solo tiene 80 gal libres");

    const ajena = await tanqueta(otroGrifo);
    const deOtraSede = await llenar(tq, ajena, 10);
    expect(deOtraSede.status).toBe(400);
    expect(deOtraSede.body.error).toContain("otra sede");

    const enLitros = await tanque({ unidad: "L", capacidad_total: 20000, nivel_actual: 10000 });
    const r = await llenar(enLitros, await tanqueta(), 10);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("galones");
  });

  it("3b: el conductor carga en ruta: resta de la tanqueta, no del tanque, y cuesta lo que entró", async () => {
    const tq = await tanque();
    const tqt = await tanqueta();
    await llenar(tq, tqt, 280);
    const nivel = await nivelTeorico(tq);

    const r = await cargarEnRuta(conductor, tqt, 100);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.origen).toBe("tanqueta");
    expect(r.body.combustible_id).toBeNull();
    expect(Number(r.body.costo_unitario)).toBe(16);
    expect(await saldo(tqt)).toBe(180);
    expect(await nivelTeorico(tq)).toBe(nivel);

    const historial = await admin.get(`/api/erp/combustible/tanquetas/${tqt}/historial`);
    expect(historial.status).toBe(200);
    const tipos = historial.body.map((m: { tipo: string }) => m.tipo);
    expect(tipos).toContain("prevision");
    expect(tipos).toContain("carga_ruta");

    const formulario = await conductor.get("/api/erp/combustible/tanquetas/formulario");
    expect(formulario.status).toBe(200);
    expect(formulario.body.find((t: { id: number }) => t.id === tqt)).toMatchObject({
      saldo: 180,
      libre: 100,
    });
  });

  it("3b: exige el medidor de la unidad y no admite vale ni tanque", async () => {
    const tqt = await tanqueta();
    expect((await cargarEnRuta(conductor, tqt, 10, { lectura_horometro: undefined })).status).toBe(
      400
    );
    expect(
      (await cargarEnRuta(conductor, tqt, 10, { serie_talonario: "X", n_vale: 5 })).status
    ).toBe(400);
    const tq = await tanque();
    expect((await cargarEnRuta(conductor, tqt, 10, { combustible_id: tq })).status).toBe(400);
  });

  it("3b: el grifero no registra cargas en ruta", async () => {
    const tqt = await tanqueta();
    expect((await cargarEnRuta(grifero, tqt, 10)).status).toBe(403);
  });

  it("3b: cargar más de lo que tenía no bloquea, pero deja la alerta de sobregiro", async () => {
    const tq = await tanque();
    const tqt = await tanqueta();
    await llenar(tq, tqt, 100);
    const r = await cargarEnRuta(conductor, tqt, 150);
    expect(r.status).toBe(201);
    expect(await saldo(tqt)).toBe(-50);
    const alertas = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 100 });
    const alerta = alertas.body.data.find(
      (a: { tipo: string; despacho_id: number }) =>
        a.tipo === "tanqueta_sobregirada" && Number(a.despacho_id) === Number(r.body.id)
    );
    expect(alerta).toBeDefined();
    expect(alerta.detalle.saldo).toBe(-50);
  });

  it("anular la carga en ruta devuelve el saldo; anular el vale de reserva lo quita", async () => {
    const tq = await tanque();
    const tqt = await tanqueta();
    const lleno = await llenar(tq, tqt, 200);
    const carga = await cargarEnRuta(conductor, tqt, 50);
    expect(await saldo(tqt)).toBe(150);
    await admin
      .patch(`/api/erp/combustible/despachos/${carga.body.id}/anular`)
      .send({ motivo: "mal cargada" });
    expect(await saldo(tqt)).toBe(200);
    await admin
      .patch(`/api/erp/combustible/despachos/${lleno.body.id}/anular`)
      .send({ motivo: "mal cargado" });
    expect(await saldo(tqt)).toBe(0);
  });
});
