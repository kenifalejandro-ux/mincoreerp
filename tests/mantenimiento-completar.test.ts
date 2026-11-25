/** tests/mantenimiento-completar.test.ts
 *
 * «Desde Operaciones» (alinear el ecosistema a la maqueta): las unidades que registró Flota comparten el
 * maestro `equipos` con Mantenimiento, así que no se copian: aparecen como pendientes (sin fila en
 * `mantenimiento_equipo_datos`) y se completan dándoles su área y su propiedad.
 *
 * 1. Con Flota en la empresa: la lista trae las unidades de Flota sin completar, no las que nacieron en
 *    Mantenimiento ni las quitadas.
 * 2. Completar les da área y propiedad, las saca de la lista y baja el contador del resumen.
 * 3. Repetir la llamada (doble clic, reintento) no falla ni repite: 0 completadas.
 * 4. Todo o nada: una unidad que no existe da 404 y no se completa ninguna; un área de otra empresa, 400.
 * 5. Sin Flota la lista sale vacía (200, no 403) y el resumen cuenta 0.
 * 6. Permisos: Lectura mira pero no completa; otra empresa no ve ni toca las unidades de la primera.
 * 7. Auditoría: UNA fila con la cantidad y los ids.
 */
import { randomUUID } from "node:crypto";

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/mantenimiento";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

