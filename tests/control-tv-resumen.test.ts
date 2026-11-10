/** tests/control-tv-resumen.test.ts
 *
 * GET /api/erp/viajes/control-tv/resumen (Control TV, la pantalla de la gerencia): la flota por
 * estado, los bloques de Combustible y Urea que solo vienen si la empresa los tiene, que solo lo
 * vean admin y lectura, y que cada empresa vea lo suyo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

type Agente = ReturnType<typeof request.agent>;
type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

const PASSWORD = "ClaveDePrueba123";
const H = 3_600_000;
const T0 = Date.now() - 100 * H;
const hora = (h: number) => new Date(T0 + h * H).toISOString();
const URL = "/api/erp/viajes/control-tv/resumen";

describe("control TV: resumen", () => {
  const tenants: string[] = [];
  let empresa: Empresa;
  let admin: Agente;
  let seq = 0;

  async function entrar(e: Empresa, email: string): Promise<Agente> {
    const a = request.agent(app);
    await a
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD })
      .expect(200);
    return a;
  }

  async function conRol(rol: string): Promise<Agente> {
    const a = request.agent(app);
    const dni = String(87100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password: PASSWORD, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    await a
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, identificador: dni, password: PASSWORD });
    return a;
  }

  const lugar = async (nombre: string) =>
    Number((await admin.post("/api/erp/viajes/lugares").send({ nombre })).body.id);

  async function viajeEnCurso(paradas: number[]): Promise<number> {
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("TV"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: String(41000000 + seq++),
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    const v = await admin
      .post("/api/erp/viajes")
      .send({ equipo_id: eq.body.id, paradas, inicio_en: hora(0) });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    return Number(v.body.id);
  }

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    tenants.push(empresa.tenant.id);
    admin = await entrar(empresa, empresa.usuario.email);
  });

  afterAll(async () => {
    for (const id of tenants) await borrarTenantDePrueba(id);
    await closeDatabase();
  });

  it("cuenta la flota por estado: en ruta, en parada, detenida, retornando; con su tipo", async () => {
    const a = await lugar(idUnico("Origen"));
    const b = await lugar(idUnico("Destino"));
    const antes = (await admin.get(URL)).body.flota;
    expect(antes.activos).toBe(0);

    const enRuta = await viajeEnCurso([a, b]); // salió y no llegó
    const enB = await viajeEnCurso([a, b, a]);
    await admin
      .post(`/api/erp/viajes/${enB}/marcas`)
      .send({ que: "llegada", orden: 1, hora: hora(10), motivo: "se olvidó de marcar" })
      .expect(200);
    const averia = await viajeEnCurso([a, b]);
    await admin
      .post(`/api/erp/viajes/${averia}/descanso`)
      .send({ motivo: "Avería", inicio_en: hora(5) })
      .expect(200);
    const retorno = await viajeEnCurso([a, b, a]);
    for (const [que, orden, h] of [
      ["llegada", 1, 10],
      ["salida", 1, 12],
    ] as const) {
      await admin
        .post(`/api/erp/viajes/${retorno}/marcas`)
        .send({ que, orden, hora: hora(h), motivo: "se olvidó de marcar" })
        .expect(200);
    }
    expect([enRuta, enB, averia, retorno].every(Boolean)).toBe(true);

    const r = await admin.get(URL);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.flota).toMatchObject({
      activos: 4,
      en_ruta: 1,
      en_parada: 1,
      detenidas: 1,
      retornando: 1,
      descansando: 0,
    });
    expect(r.body.flota.por_tipo).toEqual([{ tipo: "VOLQUETE", cantidad: 4 }]);
    // Esta empresa tiene Combustible: el bloque viene con sus totales.
    // La avería abrió su alerta crítica de unidad detenida.
    expect(r.body.combustible.alertas.criticas).toBe(1);
  });

  it("el bloque de combustible suma lo que hay en los tanques y trae la urea por envase", async () => {
    const tq = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque TV",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 1000,
      nivel_actual: 400,
      requiere_documento: false,
    });
    expect(tq.status, JSON.stringify(tq.body)).toBe(201);
    const r = await admin.get(URL);
    expect(r.status).toBe(200);
    expect(r.body.combustible.tanques).toHaveLength(1);
    expect(r.body.combustible.total_en_tanques_gal).toBeCloseTo(400, 1);
    expect(r.body.combustible.tanquetas).toMatchObject({ saldo_total_gal: 0, items: [] });
    expect(r.body.combustible.cisternas).toMatchObject({ con_saldo: 0, por_llegar: 0 });
    expect(Array.isArray(r.body.urea.envases)).toBe(true);
  });

  it("solo lo ven admin y lectura: el operador y el conductor reciben 403", async () => {
    expect((await (await conRol("lectura")).get(URL)).status).toBe(200);
    expect((await (await conRol("operador")).get(URL)).status).toBe(403);
    expect((await (await conRol("conductor_ruta")).get(URL)).status).toBe(403);
    expect((await request(app).get(URL)).status).toBe(401);
  });

  it("sin el módulo Combustible el bloque falta y la pantalla no se rompe (sin 403)", async () => {
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
    const sinComb = await entrar(otra, otra.usuario.email);
    const r = await sinComb.get(URL);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.flota.activos).toBe(0);
    expect(r.body).not.toHaveProperty("combustible");
    expect(r.body).not.toHaveProperty("urea");
  });

  it("cada empresa ve solo su flota", async () => {
    const otra = await crearTenantDePrueba(PASSWORD);
    tenants.push(otra.tenant.id);
    const ajeno = await entrar(otra, otra.usuario.email);
    const r = await ajeno.get(URL);
    expect(r.status).toBe(200);
    expect(r.body.flota.activos).toBe(0);
    // La de la primera empresa sigue con lo suyo.
    expect((await admin.get(URL)).body.flota.activos).toBe(4);
  });
});
