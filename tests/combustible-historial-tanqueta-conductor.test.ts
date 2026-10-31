/** Historial de "Carga desde tanqueta" del conductor.
 *
 *  La pantalla Tanques del conductor lista las cargas que él sacó de una
 *  tanqueta (GET /despachos?origen=tanqueta). El guardia pedía el historial
 *  completo de despachos, que el conductor no tiene: recibía 403. Estos tests
 *  fijan que ahora entra a ESE origen y a ningún otro, y que le sigue
 *  llegando solo lo suyo.
 *
 *  Cada permiso concedido con su gemelo negado (método de
 *  combustible-comprobante-adversario.test.ts). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const password = "ClaveDePrueba123";
const base = "/api/erp/combustible";
let seq = 0;

describe("combustible: historial de cargas desde tanqueta del conductor", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);

  async function persona(rol: string, overrides: Record<string, boolean> = {}, dniFijo?: string) {
    const agente = request.agent(app);
    const dni = dniFijo ?? String(86700000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `T ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    for (const [pestana, permitido] of Object.entries(overrides)) {
      await withTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
           VALUES ($1,$2,'combustible',$3,$4)`,
          [tenantId, alta.body.id, pestana, permitido]
        )
      );
    }
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
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("el conductor lista sus cargas desde tanqueta", async () => {
    const conductor = await persona("conductor_ruta");
    const r = await conductor.get(`${base}/despachos?origen=tanqueta`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  it("gemelo: con el permiso de registrar cargas quitado, no entra", async () => {
    const conductor = await persona("conductor_ruta", { "tanques:registrar_despacho": false });
    const r = await conductor.get(`${base}/despachos?origen=tanqueta`);
    expect(r.status).toBe(403);
  });

  it("el permiso no se extiende a otros orígenes ni al listado sin filtro", async () => {
    const conductor = await persona("conductor_ruta");
    for (const url of [
      `${base}/despachos?origen=tanque_propio`,
      `${base}/despachos?origen=excedente_recepcion`,
      `${base}/despachos?origen=almacen`,
      `${base}/despachos`,
      `${base}/despachos/huecos`,
    ]) {
      expect((await conductor.get(url)).status, url).toBe(403);
    }
  });

  it("el admin sigue viendo el listado de tanqueta", async () => {
    const r = await admin.get(`${base}/despachos?origen=tanqueta`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("la carga que sacó llega sin el costo interno ni quién anuló, con la placa; otro conductor no la ve", async () => {
    const grifo = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const dniA = String(86800000 + Math.floor(Math.random() * 90000) + seq++);
    const a = await persona("conductor_ruta", {}, dniA);
    const b = await persona("conductor_ruta");
    const placa = idUnico("VQ");
    const equipo = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: placa,
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: grifo,
        conductor_nombre: "Conductor A",
        conductor_dni: dniA,
      })
    ).body.id as number;
    const tanque = (
      await admin.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Huamachuco",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 10000,
        nivel_actual: 8000,
        requiere_documento: false,
        grifo_interno_id: grifo,
      })
    ).body.id as number;
    const tanqueta = Number(
      (await admin.post(`${base}/tanquetas`).send({ grifo_interno_id: grifo })).body.id
    );
    const llenado = await admin.post(`${base}/despachos`).send({
      origen: "tanque_propio",
      combustible_id: tanque,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tanqueta,
      serie_talonario: "HMC",
      n_vale: 1,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
    });
    expect(llenado.status, JSON.stringify(llenado.body)).toBe(201);
    const asignada = await admin
      .put(`${base}/tanquetas/${tanqueta}/asignar`)
      .send({ equipo_id: equipo, serie_talonario: "HMC", n_vale: 2 });
    expect(asignada.status, JSON.stringify(asignada.body)).toBe(200);
    const carga = await a.post(`${base}/despachos`).send({
      origen: "tanqueta",
      tanqueta_origen_id: tanqueta,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo,
      cantidad: 10,
      lectura_horometro: 1000,
    });
    expect(carga.status, JSON.stringify(carga.body)).toBe(201);

    const suyas = await a.get(`${base}/despachos?origen=tanqueta`);
    expect(suyas.status).toBe(200);
    expect(suyas.body.data).toHaveLength(1);
    const fila = suyas.body.data[0];
    expect(fila.id).toBe(carga.body.id);
    expect(fila.placa_codigo).toBe(placa);
    for (const interno of [
      "costo_unitario",
      "costo_total",
      "costo_origen",
      "anulada_por",
      "motivo_anulacion",
    ]) {
      expect(fila, interno).not.toHaveProperty(interno);
    }
    expect(suyas.body.pagination.total).toBe(1);

    // Gemelo: el administrador sí ve el costo de ese mismo vale.
    const delAdmin = (await admin.get(`${base}/despachos?origen=tanqueta`)).body.data.find(
      (d: { id: number }) => d.id === carga.body.id
    );
    expect(Number(delAdmin.costo_unitario)).toBe(16);

    // El otro conductor no ve la carga de A.
    const deB = await b.get(`${base}/despachos?origen=tanqueta`);
    expect(deB.status).toBe(200);
    expect(deB.body.data).toHaveLength(0);
  });
});
