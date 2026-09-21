/** tests/combustible-totalizador.test.ts
 *
 * El totalizador acumulativo del surtidor (migración 0094). Lo que se fija:
 *
 * 1. APAGADO por defecto: un tanque sin la casilla se comporta como siempre y
 *    rechaza una lectura de totalizador que no le corresponde.
 * 2. ENCENDIDO: la lectura es obligatoria en cada vale.
 * 3. El avance del totalizador contra los litros del vale: si sobra, salió
 *    combustible sin vale (totalizador_salto); si coincide, no alerta.
 * 4. Un totalizador que vuelve atrás (totalizador_retroceso).
 * 5. `totalizador_actual` sigue al máximo vigente y se recalcula al anular.
 * 6. El orden es por VALOR: un vale offline que llega tarde no da falso retroceso.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

let seq = 0;
const serieUnica = () => `T${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

describe("combustible: totalizador acumulativo", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const eq = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VT"), tipo: "Volquete" });
    equipoId = eq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(usa: boolean) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque totalizador",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 20000,
      nivel_minimo: 2000,
      modo_vigilancia: "sin_vigilar",
      usa_totalizador: usa,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const despachar = (tq: number, cantidad: number, cuando: string, totalizador?: number) =>
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
      ...(totalizador === undefined ? {} : { totalizador_lectura: totalizador }),
      costo_unitario: 16,
      despachado_en: cuando,
    });

  async function alertasDe(tq: number, tipo: string) {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    return (r.body.data ?? r.body).filter(
      (a: { tipo: string; combustible_id: number }) => a.tipo === tipo && a.combustible_id === tq
    );
  }

  async function totalizadorActual(tq: number) {
    const r = await ag.get(`/api/erp/combustible/${tq}`);
    return Number(r.body.totalizador_actual);
  }

  it("apagado: el tanque rechaza una lectura de totalizador que no le corresponde", async () => {
    const tq = await tanque(false);
    expect((await despachar(tq, 100, hace(5))).status).toBe(201);
    const r = await despachar(tq, 100, hace(4), 5000);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("encendido: la lectura es obligatoria en el vale", async () => {
    const tq = await tanque(true);
    const r = await despachar(tq, 100, hace(5));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await despachar(tq, 100, hace(5), 1000)).status).toBe(201);
  });

  it("el avance que cuadra no alerta; el que sobra es totalizador_salto", async () => {
    const tq = await tanque(true);
    expect((await despachar(tq, 100, hace(10), 1000)).status).toBe(201);
    // 1000 -> 1300 con un vale de 300: cuadra.
    expect((await despachar(tq, 300, hace(9), 1300)).status).toBe(201);
    expect(await alertasDe(tq, "totalizador_salto")).toHaveLength(0);
    // 1300 -> 1650 con un vale de 300: 50 salieron sin vale.
    expect((await despachar(tq, 300, hace(8), 1650)).status).toBe(201);
    const saltos = await alertasDe(tq, "totalizador_salto");
    expect(saltos).toHaveLength(1);
    expect(saltos[0].detalle).toMatchObject({ diferencia: 50, sobra: true });
  });

  it("un totalizador que vuelve atrás es totalizador_retroceso", async () => {
    const tq = await tanque(true);
    expect((await despachar(tq, 100, hace(10), 2000)).status).toBe(201);
    expect((await despachar(tq, 100, hace(9), 2100)).status).toBe(201);
    expect((await despachar(tq, 100, hace(8), 1500)).status).toBe(201);
    const r = await alertasDe(tq, "totalizador_retroceso");
    expect(r).toHaveLength(1);
    expect(r[0].detalle).toMatchObject({ totalizador: 1500, totalizadorMayorPrevio: 2100 });
  });

  it("totalizador_actual es el máximo vigente y se recalcula al anular", async () => {
    const tq = await tanque(true);
    expect(await totalizadorActual(tq)).toBe(0);
    const a = await despachar(tq, 100, hace(10), 3000);
    const b = await despachar(tq, 100, hace(9), 3100);
    expect(await totalizadorActual(tq)).toBe(3100);
    const anular = await ag
      .patch(`/api/erp/combustible/despachos/${b.body.id}/anular`)
      .send({ motivo: "error de tipeo" });
    expect(anular.status).toBe(200);
    expect(await totalizadorActual(tq)).toBe(3000);
    expect(a.status).toBe(201);
  });

  it("un vale offline que llega tarde no da falso retroceso (se ordena por valor)", async () => {
    const tq = await tanque(true);
    expect((await despachar(tq, 100, hace(10), 4000)).status).toBe(201);
    expect((await despachar(tq, 100, hace(8), 4200)).status).toBe(201);
    // El del medio, cargado después pero de hace 9 h: 4100.
    expect((await despachar(tq, 100, hace(9), 4100)).status).toBe(201);
    expect(await alertasDe(tq, "totalizador_retroceso")).toHaveLength(0);
  });
});
