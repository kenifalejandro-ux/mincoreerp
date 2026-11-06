/** tests/platform-conductor-crea-viaje.test.ts
 *
 * El interruptor por empresa «los conductores pueden crear su propio viaje» (0179), desde el panel
 * de plataforma: PUT /api/platform/tenants/:id/conductor-crea-viaje. Apagado por defecto, se ve en
 * el listado de empresas, queda en la auditoría con el antes y el después, y rechaza lo inválido.
 * (No hay e2e de la casilla: el panel de plataforma no tiene credenciales sembradas en e2e.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, pool } from "../src/server/config/database";
import { env } from "../src/server/config/env";

const token = `Bearer ${env.platformAdminToken}`;

describe("plataforma: interruptor «el conductor crea su viaje» (0179)", () => {
  let tenantId: string;

  beforeAll(async () => {
    tenantId = (await crearTenantDePrueba()).tenant.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const listado = async () => {
    const r = await request(app).get("/api/platform/tenants").set("Authorization", token);
    expect(r.status).toBe(200);
    return r.body.tenants.find((t: { id: string }) => t.id === tenantId);
  };
  const poner = (activo: unknown, id = tenantId) =>
    request(app)
      .put(`/api/platform/tenants/${id}/conductor-crea-viaje`)
      .set("Authorization", token)
      .send({ activo, motivo: "Prueba" });

  it("nace apagado y el listado lo dice", async () => {
    expect((await listado()).conductorCreaViaje).toBe(false);
  });

  it("encenderlo y apagarlo se refleja en el listado y en la base", async () => {
    const on = await poner(true);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.tenant).toMatchObject({ id: tenantId, conductorCreaViaje: true });
    expect((await listado()).conductorCreaViaje).toBe(true);
    const fila = await pool.query(`SELECT conductor_crea_viaje FROM tenants WHERE id = $1`, [
      tenantId,
    ]);
    expect(fila.rows[0].conductor_crea_viaje).toBe(true);

    expect((await poner(false)).status).toBe(200);
    expect((await listado()).conductorCreaViaje).toBe(false);
  });

  it("queda en la auditoría de plataforma con el valor de antes y el de después", async () => {
    await poner(true);
    const r = await pool.query(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'cambiar_conductor_crea_viaje'
        ORDER BY id DESC LIMIT 1`,
      [tenantId]
    );
    expect(r.rows[0].detalle).toMatchObject({
      before: { conductorCreaViaje: false },
      after: { conductorCreaViaje: true },
      motivo: "Prueba",
    });
  });

  it("rechaza un valor que no es sí o no, una empresa que no existe y a quien no es de plataforma", async () => {
    expect((await poner("si")).status).toBe(400);
    expect((await poner(true, "00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const sinToken = await request(app)
      .put(`/api/platform/tenants/${tenantId}/conductor-crea-viaje`)
      .send({ activo: true });
    expect([401, 403]).toContain(sinToken.status);
  });
});
