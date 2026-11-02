/** tests/platform-modulos-granular.test.ts
 *
 * Módulos por tenant más granulares (migrations/0021_tenant_modulos_granular.sql):
 * estado habilitado/deshabilitado/rollout, rollout_porcentaje, version, y
 * el toggle global. El caso base (habilitado/deshabilitado, intersección
 * con usuario_modulos) ya está cubierto en tests/platform-modulos.test.ts
 * — acá se prueba específicamente lo nuevo.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  redisDisponible,
} from "./helpers";
import { env } from "../src/server/config/env";
import { closeDatabase, pool } from "../src/server/config/database";
import { enBucketDeRollout } from "../src/server/services/auth.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

const conRedis = await redisDisponible();

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("enBucketDeRollout (determinístico, sin BD)", () => {
  it("0% nunca cae adentro, 100% siempre cae adentro, sin importar los IDs", () => {
    expect(enBucketDeRollout("t1", "iperc", "u1", 0)).toBe(false);
    expect(enBucketDeRollout("t1", "iperc", "u1", 100)).toBe(true);
    expect(enBucketDeRollout("otro-tenant", "checklists", "otro-usuario", 0)).toBe(false);
    expect(enBucketDeRollout("otro-tenant", "checklists", "otro-usuario", 100)).toBe(true);
  });

  it("mismos (tenant, módulo, usuario, porcentaje) siempre dan el mismo resultado", () => {
    const resultados = new Set(
      Array.from({ length: 20 }, () => enBucketDeRollout("tenant-x", "flota", "usuario-y", 42))
    );
    expect(resultados.size).toBe(1);
  });

  it("cambiar cualquiera de los tres IDs puede cambiar el bucket (no es solo función del porcentaje)", () => {
    // No determinístico cuál da true/false, pero al menos uno de estos
    // pares tiene que diferir del original para un porcentaje intermedio
    // razonable — si todos dieran igual, el hash no estaría usando los IDs.
    const base = enBucketDeRollout("tenant-a", "iperc", "usuario-1", 50);
    const variosResultados = new Set([
      base,
      enBucketDeRollout("tenant-b", "iperc", "usuario-1", 50),
      enBucketDeRollout("tenant-a", "checklists", "usuario-1", 50),
      enBucketDeRollout("tenant-a", "iperc", "usuario-2", 50),
    ]);
    expect(variosResultados.size).toBeGreaterThan(1);
  });
});

describe("estado 'rollout' de punta a punta", () => {
  it("rollout al 100% deja el módulo en modulosPermitidos; al 0% lo saca — estable entre logins", async () => {
    const { tenant, usuario } = await nuevoTenant();

    const configBase = [
      "repuestos",
      "combustible",
      "documentos",
      "dashboard",
      "flota",
      "checklists",
    ].map((modulo) => ({ modulo, estado: "habilitado" as const }));

    const al100 = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: [
          ...configBase,
          { modulo: "iperc", estado: "rollout", rolloutPorcentaje: 100 },
        ],
      });
    expect(al100.status).toBe(200);
    expect(al100.body.modulos.find((m: any) => m.modulo === "iperc").estado).toBe("rollout");

    const primerLogin = await request(app).post("/api/auth/login").send({
      tenantSlug: tenant.slug,
      email: usuario.email,
      password,
    });
    expect(primerLogin.status).toBe(200);
    expect(primerLogin.body.usuario.modulosPermitidos).toContain("iperc");

    // Mismo usuario, segundo login — el bucket tiene que ser el mismo.
    const segundoLogin = await request(app).post("/api/auth/login").send({
      tenantSlug: tenant.slug,
      email: usuario.email,
      password,
    });
    expect(segundoLogin.body.usuario.modulosPermitidos).toContain("iperc");

    const al0 = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: [
          ...configBase,
          { modulo: "iperc", estado: "rollout", rolloutPorcentaje: 0 },
        ],
      });
    expect(al0.status).toBe(200);

    const loginTrasApagar = await request(app).post("/api/auth/login").send({
      tenantSlug: tenant.slug,
      email: usuario.email,
      password,
    });
    expect(loginTrasApagar.body.usuario.modulosPermitidos).not.toContain("iperc");
  });

  it("valida que rolloutPorcentaje sea requerido cuando el estado es 'rollout'", async () => {
    const { tenant } = await nuevoTenant();

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({ configuraciones: [{ modulo: "iperc", estado: "rollout" }] });

    expect(res.status).toBe(400);
  });

  it("guarda y devuelve 'version' como metadata simple", async () => {
    const { tenant } = await nuevoTenant();

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({ configuraciones: [{ modulo: "iperc", estado: "habilitado", version: "v2" }] });

    expect(res.status).toBe(200);
    expect(res.body.modulos.find((m: any) => m.modulo === "iperc").version).toBe("v2");
  });
});

describe("PUT /modulos/:modulo/global", () => {
  it("aplica el mismo estado a TODOS los tenants de una sola vez", async () => {
    const { tenant: tenantA } = await nuevoTenant();
    const { tenant: tenantB } = await nuevoTenant();

    const res = await request(app)
      .put("/api/platform/modulos/dashboard/global")
      .set("Authorization", BEARER)
      .send({ estado: "deshabilitado" });

    expect(res.status).toBe(200);
    expect(res.body.tenantsAfectados).toBeGreaterThanOrEqual(2);

    const filaA = await pool.query(
      `SELECT estado FROM tenant_modulos WHERE tenant_id = $1 AND modulo = 'dashboard'`,
      [tenantA.id]
    );
    const filaB = await pool.query(
      `SELECT estado FROM tenant_modulos WHERE tenant_id = $1 AND modulo = 'dashboard'`,
      [tenantB.id]
    );
    expect(filaA.rows[0].estado).toBe("deshabilitado");
    expect(filaB.rows[0].estado).toBe("deshabilitado");

    // Reactivar para no ensuciar el resto de la suite.
    await request(app)
      .put("/api/platform/modulos/dashboard/global")
      .set("Authorization", BEARER)
      .send({ estado: "habilitado" });
  });

  it("da 400 con un nombre de módulo desconocido", async () => {
    const res = await request(app)
      .put("/api/platform/modulos/no-existe/global")
      .set("Authorization", BEARER)
      .send({ estado: "habilitado" });
    expect(res.status).toBe(400);
  });

  it.skipIf(!conRedis)(
    "un platform_admin sin rol super_admin no puede aplicar el toggle global (403)",
    async () => {
      const email = `${idUnico("no-super-global")}@platform-admin-test.local`;
      await request(app)
        .post("/api/platform/admins")
        .set("Authorization", BEARER)
        .send({ email, password: "ClaveDePrueba123", nombre: "No super", rol: "admin" });

      const agent = request.agent(app);
      const login = await agent
        .post("/api/platform/admin-sesion")
        .send({ email, password: "ClaveDePrueba123" });
      expect(login.status).toBe(200);

      const res = await agent
        .put("/api/platform/modulos/dashboard/global")
        .send({ estado: "habilitado" });
      expect(res.status).toBe(403);

      await pool.query(`DELETE FROM platform_admins WHERE email = $1`, [email]);
    }
  );
});