describe("Mantenimiento: completar las unidades que registró Operaciones", () => {
  const empresas: Empresa[] = [];
  let a: Empresa; // Mantenimiento + Flota
  let b: Empresa; // solo Mantenimiento
  let admin: Agente;
  let adminB: Agente;
  let lectura: Agente;

  const habilitar = async (e: Empresa, modulos: string[]) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: modulos.includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const entrar = async (e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const placa = () => `OP-${randomUUID().slice(0, 6).toUpperCase()}`;
  /** Una unidad registrada en Flota (no pasa por Mantenimiento). */
  const deFlota = async (p = placa()) => {
    const r = await admin.post("/api/erp/equipos").send({ placa_codigo: p, tipo: "Camión" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: Number(r.body.id), placa: p };
  };
  const pendientes = async (ag: Agente = admin) => {
    const r = await ag.get(`${BASE}/equipos/pendientes`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.equipos as { id: number; placa_codigo: string; area: string | null }[];
  };
  const resumen = async (ag: Agente = admin) => (await ag.get(`${BASE}/resumen`)).body;

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await habilitar(a, ["mantenimiento", "flota"]);
    await habilitar(b, ["mantenimiento"]);
    admin = await entrar(a);
    adminB = await entrar(b);
    const dni = dniUnico();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Lectura", dni, password: PASSWORD, rol: "lectura" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    lectura = request.agent(app);
    const login = await lectura
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, identificador: dni, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("lista las unidades de Flota sin completar, no las de Mantenimiento ni las quitadas", async () => {
    const f = await deFlota();
    const m = await admin
      .post(`${BASE}/equipos`)
      .send({ placa_codigo: placa(), tipo: "Volquete", medidor: "horometro", lectura: 1 });
    expect(m.status).toBe(201);
    const q = await deFlota();
    await withTenant(a.tenant.id, (c) =>
      c.query("UPDATE equipos SET activo = false WHERE tenant_id = $1 AND id = $2", [
        a.tenant.id,
        q.id,
      ])
    );
    const ids = (await pendientes()).map((x) => x.id);
    expect(ids).toContain(f.id);
    expect(ids).not.toContain(Number(m.body.id));
    expect(ids).not.toContain(q.id);
  });

  it("completar da área y propiedad, saca la unidad de la lista y baja el contador", async () => {
    const f = await deFlota();
    const area = await admin
      .post(`${BASE}/areas`)
      .send({ nombre: `Cantera ${randomUUID().slice(0, 4)}` });
    expect(area.status).toBe(201);
    const antes = (await resumen()).por_importar as number;
    expect(antes).toBeGreaterThanOrEqual(1);

    const r = await admin
      .post(`${BASE}/equipos/completar`)
      .send({ ids: [f.id], propiedad: "alquilada", area_id: area.body.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ completados: 1, ids: [f.id] });

    expect((await pendientes()).map((x) => x.id)).not.toContain(f.id);
    expect((await resumen()).por_importar).toBe(antes - 1);
    const lista = (await admin.get(`${BASE}/equipos`)).body.equipos as {
      id: number;
      area: string | null;
      propiedad: string;
    }[];
    expect(lista.find((x) => x.id === f.id)).toMatchObject({
      area: area.body.nombre,
      propiedad: "alquilada",
    });
  });

  it("repetir la llamada no falla ni repite: 0 completadas", async () => {
    const f = await deFlota();
    const cuerpo = { ids: [f.id], propiedad: "propia" };
    expect((await admin.post(`${BASE}/equipos/completar`).send(cuerpo)).body.completados).toBe(1);
    const otra = await admin
      .post(`${BASE}/equipos/completar`)
      .send({ ...cuerpo, propiedad: "alquilada" });
    expect(otra.status).toBe(200);
    expect(otra.body).toEqual({ completados: 0, ids: [] });
    // No pisó lo que ya estaba completo.
    const fila = (
      (await admin.get(`${BASE}/equipos`)).body.equipos as { id: number; propiedad: string }[]
    ).find((x) => x.id === f.id);
    expect(fila?.propiedad).toBe("propia");
  });

  it("todo o nada: una unidad inexistente da 404 y no se completa ninguna; un área ajena, 400", async () => {
    const f = await deFlota();
    const mala = await admin
      .post(`${BASE}/equipos/completar`)
      .send({ ids: [f.id, 987654321], propiedad: "propia" });
    expect(mala.status).toBe(404);
    expect((await pendientes()).map((x) => x.id)).toContain(f.id);

    const areaAjena = await adminB.post(`${BASE}/areas`).send({ nombre: "Ajena" });
    expect(areaAjena.status).toBe(201);
    const ajena = await admin
      .post(`${BASE}/equipos/completar`)
      .send({ ids: [f.id], propiedad: "propia", area_id: areaAjena.body.id });
    expect(ajena.status).toBe(400);
    expect((await pendientes()).map((x) => x.id)).toContain(f.id);
  });

  it("valida el cuerpo: sin unidades o con una propiedad inventada es 400", async () => {
    expect(
      (await admin.post(`${BASE}/equipos/completar`).send({ ids: [], propiedad: "propia" })).status
    ).toBe(400);
    expect(
      (await admin.post(`${BASE}/equipos/completar`).send({ ids: [1], propiedad: "prestada" }))
        .status
    ).toBe(400);
  });

  it("sin Flota la lista sale vacía (no 403) y el resumen cuenta 0", async () => {
    // Una unidad sin fila de Mantenimiento en una empresa SIN Flota (la tuvo y la apagó): no se lee.
    await withTenant(b.tenant.id, (c) =>
      c.query(`INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'Camión')`, [
        b.tenant.id,
        placa(),
      ])
    );
    expect(await pendientes(adminB)).toEqual([]);
    expect((await resumen(adminB)).por_importar).toBe(0);
  });

  it("Lectura mira pero no completa; otra empresa no ve ni toca las unidades de la primera", async () => {
    const f = await deFlota();
    expect((await lectura.get(`${BASE}/equipos/pendientes`)).status).toBe(200);
    expect(
      (await lectura.post(`${BASE}/equipos/completar`).send({ ids: [f.id], propiedad: "propia" }))
        .status
    ).toBe(403);
    expect((await pendientes(adminB)).map((x) => x.id)).not.toContain(f.id);
    expect(
      (await adminB.post(`${BASE}/equipos/completar`).send({ ids: [f.id], propiedad: "propia" }))
        .status
    ).toBe(404);
    expect((await pendientes()).map((x) => x.id)).toContain(f.id);
  });

  it("la auditoría guarda UNA fila con la cantidad y los ids", async () => {
    const f1 = await deFlota();
    const f2 = await deFlota();
    const r = await admin
      .post(`${BASE}/equipos/completar`)
      .send({ ids: [f1.id, f2.id], propiedad: "propia" });
    expect(r.body.completados).toBe(2);
    const filas = await pool.query(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'mantenimiento.equipos_completar'
        ORDER BY id DESC LIMIT 1`,
      [a.tenant.id]
    );
    expect(filas.rows[0].detalle).toMatchObject({ cantidad: 2 });
    expect([...filas.rows[0].detalle.ids].sort()).toEqual([f1.id, f2.id].sort());
  });
});
