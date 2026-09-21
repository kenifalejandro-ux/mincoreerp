/** tests/combustible-historial-sin-contrastar.test.ts
 *
 * Cargar SOLO consumo (el historial del cliente) antes de tener ninguna
 * varilla. Lo que se fija:
 *
 * 1. El kardex marca esos vales como `historico` y NO los suma al saldo: si
 *    lo hicieran, la primera varilla mostraría un "sobrante" igual a todo el
 *    consumo previo -- el sobrante fantasma.
 * 2. Una alerta AGREGADA por tanque (no una por vale), una sola vez en la
 *    vida del tanque.
 * 3. Un vale POSTERIOR a la primera varilla sigue sumando como siempre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

let seq = 0;
const serieUnica = () => `H${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

describe("combustible: consumo previo a la primera varilla", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const eq = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VH"), tipo: "Volquete" });
    equipoId = eq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const despachar = (tq: number, cantidad: number, cuando: string) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: cuando,
    });

  it("los vales previos a la primera varilla son histórico y no mueven el saldo", async () => {
    const t = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque con historial",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 20000,
      nivel_minimo: 2000,
      modo_vigilancia: "sin_vigilar",
    });
    expect(t.status).toBe(201);
    const tq = t.body.id as number;

    expect((await despachar(tq, 500, hace(10))).status).toBe(201);
    expect((await despachar(tq, 300, hace(5))).status).toBe(201);

    const k = await ag
      .get(`/api/erp/combustible/${tq}/kardex`)
      .query({ desde: hace(30), hasta: new Date(Date.now() + 3600_000).toISOString() });
    expect(k.status).toBe(200);

    const despachos = k.body.filas.filter((f: { tipo: string }) => f.tipo === "despacho");
    expect(despachos).toHaveLength(2);
    for (const d of despachos) {
      expect(d.historico).toBe(true);
      expect(d.saldo_teorico).toBeNull();
    }
    // Lo histórico no entra a los totales.
    expect(k.body.resumen.salidas).toBe(0);
    expect(k.body.resumen.historico).toMatchObject({ movimientos: 2, litros_salida: 800 });
    // Y la primera varilla NO ve un sobrante fantasma.
    const lectura = k.body.filas.find((f: { tipo: string }) => f.tipo === "lectura");
    expect(lectura.dif_acumulada).toBe(0);
    expect(k.body.resumen.descuadre_final).toBe(0);
  });

  it("una alerta agregada por tanque, una sola vez", async () => {
    await correrConciliacion(tenantId);
    await correrConciliacion(tenantId);
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    const alertas = (r.body.data ?? r.body).filter(
      (a: { tipo: string }) => a.tipo === "historial_sin_contrastar"
    );
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle).toMatchObject({ vales: 2, litrosDespachados: 800 });
  });

  it("un vale posterior a la primera varilla sigue sumando al saldo", async () => {
    const t = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque normal",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 20000,
      nivel_minimo: 2000,
      modo_vigilancia: "sin_vigilar",
    });
    const tq = t.body.id as number;
    const base = await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel: 20000, leido_en: hace(20) });
    expect(base.status).toBe(201);
    expect((await despachar(tq, 400, hace(10))).status).toBe(201);

    const k = await ag
      .get(`/api/erp/combustible/${tq}/kardex`)
      .query({ desde: hace(25), hasta: hace(0.2) });
    const d = k.body.filas.find((f: { tipo: string }) => f.tipo === "despacho");
    expect(d.historico).toBe(false);
    expect(d.saldo_teorico).toBe(19600);
    expect(k.body.resumen.salidas).toBe(400);
    expect(k.body.resumen.historico).toBeNull();
  });
});
