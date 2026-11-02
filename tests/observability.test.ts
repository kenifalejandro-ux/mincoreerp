/** tests/observability.test.ts
 *
 * Ver docs/architecture/observabilidad-y-logs.md. Dos capas separadas:
 *
 *  - Logger (ALS + mixin + redacción): se prueba con una instancia de pino
 *    propia, construida con las mismas `loggerOptions` que usa la app pero
 *    escribiendo a un stream en memoria en vez de stdout — así se puede
 *    leer línea por línea sin parsear la salida real del proceso.
 *  - Métricas por tenant (latencia/4xx): igual que tests/tenant-health.test.ts,
 *    contra Postgres real vía supertest, porque tenantMetricsMiddleware
 *    escribe async (`res.on("finish")`) y hay que esperar un toque.
 */
import { Writable } from "node:stream";
import type { Request } from "express";
import pino from "pino";
import request from "supertest";
import { describe, it, expect, afterAll } from "vitest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, esperarHasta } from "./helpers";
import { loggerOptions } from "../src/server/config/logger";
import { runWithRequestContext } from "../src/server/shared/requestContext";
import { pool, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";

const BEARER = `Bearer ${env.platformAdminToken}`;

function crearLoggerDePrueba() {
  const lineas: any[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      lineas.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const logger = pino(loggerOptions, stream);
  return { logger, lineas };
}

describe("x-request-id", () => {
  it("se inyecta en la respuesta aunque el cliente no lo mande", async () => {
    const res = await request(app).get("/status");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("si el cliente manda x-request-id, se reusa el mismo en la respuesta", async () => {
    const res = await request(app).get("/status").set("x-request-id", "id-de-prueba-123");
    expect(res.headers["x-request-id"]).toBe("id-de-prueba-123");
  });
});

describe("logger: contexto automático vía AsyncLocalStorage", () => {
  it("agrega requestId/tenantId/usuarioId a cualquier log dentro del contexto de la petición", () => {
    const { logger, lineas } = crearLoggerDePrueba();
    const fakeReq = {
      id: "req-abc",
      tenantId: "tenant-xyz",
      usuario: { id: "usuario-123" },
    } as unknown as Request;

    runWithRequestContext(fakeReq, () => {
      logger.info("evento dentro del contexto");
    });

    expect(lineas).toHaveLength(1);
    expect(lineas[0].requestId).toBe("req-abc");
    expect(lineas[0].tenantId).toBe("tenant-xyz");
    expect(lineas[0].usuarioId).toBe("usuario-123");
  });

  it("no agrega esos campos fuera de cualquier contexto de petición", () => {
    const { logger, lineas } = crearLoggerDePrueba();
    logger.info("evento sin contexto (arranque del server, un cron, etc.)");

    expect(lineas).toHaveLength(1);
    expect(lineas[0].requestId).toBeUndefined();
    expect(lineas[0].tenantId).toBeUndefined();
    expect(lineas[0].usuarioId).toBeUndefined();
  });
});

describe("logger: redacción recursiva de campos sensibles", () => {
  it("enmascara password/token/authorization/secret/creditCard sin importar la profundidad", () => {
    const { logger, lineas } = crearLoggerDePrueba();

    logger.info(
      {
        password: "hunter2",
        safe: "esto no es sensible",
        detalle: {
          token: "abc.def.ghi",
          nested: {
            authorization: "Bearer xyz",
            creditCard: "4111111111111111",
            secret: "shh",
            tambienSafe: 42,
          },
        },
      },
      "evento con datos sensibles"
    );

    expect(lineas).toHaveLength(1);
    const [linea] = lineas;
    expect(linea.password).toBe("[redacted]");
    expect(linea.detalle.token).toBe("[redacted]");
    expect(linea.detalle.nested.authorization).toBe("[redacted]");
    expect(linea.detalle.nested.creditCard).toBe("[redacted]");
    expect(linea.detalle.nested.secret).toBe("[redacted]");
    expect(linea.safe).toBe("esto no es sensible");
    expect(linea.detalle.nested.tambienSafe).toBe(42);
  });
});

describe("métricas por tenant: latencia y errores 4xx", () => {
  const password = "ClaveDePrueba123";
  const tenantsCreados: string[] = [];

  // tenantMetricsMiddleware escribe la métrica con fire-and-forget dentro
  // de res.on("finish"), así que cuando supertest devuelve, la fila puede
  // no estar. Antes esto se esperaba con un sleep fijo de 200 ms y hacía
  // este archivo flaky en la suite completa — ver esperarHasta() en
  // helpers.ts.
  function metricasDelTenant(tenantId: string) {
    return pool.query(
      `SELECT COALESCE(sum(latencia_total_ms), 0) AS latencia,
              COALESCE(sum(requests_error_4xx), 0) AS errores_4xx,
              COALESCE(sum(requests_error_5xx), 0) AS errores_5xx
       FROM tenant_metricas_horarias WHERE tenant_id = $1`,
      [tenantId]
    );
  }

  async function nuevoTenant() {
    const creado = await crearTenantDePrueba(password);
    tenantsCreados.push(creado.tenant.id);
    return creado;
  }

  afterAll(async () => {
    for (const id of tenantsCreados) await borrarTenantDePrueba(id);
    await closeDatabase();
  });

  it("una request exitosa suma latencia_total_ms en la hora actual del tenant", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: tenant.slug, email: usuario.email, password });

    await agent.get("/api/erp/repuestos");

    const fila = await esperarHasta(
      () => metricasDelTenant(tenant.id),
      (r) => Number(r.rows[0].latencia) > 0,
      "que latencia_total_ms del tenant suba después de un GET al ERP"
    );
    expect(Number(fila.rows[0].latencia)).toBeGreaterThan(0);
  });

  it("una request bloqueada por módulo no habilitado (403) cuenta como error 4xx, no 5xx", async () => {
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
      }); // iperc queda deshabilitado

    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: tenant.slug, email: usuario.email, password });

    const bloqueado = await agent.get("/api/erp/iperc");
    expect(bloqueado.status).toBe(403);

    const fila = await esperarHasta(
      () => metricasDelTenant(tenant.id),
      (r) => Number(r.rows[0].errores_4xx) > 0,
      "que un 403 por módulo no habilitado se contabilice como error 4xx"
    );
    expect(Number(fila.rows[0].errores_4xx)).toBeGreaterThan(0);
    expect(Number(fila.rows[0].errores_5xx)).toBe(0);
  });
});
