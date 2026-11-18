/** tests/combustible-requiere-flota.test.ts
 *
 * Combustible EXIGE Flota (`requiere: ["flota"]`, como Viajes): el vale, las tanquetas, la urea y
 * la compra en ruta se despachan a una unidad, y un grifo sin unidades no tiene sentido. Flota, en
 * cambio, funciona sola. Cada empresa ve solo lo que contrató; lo que se fija:
 *
 * 1. El registry declara la dependencia y Flota no depende de Combustible.
 * 2. Plataforma rechaza encender Combustible si la empresa no tiene Flota (400, «requiere»), y lo
 *    acepta con Flota.
 * 3. Una empresa solo con Flota funciona (sin Combustible), y una con Flota + Combustible, también.
 * 4. Si la empresa pierde Flota con Combustible encendido, el login lo oculta y su ruta responde 403
 *    (la fila del módulo sigue ahí).
 * 5. Apagar Combustible no borra sus datos: al volver a encenderlo reaparecen.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("Combustible exige Flota", () => {
  const empresas: Empresa[] = [];
  const nueva = async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    return e;
  };

  /** Pone exactamente esos módulos (más el Dashboard) como habilitados; el resto, apagados. */
  const ponerModulos = (e: Empresa, habilitados: string[]) =>
    request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: ["dashboard", ...habilitados].includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });

  // Los módulos del usuario viajan en el JWT: tras cambiarlos hay que entrar de nuevo.
  const sesion = async (e: Empresa) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return { agente, modulos: res.body.usuario.modulosPermitidos as string[] };
  };

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("el registry declara que Combustible exige Flota, y Flota no exige nada", () => {
    expect(MODULOS.find((m) => m.id === "combustible")?.requiere).toEqual(["flota"]);
    expect(MODULOS.find((m) => m.id === "flota")?.requiere ?? []).toEqual([]);
  });

  it("plataforma rechaza encender Combustible sin Flota y lo acepta con Flota", async () => {
    const e = await nueva();
    const sinFlota = await ponerModulos(e, ["combustible"]);
    expect(sinFlota.status, JSON.stringify(sinFlota.body)).toBe(400);
    expect(JSON.stringify(sinFlota.body)).toMatch(/Combustible.*requiere.*flota/i);

    const conFlota = await ponerModulos(e, ["flota", "combustible"]);
    expect(conFlota.status, JSON.stringify(conFlota.body)).toBe(200);
  });

  it("una empresa solo con Flota no ve Combustible, y con Flota + Combustible ve los dos", async () => {
    const e = await nueva();
    expect((await ponerModulos(e, ["flota"])).status).toBe(200);
    const soloFlota = await sesion(e);
    expect(soloFlota.modulos).toContain("flota");
    expect(soloFlota.modulos).not.toContain("combustible");
    expect((await soloFlota.agente.get("/api/erp/combustible")).status).toBe(403);

    expect((await ponerModulos(e, ["flota", "combustible"])).status).toBe(200);
    const ambos = await sesion(e);
    expect(ambos.modulos).toEqual(expect.arrayContaining(["flota", "combustible"]));
    expect((await ambos.agente.get("/api/erp/combustible")).status).toBe(200);
  });

  it("si la empresa pierde Flota con Combustible encendido, el login oculta Combustible y su ruta da 403", async () => {
    const e = await nueva();
    expect(await sesion(e).then((s) => s.modulos)).toContain("combustible");

    // Por fuera de la API, que ya lo impediría: la fila de Combustible sigue habilitada.
    await pool.query(
      `UPDATE tenant_modulos SET estado = 'deshabilitado' WHERE tenant_id = $1 AND modulo = 'flota'`,
      [e.tenant.id]
    );
    const { agente, modulos } = await sesion(e);
    expect(modulos).not.toContain("flota");
    expect(modulos).not.toContain("combustible");
    expect((await agente.get("/api/erp/combustible")).status).toBe(403);
    const fila = await pool.query(
      `SELECT estado FROM tenant_modulos WHERE tenant_id = $1 AND modulo = 'combustible'`,
      [e.tenant.id]
    );
    expect(fila.rows[0].estado).toBe("habilitado");
  });

  it("apagar Flota y Combustible juntos es válido, no borra los datos, y al volver a encenderlos reaparecen", async () => {
    const e = await nueva();
    const presentaciones = () =>
      withTenant(e.tenant.id, async (c) =>
        Number(
          (
            await c.query(
              `SELECT count(*) AS n FROM combustible_urea_presentaciones WHERE tenant_id = $1`,
              [e.tenant.id]
            )
          ).rows[0].n
        )
      );
    const antes = await presentaciones();
    expect(antes).toBeGreaterThan(0);

    expect((await ponerModulos(e, [])).status).toBe(200);
    const apagada = await sesion(e);
    expect(apagada.modulos).not.toContain("flota");
    expect(apagada.modulos).not.toContain("combustible");
    expect(await presentaciones()).toBe(antes);

    expect((await ponerModulos(e, ["flota", "combustible"])).status).toBe(200);
    const vuelve = await sesion(e);
    expect(vuelve.modulos).toEqual(expect.arrayContaining(["flota", "combustible"]));
    expect(await presentaciones()).toBe(antes);
  });
});
