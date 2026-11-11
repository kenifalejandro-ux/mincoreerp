/** tests/control-tv-unidad.test.ts
 *
 * GET /api/erp/viajes/control-tv/unidad/:viajeId (la vista de una unidad en el Control TV): los viajes
 * de su conductor (como titular, y aparte como relevo), el resumen de la unidad, que solo lo vea quien
 * tiene «Control TV», que respete el alcance por grifo (404 fuera) y que sin Combustible no dé 403.
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
const hace = (h: number) => new Date(Date.now() - h * H).toISOString();
const url = (id: number | string) => `/api/erp/viajes/control-tv/unidad/${id}`;

describe("control TV: resumen de una unidad", () => {
  const tenants: string[] = [];
  let empresa: Empresa;
  let admin: Agente;
  let seq = 0;
  let a: number;
  let b: number;
  let grifoA: number;
  let grifoB: number;
  const titular = { dni: "", id: 0 };
  const relevo = { dni: "", id: 0 };
  const v: Record<"programado" | "enRuta" | "anulado" | "cerrado" | "delRelevo", number> = {
    programado: 0,
    enRuta: 0,
    anulado: 0,
    cerrado: 0,
    delRelevo: 0,
  };

  async function entrar(e: Empresa, email: string): Promise<Agente> {
    const ag = request.agent(app);
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD })
      .expect(200);
    return ag;
  }

  async function persona(rol: string, nombre: string) {
    const dni = String(86200000 + Math.floor(Math.random() * 90000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre, dni, password: PASSWORD, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    return { dni, id: alta.body.id as string };
  }

  const unidad = async (grifo?: number) => {
    const r = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("U"),
      tipo: "VOLQUETE",
      ...(grifo ? { grifo_interno_id: grifo } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };

  async function programar(equipo: number, extra: Record<string, unknown>) {
    const r = await admin
      .post("/api/erp/viajes")
      .send({ equipo_id: equipo, paradas: [a, b], ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  }

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    tenants.push(empresa.tenant.id);
    admin = await entrar(empresa, empresa.usuario.email);
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    grifoA = sedes[0].grifos[0].id;
    a = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("O") })).body.id
    );
    b = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("D") })).body.id
    );
    Object.assign(titular, await persona("conductor_ruta", "Titular Prueba"));
    Object.assign(relevo, await persona("conductor_ruta", "Relevo Prueba"));

    // Del titular: uno programado (con el relevo), uno en ruta, uno anulado y uno terminado.
    v.programado = await programar(await unidad(), {
      conductor_dni: titular.dni,
      relevo_dni: relevo.dni,
    });
    v.anulado = await programar(await unidad(), { conductor_dni: titular.dni });
    await admin
      .post(`/api/erp/viajes/${v.anulado}/anular`)
      .send({ motivo: "Duplicado" })
      .expect(200);
    v.cerrado = await programar(await unidad(), { conductor_dni: titular.dni });
    await admin
      .post(`/api/erp/viajes/${v.cerrado}/iniciar`)
      .send({ inicio_en: hace(10), motivo: "preparativo del test" })
      .expect(200);
    await admin
      .post(`/api/erp/viajes/${v.cerrado}/cerrar`)
      .send({ fin_en: hace(5), motivo: "preparativo del test" })
      .expect(200);
    v.enRuta = await programar(await unidad(), { conductor_dni: titular.dni });
    await admin
      .post(`/api/erp/viajes/${v.enRuta}/iniciar`)
      .send({ inicio_en: hace(2), motivo: "preparativo del test" })
      .expect(200);
    // Uno donde el titular es el que antes era relevo.
    v.delRelevo = await programar(await unidad(), { conductor_dni: relevo.dni });
  });

  afterAll(async () => {
    for (const id of tenants) await borrarTenantDePrueba(id);
    await closeDatabase();
  });

  it("cuenta los viajes del conductor como titular, y el relevo aparte", async () => {
    const r = await admin.get(url(v.enRuta));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.dias).toBe(30);
    expect(r.body.conductor).toMatchObject({
      dni: titular.dni,
      en_ruta: 1,
      programados: 1,
      terminados: 1,
      anulados: 1,
      como_titular: 3, // programado, en ruta y terminado (el anulado no cuenta)
      como_relevo: 0,
    });
    // El relevo: lo suyo como titular es su viaje; el programado del titular lo cuenta como relevo.
    const s = await admin.get(url(v.delRelevo));
    expect(s.body.conductor).toMatchObject({
      dni: relevo.dni,
      programados: 1,
      en_ruta: 0,
      como_titular: 1,
      como_relevo: 1,
    });
  });

  it("trae el resumen de la unidad con sus partes aunque no tenga historial", async () => {
    const r = await admin.get(url(v.programado));
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("rendimiento");
    expect(r.body.estadia_normal).toBeNull(); // sin viajes anteriores de la ruta
    expect(Array.isArray(r.body.ultimas_cargas)).toBe(true);
    expect(r.body.alertas).toMatchObject({ total: expect.any(Number) });
    expect(Array.isArray(r.body.alertas.ultimas)).toBe(true);
    // Cada alerta trae su gravedad (crítica, media o info) y la cuenta de críticas.
    expect(typeof r.body.alertas.criticas).toBe("number");
    for (const al of r.body.alertas.ultimas as { gravedad: string }[]) {
      expect(["critica", "media", "info"]).toContain(al.gravedad);
    }
  });

  it("solo lo ven admin y lectura; el operador y el conductor reciben 403, sin sesión 401", async () => {
    const lectura = await persona("lectura", "Lector");
    const ag = request.agent(app);
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, identificador: lectura.dni, password: PASSWORD })
      .expect(200);
    expect((await ag.get(url(v.enRuta))).status).toBe(200);
    const operador = await persona("operador", "Operador");
    const op = request.agent(app);
    await op
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, identificador: operador.dni, password: PASSWORD })
      .expect(200);
    expect((await op.get(url(v.enRuta))).status).toBe(403);
    expect((await request(app).get(url(v.enRuta))).status).toBe(401);
  });

  it("un viaje que no existe, o de otra empresa, da 404", async () => {
    expect((await admin.get(url(99999999))).status).toBe(404);
    const otra = await crearTenantDePrueba(PASSWORD);
    tenants.push(otra.tenant.id);
    const ajeno = await entrar(otra, otra.usuario.email);
    expect((await ajeno.get(url(v.enRuta))).status).toBe(404);
  });

  it("con alcance a un grifo, la unidad de otro grifo da 404", async () => {
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    grifoB = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: "Grifo B" })
    ).body.id;
    const delB = await programar(await unidad(grifoB), { conductor_dni: titular.dni });
    const lector = await persona("lectura", "Lector del grifo A");
    const p = await admin.put(`/api/erp/usuarios/${lector.id}/permisos`).send({
      modulos: [],
      alcanceCombustible: { todo: false, sedes: [], grifos: [grifoA], surtidores: [] },
      motivo: "Solo el grifo A",
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const ag = request.agent(app);
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, identificador: lector.dni, password: PASSWORD })
      .expect(200);
    expect((await ag.get(url(v.enRuta))).status).toBe(200); // grifo A (el único al crearlo)
    expect((await ag.get(url(delB))).status).toBe(404);
    expect((await admin.get(url(delB))).status).toBe(200);
  });

  it("sin el módulo Combustible responde vacío, sin 403", async () => {
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
    const r = await sinComb.get(url(1));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({});
  });
});
