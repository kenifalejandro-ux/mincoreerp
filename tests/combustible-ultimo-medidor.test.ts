/** tests/combustible-ultimo-medidor.test.ts
 *
 * GET /api/erp/combustible/equipos/:equipoId/ultimo-medidor -- la carga
 * anterior de una unidad, para que el formulario de compra en ruta calcule solo
 * las "horas abastecidas" (lectura actual - lectura de la carga anterior).
 *
 * Método de siempre: cada ataque con su gemelo legítimo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const password = "ClaveDePrueba123";
let seq = 0;

type Agente = ReturnType<typeof request.agent>;

describe("combustible: último medidor de una unidad", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  const vecino = request.agent(app);
  let tenantVecinoId: string;
  let proveedor: number;
  let equipo: number;

  const ruta = (id: number | string, query = "") =>
    `/api/erp/combustible/equipos/${id}/ultimo-medidor${query}`;

  const compra = (extra: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "compra_externa",
      grifo_id: proveedor,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Date.now().toString().slice(-6)}${seq++}`,
      cantidad: 40,
      lectura_horometro: 1000,
      horas_abastecidas: 10,
      costo_unitario: 17.5,
      despachado_en: new Date().toISOString(),
      ...extra,
    });

  async function persona(rol: string): Promise<Agente> {
    const agente = request.agent(app);
    const dni = String(86100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const r = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(r.status).toBe(200);
    return agente;
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });

    equipo = (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EXC"), tipo: "EXCAVADORA", tipo_medidor: "horometro" })
    ).body.id;
    proveedor = (await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("PX") }))
      .body.id;

    const v = await crearTenantDePrueba(password);
    tenantVecinoId = v.tenant.id;
    await vecino
      .post("/api/auth/login")
      .send({ tenantSlug: v.tenant.slug, email: v.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(tenantVecinoId);
    await closeDatabase();
  });

  it("una unidad sin cargas no tiene carga anterior (null, no un error)", async () => {
    const r = await admin.get(ruta(equipo));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ultimo: null });
  });

  it("devuelve la lectura de la carga MÁS RECIENTE", async () => {
    const primera = await compra({
      lectura_horometro: 1000,
      despachado_en: "2026-09-01T10:00:00.000Z",
    });
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);
    const segunda = await compra({
      lectura_horometro: 1012.5,
      despachado_en: "2026-09-02T10:00:00.000Z",
    });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(201);

    const r = await admin.get(ruta(equipo));
    expect(r.status).toBe(200);
    expect(r.body.ultimo.lectura_horometro).toBe(1012.5);
    expect(r.body.ultimo.lectura_odometro).toBeNull();
    expect(r.body.ultimo.despachado_en).toBe("2026-09-02T10:00:00.000Z");
  });

  it("con `antes_de` devuelve la carga que quedó ANTES de esa fecha (carga retroactiva)", async () => {
    const r = await admin.get(ruta(equipo, "?antes_de=2026-09-02T00:00:00.000Z"));
    expect(r.status).toBe(200);
    expect(r.body.ultimo.lectura_horometro).toBe(1000);
  });

  it("antes de la primera carga no hay anterior", async () => {
    const r = await admin.get(ruta(equipo, "?antes_de=2026-08-01T00:00:00.000Z"));
    expect(r.body).toEqual({ ultimo: null });
  });

  it("una carga ANULADA no cuenta como anterior", async () => {
    const tercera = await compra({
      lectura_horometro: 1030,
      despachado_en: "2026-09-03T10:00:00.000Z",
    });
    expect(tercera.status).toBe(201);
    expect((await admin.get(ruta(equipo))).body.ultimo.lectura_horometro).toBe(1030);

    const anulada = await admin
      .patch(`/api/erp/combustible/despachos/${tercera.body.id}/anular`)
      .send({ motivo: "cargada por error" });
    expect(anulada.status).toBe(200);
    expect((await admin.get(ruta(equipo))).body.ultimo.lectura_horometro).toBe(1012.5);
  });

  it("ataque: otro tenant consulta la unidad -> null, sin ver el medidor ajeno", async () => {
    const r = await vecino.get(ruta(equipo));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ultimo: null });
  });

  it("ataque: id que no es número -> 400", async () => {
    expect((await admin.get(ruta("abc"))).status).toBe(400);
    expect((await admin.get(ruta(0))).status).toBe(400);
  });

  it("ataque: antes_de que no es una fecha -> 400", async () => {
    expect((await admin.get(ruta(equipo, "?antes_de=ayer"))).status).toBe(400);
  });

  describe("roles", () => {
    for (const rol of ["lectura", "grifero", "encargado_urea"]) {
      it(`ataque: ${rol} -> 403 (no registra compras en ruta, no necesita este dato)`, async () => {
        const p = await persona(rol);
        expect((await p.get(ruta(equipo))).status).toBe(403);
      });
    }

    it("gemelo: el conductor de ruta sí lo consulta", async () => {
      const p = await persona("conductor_ruta");
      const r = await p.get(ruta(equipo));
      expect(r.status).toBe(200);
      expect(r.body.ultimo.lectura_horometro).toBe(1012.5);
    });
  });
});
