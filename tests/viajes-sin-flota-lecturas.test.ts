/** tests/viajes-sin-flota-lecturas.test.ts
 *
 * El viaje de una unidad ESCRITA A MANO (0193) tiene que verse en todo lo que lee viajes, no solo
 * en la lista: las cargas del viaje, el Control TV y las detenciones. Antes de este cambio esas
 * lecturas unían la unidad con un JOIN interno a `equipos` y el viaje desaparecía. Lo que se fija:
 *
 * 1. Las cargas del viaje salen de los vales con la MISMA placa escrita dentro de su ventana, y no
 *    de los de otra placa.
 * 2. El Control TV cuenta el viaje en la flota y abre la vista de su unidad (sin comparación con
 *    pares: no hay unidad registrada), con su última carga.
 * 3. Una detención abierta del viaje (avería) sale en `viajesDetenidos` con su placa.
 * 4. Una unidad escrita no tiene grifo: la ve solo quien ve todo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico, dniUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { viajesDetenidos, unidadVisible } from "../src/modules/combustible/viajes.service";
import type { AlcanceCombustible } from "../src/modules/combustible/alcance";

const PASSWORD = "ClaveDePrueba123";
const VIAJES = "/api/erp/viajes";
const COMB = "/api/erp/combustible";
const hora = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const serieUnica = () => `V${Math.floor(Math.random() * 1e8).toString(36)}`.toUpperCase();

describe("Viajes de una unidad escrita a mano: lo que se lee del viaje", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let tanqueId: number;
  let viajeId: number;
  let n = 0;
  const placa = `ZL${Math.floor(Math.random() * 1e6)}`;
  const otraPlaca = `ZM${Math.floor(Math.random() * 1e6)}`;

  const vale = (placaDelVale: string) =>
    admin.post(`${COMB}/despachos`).send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "unidad_sin_alta",
      placa_sin_alta: placaDelVale,
      serie_talonario: serieUnica(),
      n_vale: ++n,
      cantidad: 40,
      lectura_contometro: 40,
      costo_unitario: 27.5,
      despachado_en: hora(-30),
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password: PASSWORD });
    tanqueId = (
      await admin.post(COMB).send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Tanque lecturas",
        tipo_combustible: "diesel_b5",
        unidad: "L",
        tipo_punto: "fijo",
        capacidad_total: 20000,
        nivel_actual: 10000,
        requiere_documento: false,
      })
    ).body.id;
    const origen = Number(
      (await admin.post(`${VIAJES}/lugares`).send({ nombre: idUnico("Origen") })).body.id
    );
    const destino = Number(
      (await admin.post(`${VIAJES}/lugares`).send({ nombre: idUnico("Destino") })).body.id
    );
    const v = await admin.post(VIAJES).send({
      placa_sin_alta: placa,
      conductor_nombre: "Conductor Escrito",
      conductor_dni: dniUnico(),
      origen_id: origen,
      destino_id: destino,
      salida_programada_en: hora(60),
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    viajeId = Number(v.body.id);
    const inicio = await admin
      .post(`${VIAJES}/${viajeId}/iniciar`)
      .send({ inicio_en: hora(-120), motivo: "Marca de oficina" });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(200);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("las cargas del viaje son los vales con su misma placa escrita, no los de otra placa", async () => {
    const suyo = await vale(placa);
    expect(suyo.status, JSON.stringify(suyo.body)).toBe(201);
    expect(suyo.body.equipo_id).toBeNull();
    const ajeno = await vale(otraPlaca);
    expect(ajeno.status, JSON.stringify(ajeno.body)).toBe(201);

    const detalle = await admin.get(`${VIAJES}/${viajeId}`);
    expect(detalle.status, JSON.stringify(detalle.body)).toBe(200);
    const ids = (detalle.body.cargas as { id: number }[]).map((c) => Number(c.id));
    expect(ids).toContain(Number(suyo.body.id));
    expect(ids).not.toContain(Number(ajeno.body.id));

    // Y la lista del panel lo cuenta: una carga de 40 L.
    const lista = await admin.get(VIAJES).query({ producto: "combustible" });
    const fila = lista.body.data.find((f: { id: number | string }) => Number(f.id) === viajeId);
    expect(Number(fila.cargas)).toBe(1);
  });

  it("el Control TV cuenta el viaje en la flota y abre la vista de su unidad, sin comparar con pares", async () => {
    const resumen = await admin.get(`${VIAJES}/control-tv/resumen`);
    expect(resumen.status, JSON.stringify(resumen.body).slice(0, 400)).toBe(200);
    expect(Number(resumen.body.flota.activos)).toBeGreaterThanOrEqual(1);

    const unidad = await admin.get(`${VIAJES}/control-tv/unidad/${viajeId}`);
    expect(unidad.status, JSON.stringify(unidad.body).slice(0, 400)).toBe(200);
    expect(unidad.body.rendimiento).toBeNull();
    expect((unidad.body.ultimas_cargas as unknown[]).length).toBeGreaterThanOrEqual(1);

    const detalle = await admin.get(`${VIAJES}/control-tv/detalle`);
    expect(detalle.status, JSON.stringify(detalle.body).slice(0, 400)).toBe(200);
  });

  it("una detención abierta del viaje sale con su placa escrita", async () => {
    const d = await admin
      .post(`${VIAJES}/${viajeId}/descanso`)
      .send({ motivo: "Avería", donde: "km 40" });
    expect(d.status, JSON.stringify(d.body)).toBe(200);

    const detenidos = await withTenant(tenantId, (c) => viajesDetenidos(c, tenantId));
    const fila = detenidos.find((x) => x.viaje_id === viajeId);
    expect(fila).toBeDefined();
    expect(fila?.equipo_id).toBeNull();
    expect(fila?.placa_codigo).toBe(placa);
  });

  it("una unidad escrita no tiene grifo: la ve solo quien ve todo", async () => {
    const todo: AlcanceCombustible = { todo: true };
    const acotado = { todo: false, grifos: [], surtidores: [] } as unknown as AlcanceCombustible;
    const visto = (alcance: AlcanceCombustible) =>
      withTenant(tenantId, (c) =>
        unidadVisible(c, tenantId, null, { alcance, usuarioId: "x", grifos: null })
      );
    expect(await visto(todo)).toBe(true);
    expect(await visto(acotado)).toBe(false);
  });
});
