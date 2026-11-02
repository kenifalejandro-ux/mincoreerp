/** tests/tenant-health.test.ts
 *
 * Observabilidad básica por tenant (migrations/0022_tenant_metricas_horarias.sql).
 * tenantMetrics.middleware.ts escribe de forma asíncrona (`res.on("finish")`,
 * sin await en el ciclo de respuesta) — así que cuando supertest devuelve la
 * respuesta, la fila puede no estar todavía.
 *
 * Esa espera se hace con esperarHasta() y NO con un sleep fijo: la versión
 * anterior dormía 200 ms y consultaba, lo que hacía este archivo flaky en
 * la suite completa (falló 2 veces en dos meses con "expected 0 to be
 * greater than 0", pasando siempre aislado). Ver el comentario de
 * esperarHasta en helpers.ts.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, esperarHasta } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase } from "../src/server/config/database";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

function sumaRequestsTotal(tenantId: string) {
  return pool.query(
    `SELECT COALESCE(sum(requests_total), 0) AS total FROM tenant_metricas_horarias WHERE tenant_id = $1`,
    [tenantId]
  );
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("registrarMetricaRequest / tenantMetricsMiddleware", () => {
  it("una request exitosa a una ruta del ERP incrementa requests_total del tenant en la hora actual", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: tenant.slug, email: usuario.email, password });

    const antes = await sumaRequestsTotal(tenant.id);

    await agent.get("/api/erp/repuestos");

    const despues = await esperarHasta(
      () => sumaRequestsTotal(tenant.id),
      (r) => Number(r.rows[0].total) > Number(antes.rows[0].total),
      "que requests_total del tenant suba después de un GET al ERP"
    );
    expect(Number(despues.rows[0].total)).toBeGreaterThan(Number(antes.rows[0].total));
  });

  it("una request bloqueada por módulo no habilitado (403) también cuenta como tráfico, y como error si aplicara", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await request(app)
      .put(`/api/platform/tenants/${tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: [
          "repuestos",
          "combustible",
          "documentos",
          "dashboard",
          "flota",
          "checklists",
        ].map((modulo) => ({ modulo, estado: "habilitado" })),
      }); // iperc queda deshabilitado (no está en la lista)

    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: tenant.slug, email: usuario.email, password });

    const antes = await sumaRequestsTotal(tenant.id);

    const bloqueado = await agent.get("/api/erp/iperc");
    expect(bloqueado.status).toBe(403);

    const despues = await esperarHasta(
      () => sumaRequestsTotal(tenant.id),
      (r) => Number(r.rows[0].total) > Number(antes.rows[0].total),
      "que un 403 por módulo no habilitado también sume a requests_total"
    );
    expect(Number(despues.rows[0].total)).toBeGreaterThan(Number(antes.rows[0].total));
  });
});

describe("GET /tenants/:id/salud", () => {
  it("devuelve usuarios activos/total, y refleja tráfico reciente", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: tenant.slug, email: usuario.email, password });
    await agent.get("/api/erp/repuestos");

    // Se espera sobre el endpoint de salud en sí (no sobre la tabla): es lo
    // que este test asserta, y así el poll termina exactamente cuando la
    // métrica ya se ve reflejada en la respuesta que se va a verificar.
    const res = await esperarHasta(
      () =>
        request(app).get(`/api/platform/tenants/${tenant.id}/salud`).set("Authorization", BEARER),
      (r) => r.status === 200 && Number(r.body?.salud?.requestsUltimas24h) > 0,
      "que GET /tenants/:id/salud refleje el tráfico recién generado"
    );

    expect(res.status).toBe(200);
    expect(res.body.salud.usuariosActivos).toBe(1);
    expect(res.body.salud.usuariosTotal).toBe(1);
    expect(res.body.salud.ultimoAcceso).not.toBeNull();
    expect(res.body.salud.requestsUltimas24h).toBeGreaterThan(0);
    expect(res.body.salud.alertas).toEqual([]);
  });

  it("da 404 para un tenant inexistente", async () => {
    const res = await request(app)
      .get(`/api/platform/tenants/00000000-0000-0000-0000-000000000000/salud`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(404);
  });

  it("marca la alerta de tasa de error alta cuando se supera el umbral con volumen suficiente", async () => {
    const { tenant } = await nuevoTenant();
    // Vuelca directo la métrica horaria en vez de generar 20+ requests
    // reales fallidas — más rápido y determinístico para probar el umbral.
    await pool.query(
      `INSERT INTO tenant_metricas_horarias (tenant_id, hora, requests_total, requests_error_5xx, recursos_creados)
       VALUES ($1, date_trunc('hour', now()), 100, 10, 0)`,
      [tenant.id]
    );

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/salud`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(res.body.salud.tasaError).toBeCloseTo(0.1);
    expect(res.body.salud.alertas).toContain("alta_tasa_error_5xx");
  });

  it("marca la alerta de creación anómala de recursos por encima del umbral", async () => {
    const { tenant } = await nuevoTenant();
    await pool.query(
      `INSERT INTO tenant_metricas_horarias (tenant_id, hora, requests_total, requests_error_5xx, recursos_creados)
       VALUES ($1, date_trunc('hour', now()), 1000, 0, 600)`,
      [tenant.id]
    );

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/salud`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(res.body.salud.alertas).toContain("creacion_anomala_de_recursos");
  });
});

describe("GET /tenants/salud", () => {
  it("devuelve un resumen con al menos un tenant", async () => {
    await nuevoTenant();
    const res = await request(app).get(`/api/platform/tenants/salud`).set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.salud)).toBe(true);
    expect(res.body.salud.length).toBeGreaterThan(0);
  });
});
