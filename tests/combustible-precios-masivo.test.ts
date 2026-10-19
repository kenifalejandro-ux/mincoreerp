/** tests/combustible-precios-masivo.test.ts
 *
 * POST /api/erp/combustible/precios/masivo: el mismo precio a varios tanques
 * (venta interna) o a varios proveedores de ruta, en una sola operación.
 * Lo que importa: todo o nada, el aislamiento entre tenants, quién puede, y
 * que la bitácora registre un precio por cada fila creada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const RUTA = "/api/erp/combustible/precios/masivo";

async function crearTanque(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const fila = await client.query(
      `INSERT INTO combustible (
         tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
       )
       VALUES ($1, $2, 'Tanque precios masivo', 'diesel_b5', 'gal', 'fijo', 5000) RETURNING id`,
      [tenantId, idUnico("TQ")]
    );
    return fila.rows[0].id;
  });
}

async function cantidadDePrecios(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (client) => {
    const r = await client.query(`SELECT count(*)::int AS n FROM combustible_precios`);
    return r.rows[0].n;
  });
}

describe("combustible: precios masivos", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let slug: string;
  let tanqueA: number;
  let tanqueB: number;
  let proveedorA: number;
  let proveedorB: number;
  let proveedorSoloUrea: number;

  let otroTenantId: string;
  let tanqueAjeno: number;
  let proveedorAjeno: number;
  let seq = 0;

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(87300000 + Math.floor(Math.random() * 600000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const entrar = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entrar.status).toBe(200);
    return agente;
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });

    tanqueA = await crearTanque(tenantId);
    tanqueB = await crearTanque(tenantId);
    proveedorA = (
      await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("PRIMAX") })
    ).body.id;
    proveedorB = (
      await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("REPSOL") })
    ).body.id;
    proveedorSoloUrea = (
      await admin.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("SOLOUREA"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;

    // Otra empresa, con su tanque y su proveedor: ninguno debe poder recibir
    // un precio de este tenant.
    const otro = await crearTenantDePrueba(password);
    otroTenantId = otro.tenant.id;
    const agenteAjeno = request.agent(app);
    await agenteAjeno
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    tanqueAjeno = await crearTanque(otroTenantId);
    proveedorAjeno = (
      await agenteAjeno.post("/api/erp/combustible/grifos").send({ nombre: idUnico("AJENO") })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(otroTenantId);
    await closeDatabase();
  });

  async function vigente(destino: Record<string, number>) {
    const params = new URLSearchParams({
      tipo_combustible: "diesel_b5",
      fecha: new Date().toISOString(),
      ...Object.fromEntries(Object.entries(destino).map(([k, v]) => [k, String(v)])),
    });
    const r = await admin.get(`/api/erp/combustible/precios/vigente?${params.toString()}`);
    expect(r.status).toBe(200);
    return r.body.precio as { precio_unitario: string } | null;
  }

  it("el alta individual POST /precios ya no existe (404): la única vía es /masivo", async () => {
    const res = await admin.post("/api/erp/combustible/precios").send({
      tipo_combustible: "diesel_b5",
      combustible_id: tanqueA,
      precio_unitario: 20,
    });
    expect(res.status).toBe(404);
  });

  it("un precio a dos tanques: 201, una fila por tanque y cada uno lo resuelve como vigente", async () => {
    const res = await admin.post(RUTA).send({
      tipo_combustible: "diesel_b5",
      combustible_ids: [tanqueA, tanqueB],
      precio_unitario: 24.8,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((p: { combustible_id: number }) => p.combustible_id).sort()).toEqual(
      [tanqueA, tanqueB].sort()
    );
    expect(Number((await vigente({ combustible_id: tanqueA }))?.precio_unitario)).toBeCloseTo(24.8);
    expect(Number((await vigente({ combustible_id: tanqueB }))?.precio_unitario)).toBeCloseTo(24.8);
  });

  it("un precio a dos proveedores de ruta: 201 y cada uno lo resuelve como vigente", async () => {
    const res = await admin.post(RUTA).send({
      tipo_combustible: "diesel_b5",
      grifo_ids: [proveedorA, proveedorB],
      precio_unitario: 25.6,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(Number((await vigente({ grifo_id: proveedorA }))?.precio_unitario)).toBeCloseTo(25.6);
    expect(Number((await vigente({ grifo_id: proveedorB }))?.precio_unitario)).toBeCloseTo(25.6);
  });

  it("el precio nuevo no pisa al anterior: quedan las dos filas en el historial", async () => {
    await admin.post(RUTA).send({
      tipo_combustible: "diesel_b5",
      combustible_ids: [tanqueA],
      precio_unitario: 26.5,
      vigente_desde: new Date(Date.now() + 60_000).toISOString(),
    });
    const lista = await admin.get("/api/erp/combustible/precios");
    const deA = lista.body.filter((p: { combustible_id: number }) => p.combustible_id === tanqueA);
    expect(deA.length).toBeGreaterThanOrEqual(2);
    // El programado a futuro no cambia el vigente de hoy.
    expect(Number((await vigente({ combustible_id: tanqueA }))?.precio_unitario)).toBeCloseTo(24.8);
  });

  describe("todo o nada", () => {
    it("ataque: un tanque válido y uno que no existe -> 400 y NO queda ni el válido", async () => {
      const antes = await cantidadDePrecios(tenantId);
      const res = await admin.post(RUTA).send({
        tipo_combustible: "diesel_b5",
        combustible_ids: [tanqueA, 2_000_000_000],
        precio_unitario: 99,
      });
      expect(res.status).toBe(400);
      expect(await cantidadDePrecios(tenantId)).toBe(antes);
    });

    it("ataque: un proveedor válido y uno de otra empresa -> 400 y no se crea ninguno", async () => {
      const antes = await cantidadDePrecios(tenantId);
      const res = await admin.post(RUTA).send({
        tipo_combustible: "diesel_b5",
        grifo_ids: [proveedorA, proveedorAjeno],
        precio_unitario: 99,
      });
      expect(res.status).toBe(400);
      expect(await cantidadDePrecios(tenantId)).toBe(antes);
    });

    it("ataque: un tanque de otra empresa no recibe precio -> 400, ni en la otra ni en esta", async () => {
      const antes = await cantidadDePrecios(tenantId);
      const antesAjeno = await cantidadDePrecios(otroTenantId);
      const res = await admin.post(RUTA).send({
        tipo_combustible: "diesel_b5",
        combustible_ids: [tanqueAjeno],
        precio_unitario: 99,
      });
      expect(res.status).toBe(400);
      expect(await cantidadDePrecios(tenantId)).toBe(antes);
      expect(await cantidadDePrecios(otroTenantId)).toBe(antesAjeno);
    });

    it("un proveedor que no es de ruta (solo urea) -> 400 y no se crea ninguno", async () => {
      const antes = await cantidadDePrecios(tenantId);
      const res = await admin.post(RUTA).send({
        tipo_combustible: "diesel_b5",
        grifo_ids: [proveedorA, proveedorSoloUrea],
        precio_unitario: 99,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/proveedor de ruta/);
      expect(await cantidadDePrecios(tenantId)).toBe(antes);
    });
  });

  describe("forma del pedido (Zod)", () => {
    const casos: Array<[string, Record<string, unknown>]> = [
      ["tanques y proveedores a la vez", { combustible_ids: [1], grifo_ids: [1] }],
      ["ni tanques ni proveedores", {}],
      ["lista vacía", { combustible_ids: [] }],
      ["destinos repetidos", { combustible_ids: [5, 5] }],
      ["más de 50 destinos", { combustible_ids: Array.from({ length: 51 }, (_, i) => i + 1) }],
      ["precio cero", { combustible_ids: [1], precio_unitario: 0 }],
      ["precio negativo", { combustible_ids: [1], precio_unitario: -3 }],
      ["precio que se redondea a cero", { combustible_ids: [1], precio_unitario: 0.001 }],
      ["precio sobre el tope", { combustible_ids: [1], precio_unitario: 100_001 }],
      ["precio fuera de la columna (1e21)", { combustible_ids: [1], precio_unitario: 1e21 }],
      ["tipo de combustible inventado", { combustible_ids: [1], tipo_combustible: "kerosene" }],
    ];
    for (const [nombre, extra] of casos) {
      it(`400: ${nombre}`, async () => {
        const antes = await cantidadDePrecios(tenantId);
        const res = await admin
          .post(RUTA)
          .send({ tipo_combustible: "diesel_b5", precio_unitario: 10, ...extra });
        expect(res.status).toBe(400);
        expect(await cantidadDePrecios(tenantId)).toBe(antes);
      });
    }
  });

  describe("quién puede", () => {
    for (const rol of ["conductor_ruta", "grifero", "lectura", "encargado_urea"]) {
      it(`ataque: ${rol} no puede cargar precios (403) y no queda nada`, async () => {
        const agente = await persona(rol);
        const antes = await cantidadDePrecios(tenantId);
        const res = await agente.post(RUTA).send({
          tipo_combustible: "diesel_b5",
          combustible_ids: [tanqueA],
          precio_unitario: 1,
        });
        expect(res.status).toBe(403);
        expect(await cantidadDePrecios(tenantId)).toBe(antes);
      });
    }

    it("sin sesión: 401", async () => {
      const res = await request(app)
        .post(RUTA)
        .send({
          tipo_combustible: "diesel_b5",
          combustible_ids: [tanqueA],
          precio_unitario: 1,
        });
      expect(res.status).toBe(401);
    });
  });

  it("bitácora: una entrada combustible.precio_crear por cada precio creado, con quién", async () => {
    const res = await admin.post(RUTA).send({
      tipo_combustible: "diesel_b5",
      combustible_ids: [tanqueA, tanqueB],
      precio_unitario: 27.1,
    });
    expect(res.status).toBe(201);
    const ids: number[] = res.body.map((p: { id: number }) => p.id);

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle, usuario_id FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'combustible.precio_crear'
            AND (detalle->>'precioId')::int = ANY($2::int[])`,
        [tenantId, ids]
      )
    );
    expect(log.rows).toHaveLength(2);
    for (const fila of log.rows) {
      expect(fila.detalle.masivo).toBe(true);
      expect(Number(fila.detalle.precioUnitario)).toBeCloseTo(27.1);
      expect(fila.usuario_id).toBeTruthy();
    }
  });
});
