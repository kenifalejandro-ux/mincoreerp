/** tests/combustible-con-mantenimiento.test.ts
 *
 * Las unidades son un maestro único que mantiene Flota o Mantenimiento. Combustible lee la unidad
 * (placa, medidor) para mostrarla o validarla si la EMPRESA tiene cualquiera de los dos. Lo que se fija,
 * con una empresa que tiene Combustible y Mantenimiento pero NO Flota:
 *
 * 1. Se puede elegir una unidad de Mantenimiento en un vale (no es un 400 de «sin Flota»), y el
 *    historial del vale trae su placa.
 * 2. `equipos-destino` ofrece esa unidad, y deja de ofrecerla cuando Mantenimiento la quita.
 * 3. La sugerencia de consumo de la unidad la encuentra.
 * 4. Lo que es propio de Flota sigue con Flota: la unidad asignada al conductor no existe sin ella.
 *
 * (Sin ningún módulo de unidades lo cubren combustible-sin-flota y los *-placa-escrita.) */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico, dniUnico } from "./helpers";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/combustible";
const serieUnica = () => `S${Math.floor(Math.random() * 1e8).toString(36)}`.toUpperCase();

describe("Combustible con Mantenimiento y sin Flota", () => {
  let tenantId: string;
  let tanqueId: number;
  let equipoId: number;
  let slug: string;
  const placa = idUnico("CM").toUpperCase();
  const admin = request.agent(app);
  let n = 0;

  const vale = (over: Record<string, unknown> = {}) =>
    admin.post(`${BASE}/despachos`).send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      serie_talonario: serieUnica(),
      n_vale: ++n,
      cantidad: 50,
      lectura_contometro: 50,
      costo_unitario: 27.5,
      despachado_en: new Date().toISOString(),
      ...over,
    });
  const placasOfrecidas = async () => {
    const r = await admin.get(`${BASE}/equipos-destino`);
    expect(r.status).toBe(200);
    return (r.body.data as Array<{ placa_codigo: string }>).map((u) => u.placa_codigo);
  };

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(PASSWORD);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    // Sin Flota desde el principio: los módulos del usuario viajan en el JWT, así que se apaga ANTES de
    // entrar. Mantenimiento queda encendido.
    await pool.query(
      `UPDATE tenant_modulos SET estado = 'deshabilitado' WHERE tenant_id = $1 AND modulo = 'flota'`,
      [tenantId]
    );
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password: PASSWORD });

    const tq = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque con mantenimiento",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
    });
    expect(tq.status, JSON.stringify(tq.body)).toBe(201);
    tanqueId = tq.body.id;

    // La unidad se registra en Mantenimiento, no en Flota.
    const eq = await admin.post("/api/erp/mantenimiento/equipos").send({
      placa_codigo: placa,
      tipo: "Volquete",
      medidor: "odometro",
      lectura: 100,
      propiedad: "propia",
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    equipoId = Number(eq.body.id);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("de verdad no tiene Flota: su lista de equipos no existe", async () => {
    expect((await admin.get("/api/erp/equipos")).status).toBe(403);
  });

  it("se elige la unidad de Mantenimiento en un vale y el historial trae su placa", async () => {
    const v = await vale({ tipo_destino: "equipo", equipo_id: equipoId });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.equipo_id).toBe(equipoId);

    const lista = await admin.get(`${BASE}/despachos`);
    expect(lista.status).toBe(200);
    const fila = (lista.body.data as Array<Record<string, unknown>>).find(
      (f) => Number(f.id) === Number(v.body.id)
    );
    expect(fila?.placa_codigo).toBe(placa);
  });

  it("la sugerencia de consumo encuentra la unidad", async () => {
    const r = await admin.get(`${BASE}/equipos/${equipoId}/sugerencia-consumo`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("lo que es propio de Flota sigue con Flota: la unidad asignada al conductor no existe sin ella", async () => {
    const dni = dniUnico();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Conductor CM", dni, password: PASSWORD, rol: "conductor_ruta" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    // La unidad tiene a ese conductor (dato que mantiene Flota): sin Flota no se lee.
    await withTenant(tenantId, (client) =>
      client.query(`UPDATE equipos SET conductor_dni = $2 WHERE tenant_id = $1 AND id = $3`, [
        tenantId,
        dni,
        equipoId,
      ])
    );
    const conductor = request.agent(app);
    const entrar = await conductor
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password: PASSWORD });
    expect(entrar.status, JSON.stringify(entrar.body)).toBe(200);
    const mia = await conductor.get(`${BASE}/mi-unidad-asignada`);
    expect(mia.status).toBe(200);
    expect(mia.body.data).toBeNull();
  });

  it("equipos-destino ofrece la unidad y deja de ofrecerla cuando Mantenimiento la quita", async () => {
    expect(await placasOfrecidas()).toContain(placa);
    const quitar = await admin
      .patch(`/api/erp/mantenimiento/equipos/${equipoId}/quitar`)
      .send({ motivo: "Vendido" });
    expect(quitar.status, JSON.stringify(quitar.body)).toBe(200);
    expect(await placasOfrecidas()).not.toContain(placa);
  });
});
