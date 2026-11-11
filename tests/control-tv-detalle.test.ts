/** tests/control-tv-detalle.test.ts
 *
 * GET /api/erp/viajes/control-tv/detalle (pestaña «Detalle» del Control TV): lo que llegó a unidades
 * contra el período anterior, la compra en ruta con su sobrecosto, las últimas recepciones contra su
 * factura, la urea del período, el permiso y que sin Combustible responda vacío.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

type Agente = ReturnType<typeof request.agent>;

const PASSWORD = "ClaveDePrueba123";
const URL = "/api/erp/viajes/control-tv/detalle";
const H = 3_600_000;

describe("control TV: detalle", () => {
  const tenants: string[] = [];
  let slug: string;
  let admin: Agente;
  let principal: number;
  let tanque: number;
  let equipo: number;
  let proveedor: number;
  let nVale = 1;

  const vale = (extra: Record<string, unknown>, cantidad: number, costo: number, hace = 0) =>
    admin.post("/api/erp/combustible/despachos").send({
      tipo_combustible: "diesel_b5",
      serie_talonario: "DT",
      n_vale: nVale++,
      cantidad,
      costo_unitario: costo,
      despachado_en: new Date(Date.now() - hace * H).toISOString(),
      ...extra,
    });

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(PASSWORD);
    tenants.push(creado.tenant.id);
    slug = creado.tenant.slug;
    admin = request.agent(app);
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password: PASSWORD })
      .expect(200);
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const tq = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque detalle",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: principal,
    });
    expect(tq.status, JSON.stringify(tq.body)).toBe(201);
    tanque = tq.body.id;
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VD"),
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: principal,
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    equipo = Number(eq.body.id);
    const pr = await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("GRIFO") });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    proveedor = pr.body.id;
  });

  afterAll(async () => {
    for (const id of tenants) await borrarTenantDePrueba(id);
    await closeDatabase();
  });

  it("trae el consumo anterior, la compra en ruta con su sobrecosto y las últimas recepciones", async () => {
    // Interno: 20 gal a S/ 16 ahora. En el período anterior (hace 30 h): 10 gal.
    const interno = await vale(
      {
        origen: "tanque_propio",
        combustible_id: tanque,
        tipo_destino: "equipo",
        equipo_id: equipo,
        medidor: 10,
        lectura_contometro: 20,
      },
      20,
      16
    );
    expect(interno.status, JSON.stringify(interno.body)).toBe(201);
    const anterior = await vale(
      {
        origen: "tanque_propio",
        combustible_id: tanque,
        tipo_destino: "equipo",
        equipo_id: equipo,
        medidor: 5,
        lectura_contometro: 10,
      },
      10,
      16,
      30
    );
    expect(anterior.status, JSON.stringify(anterior.body)).toBe(201);
    // Compra en ruta: 10 gal a S/ 18 → paga 2 soles de más por galón contra el interno.
    const ruta = await vale(
      {
        origen: "compra_externa",
        grifo_id: proveedor,
        tipo_destino: "equipo",
        equipo_id: equipo,
        lectura_horometro: 12,
        horas_abastecidas: 1,
      },
      10,
      18
    );
    expect(ruta.status, JSON.stringify(ruta.body)).toBe(201);
    // Una recepción de 500 gal.
    const rec = await admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanque,
      grifo_id: proveedor,
      cantidad: 500,
      costo_unitario: 16.5,
      tipo_documento: "factura",
      numero_documento: "F001-77",
      recibido_en: new Date().toISOString(),
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);

    const r = await admin.get(`${URL}?periodo=24h`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.consumo_anterior_gal).toBeCloseTo(10, 2);
    expect(r.body.compra_ruta.gal).toBeCloseTo(10, 2);
    expect(r.body.compra_ruta.compras).toBe(1);
    expect(r.body.compra_ruta.precio_interno_gal).toBeCloseTo(16, 2);
    expect(r.body.compra_ruta.sobrecosto).toBeCloseTo(20, 2);
    expect(r.body.compra_ruta.por_grifo[0].precio_gal).toBeCloseTo(18, 2);
    expect(r.body.recepciones).toHaveLength(1);
    expect(r.body.recepciones[0]).toMatchObject({ factura: "F001-77" });
    expect(r.body.recepciones[0].recibido_gal).toBeCloseTo(500, 2);
    expect(r.body.recepciones[0].tolerancia_gal).toBe(3);
    expect(Array.isArray(r.body.desvios)).toBe(true);
    // La duración de los viajes cerrados (para el histograma del Resumen): una lista de horas.
    expect(Array.isArray(r.body.duraciones_h)).toBe(true);
    expect(r.body.urea.total.l).toBe(0);
    expect(r.body.urea.serie).toHaveLength(24);
  });

  it("7 y 30 días; un período inválido da 400", async () => {
    expect((await admin.get(`${URL}?periodo=7d`)).body.urea.serie).toHaveLength(7);
    expect((await admin.get(`${URL}?periodo=30d`)).body.urea.serie).toHaveLength(30);
    expect((await admin.get(URL)).body.periodo).toBe("24h");
    expect((await admin.get(`${URL}?periodo=1y`)).status).toBe(400);
  });

  it("lectura lo ve; el operador no; y sin Combustible responde vacío, sin 403", async () => {
    const persona = async (rol: string) => {
      const agente = request.agent(app);
      const dni = String(88700000 + Math.floor(Math.random() * 90000));
      await admin
        .post("/api/erp/usuarios")
        .send({ nombre: `P ${rol}`, dni, password: PASSWORD, rol })
        .expect(201);
      await agente
        .post("/api/auth/login")
        .send({ tenantSlug: slug, identificador: dni, password: PASSWORD });
      return agente;
    };
    expect((await (await persona("lectura")).get(URL)).status).toBe(200);
    expect((await (await persona("operador")).get(URL)).status).toBe(403);

    const otra = await crearTenantDePrueba(PASSWORD);
    tenants.push(otra.tenant.id);
    await request(app)
      .put(`/api/platform/tenants/${otra.tenant.id}/modulos`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "combustible" ? "deshabilitado" : "habilitado",
        })),
      })
      .expect(200);
    const sin = request.agent(app);
    await sin
      .post("/api/auth/login")
      .send({ tenantSlug: otra.tenant.slug, email: otra.usuario.email, password: PASSWORD })
      .expect(200);
    const v = await sin.get(URL);
    expect(v.status).toBe(200);
    expect(v.body).toEqual({});
  });
});
