/** tests/alertas-por-modulo.test.ts
 *
 * Las alertas viven todas en `combustible_alertas`, pero cada una pertenece a un módulo:
 * Combustible, Urea o Flota (viaje demorado o detenido). La campanita y la Bandeja las
 * agrupan por módulo y cada persona ve solo las de los módulos que tiene. Lo que se fija:
 *
 * 1. Que el reparto de tipos a módulos del cliente y el del servidor coincidan.
 * 2. Que quien no tiene el módulo `viajes` no vea, cuente, marque como leídas ni resuelva las
 *    alertas de viaje (ni siquiera el administrador), y que las demás sigan igual.
 * 3. Que el filtro `modulo` de la Bandeja reparta bien y rechace valores raros.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { grupoDeAlerta, tiposSinModulo } from "../src/modules/combustible/alertasPorModulo";
import { TIPOS_ALERTA } from "../src/modules/combustible/combustible.repository";
import { MODULOS } from "../src/modules/registry";
import { grupoDeAlerta as grupoDelCliente } from "../client/src/components/combustible/alertasTexto";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const TIPOS = ["viaje_demorado", "viaje_detenido", "tanque_sin_vigilancia", "urea_stock_bajo"];

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("alertas por módulo", () => {
  const empresas: Empresa[] = [];
  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  /** Una empresa con cuatro alertas (dos de viaje, una de combustible, una de urea). */
  async function empresaConAlertas() {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    await withTenant(e.tenant.id, async (c) => {
      let n = 1;
      for (const tipo of TIPOS) {
        await c.query(
          `INSERT INTO combustible_alertas (tenant_id, tipo, serie_talonario, n_vale, detalle)
           VALUES ($1, $2, 'T', $3, '{}'::jsonb)`,
          [e.tenant.id, tipo, n++]
        );
      }
    });
    return e;
  }
  const sesion = async (e: Empresa, email = e.usuario.email) => {
    const a = request.agent(app);
    await a
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD })
      .expect(200);
    return a;
  };
  const sinViajes = (e: Empresa) =>
    request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "viajes" ? "deshabilitado" : "habilitado",
        })),
      })
      .expect(200);
  const tiposVistos = async (a: request.Agent, query = "") =>
    ((await a.get(`/api/erp/combustible/alertas${query}`)).body.data as { tipo: string }[])
      .map((x) => x.tipo)
      .sort();
  const leidasEnBase = async (e: Empresa) =>
    (
      await withTenant(e.tenant.id, (c) =>
        c.query(`SELECT tipo, leida_en IS NOT NULL AS leida FROM combustible_alertas ORDER BY tipo`)
      )
    ).rows as { tipo: string; leida: boolean }[];

  it("el reparto de tipos a módulos del cliente es el mismo del servidor, para cada tipo de alerta", () => {
    for (const tipo of TIPOS_ALERTA) {
      expect(grupoDelCliente(tipo), tipo).toBe(grupoDeAlerta(tipo));
    }
    expect(grupoDeAlerta("viaje_demorado")).toBe("flota");
    expect(grupoDeAlerta("urea_stock_bajo")).toBe("urea");
    expect(grupoDeAlerta("hueco_detectado")).toBe("combustible");
  });

  it("solo se recortan alertas a quien tiene la lista de módulos y no tiene `viajes`", () => {
    expect(tiposSinModulo(["combustible", "viajes"])).toBeUndefined();
    expect(tiposSinModulo(undefined)).toBeUndefined(); // el correo no la trae: no se recorta
    expect(tiposSinModulo(["combustible"])).toEqual(["viaje_demorado", "viaje_detenido"]);
  });

  it("con el módulo `viajes`, el administrador ve y cuenta las cuatro, y el filtro `modulo` las reparte", async () => {
    const e = await empresaConAlertas();
    const admin = await sesion(e);
    expect(await tiposVistos(admin)).toEqual([...TIPOS].sort());
    expect((await admin.get("/api/erp/combustible/alertas/resumen")).body.total).toBe(4);

    expect(await tiposVistos(admin, "?modulo=flota")).toEqual(["viaje_demorado", "viaje_detenido"]);
    expect(await tiposVistos(admin, "?modulo=urea")).toEqual(["urea_stock_bajo"]);
    expect(await tiposVistos(admin, "?modulo=combustible")).toEqual(["tanque_sin_vigilancia"]);
    // El resumen respeta el mismo filtro.
    expect((await admin.get("/api/erp/combustible/alertas/resumen?modulo=flota")).body.total).toBe(
      2
    );
    // Un valor raro es 400, no un filtro ignorado en silencio.
    for (const raro of ["viajes", "FLOTA", "x'--", ""]) {
      const res = await admin.get(
        `/api/erp/combustible/alertas?modulo=${encodeURIComponent(raro)}`
      );
      if (raro === "")
        expect(res.status).toBe(200); // vacío = sin filtro
      else expect(res.status, raro).toBe(400);
    }
  });

  it("sin el módulo `viajes`, ni el administrador ve ni cuenta las alertas de viaje; las demás siguen", async () => {
    const e = await empresaConAlertas();
    await sinViajes(e);
    const admin = await sesion(e);

    expect(await tiposVistos(admin)).toEqual(["tanque_sin_vigilancia", "urea_stock_bajo"]);
    expect((await admin.get("/api/erp/combustible/alertas/resumen")).body.total).toBe(2);
    // Pedirlas por su módulo no las trae.
    expect(await tiposVistos(admin, "?modulo=flota")).toEqual([]);
    // Ni pidiendo el tipo exacto.
    expect(await tiposVistos(admin, "?tipo=viaje_demorado")).toEqual([]);
  });

  it("sin `viajes`, marcar leídas (todas o por id) no toca las de viaje; con `viajes`, sí", async () => {
    const e = await empresaConAlertas();
    const ids = (
      await withTenant(e.tenant.id, (c) =>
        c.query(`SELECT id, tipo FROM combustible_alertas ORDER BY id`)
      )
    ).rows as { id: string; tipo: string }[];
    const deViaje = ids.filter((x) => x.tipo.startsWith("viaje_")).map((x) => Number(x.id));

    await sinViajes(e);
    const admin = await sesion(e);
    // Por id: las de viaje no se marcan aunque se pidan.
    expect(
      (await admin.patch("/api/erp/combustible/alertas/leidas").send({ ids: deViaje })).status
    ).toBe(204);
    expect((await leidasEnBase(e)).filter((x) => x.leida)).toEqual([]);
    // Todas: se marcan las que ve y NO las de viaje, que otra persona sí tiene que atender.
    expect((await admin.patch("/api/erp/combustible/alertas/leidas").send({})).status).toBe(204);
    const despues = await leidasEnBase(e);
    expect(despues.filter((x) => x.leida).map((x) => x.tipo)).toEqual([
      "tanque_sin_vigilancia",
      "urea_stock_bajo",
    ]);
    expect(despues.filter((x) => !x.leida).map((x) => x.tipo)).toEqual([
      "viaje_demorado",
      "viaje_detenido",
    ]);
  });

  it("un operador sin `viajes` tampoco las ve (mismo recorte que el administrador)", async () => {
    const e = await empresaConAlertas();
    const admin = await sesion(e);
    const email = `${idUnico("operador")}@test.local`;
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Operador", email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    const operador = await sesion(e, email);
    expect(await tiposVistos(operador)).toEqual([...TIPOS].sort());

    await sinViajes(e);
    const operador2 = await sesion(e, email);
    expect(await tiposVistos(operador2)).toEqual(["tanque_sin_vigilancia", "urea_stock_bajo"]);
    expect((await operador2.get("/api/erp/combustible/alertas/resumen")).body.total).toBe(2);
  });

  it("las alertas de otra empresa nunca aparecen (el recorte por módulo no abre nada)", async () => {
    const a = await empresaConAlertas();
    const b = await empresaConAlertas();
    const adminA = await sesion(a);
    const idsDeB = (
      await withTenant(b.tenant.id, (c) => c.query(`SELECT id FROM combustible_alertas`))
    ).rows.map((x) => Number(x.id));
    const vistasPorA = (
      (await adminA.get("/api/erp/combustible/alertas")).body.data as { id: number }[]
    ).map((x) => Number(x.id));
    expect(vistasPorA.some((id) => idsDeB.includes(id))).toBe(false);
  });
});
