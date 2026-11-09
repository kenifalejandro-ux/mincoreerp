/** tests/viajes-ubicaciones.test.ts
 *
 * Historial de ubicaciones de un viaje (migración 0182): POST /api/erp/viajes/:id/ubicaciones.
 * Solo admin y operador; lugar del catálogo o texto libre; hora pasada sí, futura no; reintento con
 * el mismo identificador no duplica; el viaje trae su historial y su última ubicación; otro tenant
 * no ve nada.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const password = "ClaveDePrueba123";
const H = 3_600_000;
const hace = (h: number) => new Date(Date.now() - h * H).toISOString();

describe("viajes: ubicaciones del viaje (0182)", () => {
  const tenants: string[] = [];
  const admin = request.agent(app);
  const otro = request.agent(app);
  const lectura = request.agent(app);
  const operador = request.agent(app);
  const conductor = request.agent(app);
  let slug: string;
  let viajeId: number;
  let lugarId: number;
  let seq = 0;

  const ubicar = (id: number, cuerpo: Record<string, unknown>, agente = admin) =>
    agente.post(`/api/erp/viajes/${id}/ubicaciones`).send(cuerpo);

  async function nuevoViaje(inicio: string, extra: Record<string, unknown> = {}) {
    const a = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Origen") })).body.id
    );
    const b = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Destino") })).body.id
    );
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VU"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: String(41000000 + seq++),
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    return admin.post("/api/erp/viajes").send({
      equipo_id: Number(eq.body.id),
      origen_id: a,
      destino_id: b,
      inicio_en: inicio,
      ...extra,
    });
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenants.push(c.tenant.id);
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    const dni = String(87100000 + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Persona lectura", dni, password, rol: "lectura" });
    expect(alta.status).toBe(201);
    await lectura.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    for (const [agente, rol] of [
      [operador, "operador"],
      [conductor, "conductor_ruta"],
    ] as const) {
      const d = String(87200000 + seq++);
      const r = await admin
        .post("/api/erp/usuarios")
        .send({ nombre: `Persona ${rol}`, dni: d, password, rol });
      expect(r.status).toBe(201);
      await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: d, password });
    }
    const c2 = await crearTenantDePrueba(password);
    tenants.push(c2.tenant.id);
    await otro
      .post("/api/auth/login")
      .send({ tenantSlug: c2.tenant.slug, email: c2.usuario.email, password });
    lugarId = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Mina") })).body.id
    );
    const v = await nuevoViaje(hace(48));
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    viajeId = Number(v.body.id);
  });

  afterAll(async () => {
    for (const t of tenants) await borrarTenantDePrueba(t);
    await closeDatabase();
  });

  it("registra un lugar del catálogo y un texto libre; el viaje trae historial y última", async () => {
    const a = await ubicar(viajeId, { lugar_id: lugarId, registrado_en: hace(10) });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await ubicar(viajeId, { texto: "  Km 85 de la carretera  ", nota: "Con neblina" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.ubicaciones).toHaveLength(2);
    expect(b.body.ultima_ubicacion.texto).toBe("Km 85 de la carretera");
    expect(b.body.ultima_ubicacion.nota).toBe("Con neblina");
    expect(b.body.ubicaciones[1].lugar_id).toBe(lugarId);
  });

  it("una hora pasada no cambia cuál es la última si hay otra más reciente", async () => {
    const r = await ubicar(viajeId, { texto: "Grifo antiguo", registrado_en: hace(30) });
    expect(r.status).toBe(201);
    expect(r.body.ultima_ubicacion.texto).toBe("Km 85 de la carretera");
  });

  it("rechaza hora futura, hora anterior a la salida, sin lugar ni texto y lugar ajeno", async () => {
    const fut = await ubicar(viajeId, {
      texto: "X",
      registrado_en: new Date(Date.now() + 2 * H).toISOString(),
    });
    expect(fut.status).toBe(400);
    const ant = await ubicar(viajeId, { texto: "X", registrado_en: hace(100) });
    expect(ant.status).toBe(400);
    expect((await ubicar(viajeId, {})).status).toBe(400);
    expect((await ubicar(viajeId, { lugar_id: 999999999 })).status).toBe(400);
  });

  it("el reintento con el mismo identificador no duplica", async () => {
    const cliente_uuid = randomUUID();
    const a = await ubicar(viajeId, { texto: "Peaje", cliente_uuid });
    expect(a.status).toBe(201);
    const b = await ubicar(viajeId, { texto: "Peaje", cliente_uuid });
    expect(b.status).toBe(200);
    const n = await withTenant(tenants[0], (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM combustible_viaje_ubicaciones WHERE cliente_uuid = $1`,
        [cliente_uuid]
      )
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("solo admin y operador: lectura recibe 403", async () => {
    const r = await ubicar(viajeId, { texto: "Intento" }, lectura);
    expect(r.status).toBe(403);
  });

  it("el operador registra; el conductor recibe 403 y no deja filas", async () => {
    expect((await ubicar(viajeId, { texto: "Desde la oficina" }, operador)).status).toBe(201);
    const antes = await withTenant(tenants[0], (c) =>
      c.query(`SELECT count(*)::int AS n FROM combustible_viaje_ubicaciones`)
    );
    expect((await ubicar(viajeId, { texto: "Intento" }, conductor)).status).toBe(403);
    const despues = await withTenant(tenants[0], (c) =>
      c.query(`SELECT count(*)::int AS n FROM combustible_viaje_ubicaciones`)
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it("la lista de viajes trae la última ubicación; otro tenant no ve el viaje", async () => {
    const lista = await admin.get("/api/erp/viajes");
    expect(lista.status).toBe(200);
    const fila = (
      lista.body.data as { id: number; ultima_ubicacion: { texto: string } | null }[]
    ).find((x) => Number(x.id) === viajeId);
    expect(fila?.ultima_ubicacion?.texto).toBe("Desde la oficina");
    const ajena = await otro.get("/api/erp/viajes");
    expect((ajena.body.data as { id: number }[]).some((x) => Number(x.id) === viajeId)).toBe(false);
  });

  it("un viaje que aún no empezó o ya cerró no admite ubicaciones", async () => {
    const futuro = await nuevoViaje(new Date(Date.now() + 5 * H).toISOString());
    expect(futuro.status, JSON.stringify(futuro.body)).toBe(201);
    const a = await ubicar(Number(futuro.body.id), { texto: "X" });
    expect(a.status, JSON.stringify(a.body)).toBe(400);
    const cerrado = await nuevoViaje(hace(60), { fin_en: hace(50) });
    expect(cerrado.status, JSON.stringify(cerrado.body)).toBe(201);
    const b = await ubicar(Number(cerrado.body.id), { texto: "X", registrado_en: hace(55) });
    expect(b.status, JSON.stringify(b.body)).toBe(409);
  });

  it("otro tenant no ve el viaje ni sus ubicaciones", async () => {
    expect((await ubicar(viajeId, { texto: "X" }, otro)).status).toBe(404);
    // Y desde su propio tenant la fila sigue ahí: el 404 no borró nada.
    const n = await withTenant(tenants[0], (c) =>
      c.query(`SELECT count(*)::int AS n FROM combustible_viaje_ubicaciones WHERE viaje_id = $1`, [
        viajeId,
      ])
    );
    expect(n.rows[0].n).toBeGreaterThan(0);
  });
});
