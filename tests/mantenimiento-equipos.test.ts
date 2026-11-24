/** tests/mantenimiento-equipos.test.ts
 *
 * Ecosistema «Gestión de mantenimiento», etapa 1 de M1: la lista de equipos (migraciones 0203 y 0204).
 *
 * 1. Autonomía: una empresa con SOLO `mantenimiento` (sin Flota, Checklists, OT ni Almacén) lista sus
 *    equipos sin errores.
 * 2. Filtros: buscar, por tipo y por área (incluido «sin área»); el total y los tipos no cambian al filtrar.
 * 3. Aislamiento: otra empresa no ve nada de la primera; una empresa que no tiene el módulo no entra.
 * 4. Los equipos quitados (inactivos) no aparecen.
 * 5. El maestro es `equipos`: lo que escribe Flota (tipo en mayúsculas, sin medidor, sin ficha) se ve igual, con la
 *    lectura del historial `equipo_lecturas`.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("Mantenimiento: lista de equipos", () => {
  const empresas: Empresa[] = [];
  let a: Empresa; // solo Mantenimiento
  let b: Empresa; // solo Mantenimiento, otra empresa
  let c: Empresa; // sin el módulo
  let admin: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let adminC: ReturnType<typeof request.agent>;
  let areaCantera: number;

  const entrar = async (e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const habilitar = async (e: Empresa, modulo: string | null) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === modulo ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  /** Siembra en el MAESTRO (`equipos`) como lo haría Flota, y en las tablas propias de Mantenimiento. */
  const sembrar = (e: Empresa) =>
    withTenant(e.tenant.id, async (cl) => {
      const area = await cl.query<{ id: number }>(
        `INSERT INTO mantenimiento_areas (tenant_id, nombre) VALUES ($1,'Cantera') RETURNING id::int AS id`,
        [e.tenant.id]
      );
      const equipos: [string, string, string | null, number | null, boolean][] = [
        ["AKM-739", "Volquete", "VOLVO", area.rows[0].id, true],
        ["REX-002", "Retroexcavadora", "SANY", area.rows[0].id, true],
        ["CEB-860", "Camioneta", "TOYOTA", null, true],
        ["VIEJO-1", "Volquete", "SCANIA", null, false],
      ];
      for (const [placa, tipo, marca, areaId, activo] of equipos) {
        const r = await cl.query<{ id: number }>(
          `INSERT INTO equipos (tenant_id, placa_codigo, tipo, marca, activo)
           VALUES ($1,$2,$3,$4,$5) RETURNING id::int AS id`,
          [e.tenant.id, placa, tipo, marca, activo]
        );
        if (areaId) {
          await cl.query(
            `INSERT INTO mantenimiento_equipo_datos (tenant_id, equipo_id, area_id) VALUES ($1,$2,$3)`,
            [e.tenant.id, r.rows[0].id, areaId]
          );
        }
      }
      return area.rows[0].id;
    });
  const lista = (ag: ReturnType<typeof request.agent>, query = "") =>
    ag.get(`/api/erp/mantenimiento/equipos${query}`);

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    c = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b, c);
    await habilitar(a, "mantenimiento");
    await habilitar(b, "mantenimiento");
    await habilitar(c, "proveedores");
    areaCantera = await sembrar(a);
    admin = await entrar(a);
    adminB = await entrar(b);
    adminC = await entrar(c);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("con solo Mantenimiento la empresa lista sus equipos activos, ordenados por placa", async () => {
    const r = await lista(admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.equipos.map((e: { placa_codigo: string }) => e.placa_codigo)).toEqual([
      "AKM-739",
      "CEB-860",
      "REX-002",
    ]);
    expect(r.body.total).toBe(3);
    expect(r.body.tipos).toEqual(["Camioneta", "Retroexcavadora", "Volquete"]);
    expect(r.body.equipos[0]).toMatchObject({
      tipo: "Volquete",
      marca: "VOLVO",
      area: "Cantera",
      medidor: "horometro",
      lectura: 0,
      propiedad: "propia",
      por_completar: false,
    });
  });

  it("los equipos quitados no aparecen", async () => {
    const r = await lista(admin, "?q=viejo");
    expect(r.body.equipos).toEqual([]);
  });

  it("busca por placa, marca o área, sin mirar mayúsculas", async () => {
    expect((await lista(admin, "?q=sany")).body.equipos).toHaveLength(1);
    expect((await lista(admin, "?q=akm")).body.equipos).toHaveLength(1);
    expect((await lista(admin, "?q=CANTERA")).body.equipos).toHaveLength(2);
  });

  it("filtra por tipo y por área; «sin_area» trae los que no tienen", async () => {
    expect((await lista(admin, "?tipo=Volquete")).body.equipos).toHaveLength(1);
    expect((await lista(admin, `?area=${areaCantera}`)).body.equipos).toHaveLength(2);
    const sin = await lista(admin, "?area=sin_area");
    expect(sin.body.equipos.map((e: { placa_codigo: string }) => e.placa_codigo)).toEqual([
      "CEB-860",
    ]);
  });

  it("filtrar no cambia el total ni los tipos que ofrece el filtro", async () => {
    const r = await lista(admin, "?tipo=Camioneta");
    expect(r.body.equipos).toHaveLength(1);
    expect(r.body.total).toBe(3);
    expect(r.body.tipos).toEqual(["Camioneta", "Retroexcavadora", "Volquete"]);
  });

  it("rechaza un filtro de área inventado", async () => {
    expect((await lista(admin, "?area=1;drop")).status).toBe(400);
  });

  it("otra empresa no ve los equipos de la primera", async () => {
    const r = await lista(adminB);
    expect(r.status).toBe(200);
    expect(r.body.equipos).toEqual([]);
    expect(r.body.total).toBe(0);
  });

  it("una empresa que no tiene el módulo no entra", async () => {
    const r = await lista(adminC);
    expect([403, 404]).toContain(r.status);
  });

  it("lee el maestro tal como lo deja Flota: tipo en mayúsculas, sin medidor, lectura del historial y «por completar»", async () => {
    const t = await crearTenantDePrueba(PASSWORD);
    empresas.push(t);
    await habilitar(t, "mantenimiento");
    await withTenant(t.tenant.id, async (cl) => {
      const e = await cl.query<{ id: number }>(
        `INSERT INTO equipos (tenant_id, placa_codigo, tipo, tipo_medidor) VALUES ($1,'FLO-1','VOLQUETE','odometro')
         RETURNING id::int AS id`,
        [t.tenant.id]
      );
      await cl.query(
        `INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1,'FLO-2','Volquete')`,
        [t.tenant.id]
      );
      await cl.query(
        `INSERT INTO equipos (tenant_id, placa_codigo, tipo, por_completar) VALUES ($1,'FLO-3','Sin definir',true)`,
        [t.tenant.id]
      );
      for (const [valor, anulada] of [
        [100, false],
        [250.5, false],
        [900, true],
      ] as const) {
        await cl.query(
          `INSERT INTO equipo_lecturas (tenant_id, equipo_id, tipo, valor, leido_en, origen, anulada_en, motivo_anulacion)
           VALUES ($1,$2,'odometro',$3::numeric, now() - make_interval(secs => 1000 - $3::numeric), 'manual',
                   CASE WHEN $4::boolean THEN now() END, CASE WHEN $4::boolean THEN 'error de carga' END)`,
          [t.tenant.id, e.rows[0].id, valor, anulada]
        );
      }
    });
    const ag = await entrar(t);
    const r = await lista(ag);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const porPlaca = Object.fromEntries(
      r.body.equipos.map((e: { placa_codigo: string }) => [e.placa_codigo, e])
    );
    // La última lectura NO anulada: la de 900 se anuló; manda 250.5.
    expect(porPlaca["FLO-1"]).toMatchObject({
      medidor: "odometro",
      lectura: 250.5,
      propiedad: "propia",
    });
    // Sin medidor configurado se muestra el horómetro, y sin lecturas va en cero.
    expect(porPlaca["FLO-2"]).toMatchObject({ medidor: "horometro", lectura: 0, area: null });
    expect(porPlaca["FLO-3"].por_completar).toBe(true);
    // «VOLQUETE» y «Volquete» son el mismo tipo: el filtro lo ofrece una sola vez y filtra los dos.
    expect(r.body.tipos.filter((x: string) => x.toLowerCase() === "volquete")).toHaveLength(1);
    expect((await lista(ag, "?tipo=volquete")).body.equipos).toHaveLength(2);
  });
});
