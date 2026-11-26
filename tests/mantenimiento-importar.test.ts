/** tests/mantenimiento-importar.test.ts
 *
 * Ecosistema «Gestión de mantenimiento», etapa 3 de M1: importar equipos desde las filas de un Excel y el
 * resumen del Centro.
 *
 * 1. Con SOLO `mantenimiento`: se importan las filas, las áreas que no existían se crean y las que existían se
 *    reusan (sin mirar mayúsculas); los equipos quedan con origen «excel».
 * 2. Todo o nada: una placa ya registrada o repetida dentro del archivo rechaza el archivo entero (400) con la
 *    fila y la columna, y no entra ninguna fila.
 * 3. Validaciones por fila (campo «fila.columna», como el resto de las cargas masivas) y tope de filas.
 * 4. Permisos: admin y operador importan, Lectura no; otra empresa no ve nada.
 * 5. Auditoría: UNA fila con el conteo, no una por equipo.
 * 6. Resumen del Centro: total, propios, alquilados, sin área y equipos por área.
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
const RUTA = "/api/erp/mantenimiento/equipos/bulk";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

describe("Mantenimiento: importar equipos y resumen del Centro", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;
  let lectura: Agente;

  const habilitar = async (e: Empresa) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "mantenimiento" ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const entrarAdmin = async (e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const fila = (extra: Record<string, unknown> = {}) => ({
    placa_codigo: `X-${randomUUID().slice(0, 6).toUpperCase()}`,
    tipo: "Volquete",
    marca: "VOLVO",
    modelo: "FH",
    medidor: "horometro",
    lectura: 100,
    propiedad: "propia",
    area: "Cantera",
    ...extra,
  });
  const equipos = async (ag: Agente = admin) =>
    (await ag.get("/api/erp/mantenimiento/equipos")).body.equipos as {
      placa_codigo: string;
      area: string | null;
      lectura: number;
    }[];

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await habilitar(a);
    await habilitar(b);
    admin = await entrarAdmin(a);
    adminB = await entrarAdmin(b);
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

  it("importa las filas, crea las áreas que faltan y reusa las que existen", async () => {
    // «Cantera» ya existe con otra capitalización: se reusa y no se duplica.
    await admin.post("/api/erp/mantenimiento/areas").send({ nombre: "CANTERA" });
    const p1 = fila({ placa_codigo: "IMP-001", area: "cantera" });
    const p2 = fila({ placa_codigo: "IMP-002", area: "Planta de hornos", lectura: 48300.5 });
    const p3 = fila({ placa_codigo: "IMP-003", area: undefined, propiedad: "alquilada" });
    const r = await admin.post(RUTA).send([p1, p2, p3]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual({ importados: 3, areasCreadas: ["Planta de hornos"] });

    const lista = await equipos();
    const imp = (placa: string) => lista.find((e) => e.placa_codigo === placa)!;
    expect(imp("IMP-001")).toMatchObject({ area: "CANTERA", lectura: 100 });
    expect(imp("IMP-002")).toMatchObject({ area: "Planta de hornos", lectura: 48300.5 });
    expect(imp("IMP-003").area).toBeNull();
    const areas = (await admin.get("/api/erp/mantenimiento/areas")).body as { nombre: string }[];
    expect(areas.filter((x) => x.nombre.toLowerCase() === "cantera")).toHaveLength(1);
  });

  it("todo o nada: una placa ya registrada rechaza el archivo entero, con su fila", async () => {
    const antes = (await equipos()).length;
    const nueva = fila();
    const r = await admin.post(RUTA).send([nueva, fila({ placa_codigo: "imp-001" })]);
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([
      { field: "1.placa_codigo", message: expect.stringContaining("ya está registrado") },
    ]);
    // La primera fila estaba bien, pero no entró.
    expect(await equipos()).toHaveLength(antes);
  });

  it("una placa repetida dentro del archivo dice en qué filas", async () => {
    const antes = (await equipos()).length;
    const r = await admin
      .post(RUTA)
      .send([fila({ placa_codigo: "REP-1" }), fila(), fila({ placa_codigo: "rep-1" })]);
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([
      { field: "2.placa_codigo", message: expect.stringContaining("filas 2 y 4") },
    ]);
    expect(await equipos()).toHaveLength(antes);
  });

  it("valida cada fila con su ubicación (fila.columna) y el tope de filas", async () => {
    const malas: [Record<string, unknown>, string][] = [
      [fila({ placa_codigo: "" }), "1.placa_codigo"],
      [fila({ tipo: "" }), "1.tipo"],
      [fila({ lectura: -3 }), "1.lectura"],
      [fila({ medidor: "pies" }), "1.medidor"],
      [fila({ propiedad: "prestada" }), "1.propiedad"],
    ];
    for (const [mala, campo] of malas) {
      const r = await admin.post(RUTA).send([fila(), mala]);
      expect(r.status, campo).toBe(400);
      expect(r.body.errors[0].field, campo).toBe(campo);
    }
    expect((await admin.post(RUTA).send([])).status).toBe(400);
    const demasiadas = Array.from({ length: 1001 }, (_, i) => fila({ placa_codigo: `M-${i}` }));
    const r = await admin.post(RUTA).send(demasiadas);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("1000");
  });

  it("admin y operador importan; Lectura no; otra empresa no ve nada", async () => {
    expect((await lectura.post(RUTA).send([fila()])).status).toBe(403);
    expect((await lectura.get("/api/erp/mantenimiento/equipos")).status).toBe(200);
    expect(await equipos(adminB)).toEqual([]);
    // La misma placa en otra empresa no choca.
    expect((await adminB.post(RUTA).send([fila({ placa_codigo: "IMP-001" })])).status).toBe(201);
  });

  it("la auditoría guarda UNA fila con el conteo, no una por equipo", async () => {
    const n = (
      await pool.query(
        `SELECT count(*)::int AS n FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'mantenimiento.equipos_importar'`,
        [a.tenant.id]
      )
    ).rows[0].n;
    const antes = n as number;
    const r = await admin.post(RUTA).send([fila(), fila(), fila()]);
    expect(r.status).toBe(201);
    const filas = await pool.query<{ detalle: Record<string, unknown> }>(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'mantenimiento.equipos_importar' ORDER BY id`,
      [a.tenant.id]
    );
    expect(filas.rows).toHaveLength(antes + 1);
    expect(filas.rows.at(-1)!.detalle).toMatchObject({ cantidad: 3 });
    expect(JSON.stringify(filas.rows)).not.toContain("VOLVO");
  });

  it("el resumen del Centro cuenta total, propios, alquilados, sin área y por área", async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    await habilitar(e);
    const ag = await entrarAdmin(e);
    const vacio = await ag.get("/api/erp/mantenimiento/resumen");
    expect(vacio.status).toBe(200);
    expect(vacio.body).toEqual({
      total: 0,
      propios: 0,
      alquilados: 0,
      sin_area: 0,
      areas: [],
      por_importar: 0, // sin Flota no hay unidades de Operaciones que importar
      meta_disponibilidad: 90,
      estados: { operativas: 0, en_mantenimiento: 0, detenidas: 0 },
      estado_por_area: [],
      // Sin esos módulos los bloques van en null, no en cero.
      ordenes: null,
      checklists: null,
    });

    await ag
      .post(RUTA)
      .send([
        fila({ placa_codigo: "R-1", area: "Cantera" }),
        fila({ placa_codigo: "R-2", area: "Cantera", propiedad: "alquilada" }),
        fila({ placa_codigo: "R-3", area: "Taller" }),
        fila({ placa_codigo: "R-4", area: undefined }),
      ]);
    await ag.post("/api/erp/mantenimiento/areas").send({ nombre: "Vacía" });
    const r = await ag.get("/api/erp/mantenimiento/resumen");
    expect(r.body).toMatchObject({ total: 4, propios: 3, alquilados: 1, sin_area: 1 });
    expect(
      r.body.areas.map((x: { nombre: string; equipos: number }) => [x.nombre, x.equipos])
    ).toEqual([
      ["Cantera", 2],
      ["Taller", 1],
      ["Vacía", 0],
    ]);
  });

  it("una placa de un equipo quitado se reactiva en lugar de rechazar el archivo", async () => {
    const ag = adminB;
    const placa = `QUI-${randomUUID().slice(0, 4).toUpperCase()}`;
    const creado = await ag.post("/api/erp/mantenimiento/equipos").send({
      placa_codigo: placa,
      tipo: "Volquete",
      medidor: "horometro",
      propiedad: "propia",
      lectura: 50,
    });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);
    await ag
      .patch(`/api/erp/mantenimiento/equipos/${creado.body.id}/quitar`)
      .send({ motivo: "Baja" });
    const r = await ag
      .post(RUTA)
      .send([fila({ placa_codigo: placa.toLowerCase(), tipo: "Camión" })]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const lista = await equipos(ag);
    const vuelta = lista.filter((e) => e.placa_codigo.toLowerCase() === placa.toLowerCase());
    expect(vuelta).toHaveLength(1);
    // La misma unidad (conserva su historial de lecturas): no se escribe otra lectura.
    expect(vuelta[0].lectura).toBe(50);
    const n = await withTenant(b.tenant.id, (cl) =>
      cl.query(
        "SELECT count(*)::int AS n FROM equipos WHERE tenant_id = $1 AND lower(placa_codigo) = lower($2)",
        [b.tenant.id, placa]
      )
    );
    expect(n.rows[0].n).toBe(1);
  });
});
