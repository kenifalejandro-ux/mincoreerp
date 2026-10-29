/** tests/combustible-grifos-ruc.test.ts
 *
 * RUC opcional del proveedor (migrations/0160). En Perú son 11 dígitos.
 *
 * Lo que se cubre: que la validación viva en el SERVIDOR (400, nunca el 500
 * del CHECK), que sea único por tenant SOLO cuando viene lleno, que el
 * mensaje del 409 distinga RUC de nombre, y que el alta deje el RUC en la
 * bitácora.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";

describe("combustible: RUC del proveedor (migrations/0160)", () => {
  let tenantId: string;
  let otroTenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  const agenteOtro = request.agent(app);

  /** RUC de 11 dígitos distinto en cada llamada. */
  const rucUnico = () => String(Date.now() * 1000 + Math.floor(Math.random() * 1000)).slice(-11);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const otro = await crearTenantDePrueba(password);
    otroTenantId = otro.tenant.id;
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(otroTenantId);
    await closeDatabase();
  });

  const crear = (a: ReturnType<typeof request.agent>, body: Record<string, unknown>) =>
    a.post("/api/erp/combustible/grifos").send({ nombre: idUnico("GRIFO"), ...body });

  it("crea con un RUC de 11 dígitos y lo devuelve en el alta y en el listado", async () => {
    const ruc = rucUnico();
    const res = await crear(agente, { ruc });
    expect(res.status).toBe(201);
    expect(res.body.ruc).toBe(ruc);

    const listado = await agente.get("/api/erp/combustible/grifos");
    const fila = listado.body.find((g: { id: number }) => g.id === res.body.id);
    expect(fila.ruc).toBe(ruc);
  });

  it("recorta los espacios del RUC", async () => {
    const ruc = rucUnico();
    const res = await crear(agente, { ruc: `  ${ruc}  ` });
    expect(res.status).toBe(201);
    expect(res.body.ruc).toBe(ruc);
  });

  it("sin RUC, con null o con cadena vacía: se crea con ruc null", async () => {
    for (const body of [{}, { ruc: null }, { ruc: "" }, { ruc: "   " }]) {
      const res = await crear(agente, body);
      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(res.body.ruc).toBeNull();
    }
  });

  it("dos proveedores sin RUC conviven", async () => {
    const a = await crear(agente, {});
    const b = await crear(agente, {});
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("un RUC mal formado da 400 (no 500): corto, largo, con letras o con guiones", async () => {
    for (const ruc of ["1234567890", "123456789012", "2012345678A", "20-1234567-8", 20123456789]) {
      const res = await crear(agente, { ruc });
      expect(res.status, String(ruc)).toBe(400);
    }
  });

  it("un RUC repetido en el mismo tenant da 409 con mensaje de RUC, no de nombre", async () => {
    const ruc = rucUnico();
    const primero = await crear(agente, { ruc });
    expect(primero.status).toBe(201);

    const repetido = await crear(agente, { ruc });
    expect(repetido.status).toBe(409);
    expect(repetido.body.error).toContain("RUC");
    expect(repetido.body.error).toContain(ruc);
  });

  it("un nombre repetido sigue dando 409 con mensaje de nombre", async () => {
    const nombre = idUnico("GRIFO");
    await crear(agente, { nombre });
    const repetido = await crear(agente, { nombre, ruc: rucUnico() });
    expect(repetido.status).toBe(409);
    expect(repetido.body.error).toContain(nombre);
  });

  it("el mismo RUC en otro tenant pasa", async () => {
    const ruc = rucUnico();
    const a = await crear(agente, { ruc });
    const b = await crear(agenteOtro, { ruc });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("dos altas simultáneas con el mismo RUC: una pasa y la otra recibe 409", async () => {
    const ruc = rucUnico();
    const [a, b] = await Promise.all([crear(agente, { ruc }), crear(agente, { ruc })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it("la bitácora de grifo_crear lleva el RUC", async () => {
    const ruc = rucUnico();
    const res = await crear(agente, { ruc });
    expect(res.status).toBe(201);

    const fila = await pool.query(
      `SELECT detalle FROM platform_audit_log
       WHERE tenant_id = $1 AND accion = 'combustible.grifo_crear'
         AND detalle->>'grifoId' = $2`,
      [tenantId, String(res.body.id)]
    );
    expect(fila.rows).toHaveLength(1);
    expect(fila.rows[0].detalle.ruc).toBe(ruc);
  });

  it("el CHECK de la base también rechaza un RUC malformado (última defensa)", async () => {
    await expect(
      withTenant(tenantId, (client) =>
        client.query(
          `INSERT INTO combustible_grifos (tenant_id, nombre, ruc) VALUES ($1, $2, 'ABC')`,
          [tenantId, idUnico("GRIFO")]
        )
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
