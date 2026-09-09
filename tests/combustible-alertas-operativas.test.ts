/** tests/combustible-alertas-operativas.test.ts
 *
 * Los tres huecos que quedaban en el sistema de alertas (migración 0073):
 *
 *   1. diferencia_recepcion   -- el proveedor facturó más de lo que descargó
 *   2. medidor_inconsistente  -- el horómetro/odómetro no cierra (punto 5)
 *   3. nivel_bajo             -- el tanque cruzó su mínimo
 *
 * Lo que estos tests fijan, más allá del happy path:
 *  - los tres respetan el criterio de "sin dato configurado, no se alerta"
 *    (umbral 0, nivel_minimo 0, equipo sin despacho previo);
 *  - el medidor NO bloquea el vale, igual que el sobredespacho;
 *  - nivel_bajo no se repite mientras el tanque siga bajo, y se resuelve
 *    solo al reponer -- sin eso el control muere por ruidoso;
 *  - `nivel_bajo` NUNCA se congela como anomalía (es operativo).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

const HORA = 3600 * 1000;

describe("combustible: alertas operativas (migración 0073)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function crearTanque(over: Record<string, unknown> = {}) {
    const res = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: idUnico("Tanque"),
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 10000,
      requiere_documento: false,
      ...over,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function crearEquipo(tipoMedidor: "horometro" | "odometro") {
    const res = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EQ"), tipo: "Excavadora", tipo_medidor: tipoMedidor });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function alertasDeTipo(tipo: string) {
    const res = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    return res.body.data.filter((a: { tipo: string }) => a.tipo === tipo);
  }

  // ── 1. Diferencia de recepción ─────────────────────────────────────────

  /** Arma lectura → recepción → lectura, con la diferencia pedida. */
  async function recepcionConDiferencia(
    tanqueId: number,
    grifoId: number,
    cantidad: number,
    diferenciaLitros: number,
    nivelInicial = 10000
  ) {
    const t0 = Date.now() - 5 * HORA;
    await agente.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanqueId,
      nivel: nivelInicial,
      leido_en: new Date(t0).toISOString(),
    });
    const recepcion = await agente.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanqueId,
      grifo_id: grifoId,
      cantidad,
      costo_unitario: 16,
      recibido_en: new Date(t0 + HORA).toISOString(),
    });
    expect(recepcion.status).toBe(201);
    await agente.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanqueId,
      nivel: nivelInicial + cantidad + diferenciaLitros,
      leido_en: new Date(t0 + 2 * HORA).toISOString(),
    });
    return recepcion.body;
  }

  async function crearGrifo() {
    const res = await agente.post("/api/erp/combustible/grifos").send({ nombre: idUnico("CIST") });
    return res.body;
  }

  it("una diferencia POR ENCIMA del umbral genera alerta", async () => {
    // Umbral 2%: una entrega de 1000 con 50 de faltante es 5%.
    const tanque = await crearTanque({ umbral_diferencia_pct: 2 });
    const grifo = await crearGrifo();
    const recepcion = await recepcionConDiferencia(tanque.id, grifo.id, 1000, -50);

    await correrConciliacion(tenantId);

    const alertas = await alertasDeTipo("diferencia_recepcion");
    const propia = alertas.find((a: { recepcion_id: number }) => a.recepcion_id === recepcion.id);
    expect(propia).toBeDefined();
    expect(Number(propia.detalle.diferenciaLitros)).toBe(-50);
    expect(Number(propia.detalle.diferenciaPct)).toBe(-5);
    // No es sobre un vale: la alerta se ancla a la recepción y al tanque.
    expect(propia.serie_talonario).toBeNull();
    expect(propia.n_vale).toBeNull();
    expect(propia.combustible_id).toBe(tanque.id);
  });

  it("una diferencia DENTRO del umbral no alerta", async () => {
    // Umbral 10%: 50 sobre 1000 es 5%, tolerado.
    const tanque = await crearTanque({ umbral_diferencia_pct: 10 });
    const grifo = await crearGrifo();
    const recepcion = await recepcionConDiferencia(tanque.id, grifo.id, 1000, -50);

    await correrConciliacion(tenantId);

    const alertas = await alertasDeTipo("diferencia_recepcion");
    expect(alertas.some((a: { recepcion_id: number }) => a.recepcion_id === recepcion.id)).toBe(
      false
    );
  });

  it("sin umbral configurado (null) nunca alerta, por grande que sea la diferencia", async () => {
    // Desde la migración 0075 el "sin calibrar" es NULL, no 0.
    const tanque = await crearTanque({ umbral_diferencia_pct: null });
    const grifo = await crearGrifo();
    const recepcion = await recepcionConDiferencia(tanque.id, grifo.id, 1000, -500);

    await correrConciliacion(tenantId);

    const alertas = await alertasDeTipo("diferencia_recepcion");
    expect(alertas.some((a: { recepcion_id: number }) => a.recepcion_id === recepcion.id)).toBe(
      false
    );
  });

  it("con umbral 0 (tolerancia cero) alerta por la diferencia más chica", async () => {
    // El caso que antes NO se podía expresar: el cliente que quiere saber de
    // cualquier diferencia, aunque sea de un litro. Antes de 0075 el 0 lo
    // apagaba todo y no había forma de pedir esto.
    const tanque = await crearTanque({ umbral_diferencia_pct: 0 });
    const grifo = await crearGrifo();
    const recepcion = await recepcionConDiferencia(tanque.id, grifo.id, 1000, -1);

    await correrConciliacion(tenantId);

    const alertas = await alertasDeTipo("diferencia_recepcion");
    const propia = alertas.find((a: { recepcion_id: number }) => a.recepcion_id === recepcion.id);
    expect(propia).toBeDefined();
    expect(Number(propia.detalle.diferenciaLitros)).toBe(-1);
  });

  it("no duplica la alerta aunque el worker corra varias veces", async () => {
    const tanque = await crearTanque({ umbral_diferencia_pct: 2 });
    const grifo = await crearGrifo();
    const recepcion = await recepcionConDiferencia(tanque.id, grifo.id, 1000, -80);

    await correrConciliacion(tenantId);
    await correrConciliacion(tenantId);
    await correrConciliacion(tenantId);

    const alertas = await alertasDeTipo("diferencia_recepcion");
    const propias = alertas.filter(
      (a: { recepcion_id: number }) => a.recepcion_id === recepcion.id
    );
    expect(propias).toHaveLength(1);
  });

  it("una recepción anulada no alerta", async () => {
    const tanque = await crearTanque({ umbral_diferencia_pct: 2 });
    const grifo = await crearGrifo();
    const recepcion = await recepcionConDiferencia(tanque.id, grifo.id, 1000, -90);

    await agente
      .patch(`/api/erp/combustible/recepciones/${recepcion.id}/anular`)
      .send({ motivo: "cargada por error" });

    await correrConciliacion(tenantId);

    const alertas = await alertasDeTipo("diferencia_recepcion");
    expect(alertas.some((a: { recepcion_id: number }) => a.recepcion_id === recepcion.id)).toBe(
      false
    );
  });

  // ── 2. Medidor inconsistente ───────────────────────────────────────────

  /** El medidor SOLO viaja en despachos de compra externa: en un despacho
   *  del tanque propio el schema ni siquiera lo acepta (ver el comentario
   *  de `lectura_horometro` en combustible.schema.ts). Por eso la alerta de
   *  medidor inconsistente aplica únicamente a este origen. */
  async function despacharConMedidor(
    grifoId: number,
    equipoId: number,
    serie: string,
    nVale: number,
    medidor: { horometro?: number; odometro?: number },
    despachadoEn: Date
  ) {
    return agente.post("/api/erp/combustible/despachos").send({
      origen: "compra_externa",
      grifo_id: grifoId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale,
      cantidad: 35,
      ...(medidor.horometro !== undefined ? { lectura_horometro: medidor.horometro } : {}),
      ...(medidor.odometro !== undefined ? { lectura_odometro: medidor.odometro } : {}),
      horas_abastecidas: 8,
      costo_unitario: 16.8,
      despachado_en: despachadoEn.toISOString(),
    });
  }

  it("un horómetro que RETROCEDE alerta, y el vale se registra igual", async () => {
    const grifo = await crearGrifo();
    const equipo = await crearEquipo("horometro");
    const serie = serieUnica();
    const t0 = new Date(Date.now() - 48 * HORA);

    await despacharConMedidor(grifo.id, equipo.id, serie, 1, { horometro: 1200 }, t0);
    const segundo = await despacharConMedidor(
      grifo.id,
      equipo.id,
      serie,
      2,
      { horometro: 1150 }, // menos que el anterior: imposible
      new Date(t0.getTime() + 24 * HORA)
    );

    // Lo importante: NO bloquea (punto 5 del documento).
    expect(segundo.status).toBe(201);

    const alertas = await alertasDeTipo("medidor_inconsistente");
    const propia = alertas.find((a: { serie_talonario: string }) => a.serie_talonario === serie);
    expect(propia).toBeDefined();
    expect(propia.detalle.motivo).toBe("retroceso");
    expect(Number(propia.detalle.valorAnterior)).toBe(1200);
    expect(Number(propia.detalle.valorNuevo)).toBe(1150);
  });

  it("un horómetro que suma más horas que las del calendario alerta", async () => {
    const grifo = await crearGrifo();
    const equipo = await crearEquipo("horometro");
    const serie = serieUnica();
    const t0 = new Date(Date.now() - 48 * HORA);

    await despacharConMedidor(grifo.id, equipo.id, serie, 1, { horometro: 100 }, t0);
    // 30 horas de motor en 10 horas de reloj: imposible.
    const segundo = await despacharConMedidor(
      grifo.id,
      equipo.id,
      serie,
      2,
      { horometro: 130 },
      new Date(t0.getTime() + 10 * HORA)
    );
    expect(segundo.status).toBe(201);

    const alertas = await alertasDeTipo("medidor_inconsistente");
    const propia = alertas.find((a: { serie_talonario: string }) => a.serie_talonario === serie);
    expect(propia).toBeDefined();
    expect(propia.detalle.motivo).toBe("excede_calendario");
    expect(Number(propia.detalle.horasDeclaradas)).toBe(30);
    expect(Number(propia.detalle.horasCalendario)).toBe(10);
  });

  it("un avance normal del horómetro no alerta", async () => {
    const grifo = await crearGrifo();
    const equipo = await crearEquipo("horometro");
    const serie = serieUnica();
    const t0 = new Date(Date.now() - 48 * HORA);

    await despacharConMedidor(grifo.id, equipo.id, serie, 1, { horometro: 100 }, t0);
    // 8 horas de motor en 24 de reloj: una jornada normal.
    await despacharConMedidor(
      grifo.id,
      equipo.id,
      serie,
      2,
      { horometro: 108 },
      new Date(t0.getTime() + 24 * HORA)
    );

    const alertas = await alertasDeTipo("medidor_inconsistente");
    expect(alertas.some((a: { serie_talonario: string }) => a.serie_talonario === serie)).toBe(
      false
    );
  });

  it("el odómetro solo alerta por retroceso, no por kilometraje alto", async () => {
    const grifo = await crearGrifo();
    const equipo = await crearEquipo("odometro");
    const serieAlta = serieUnica();
    const t0 = new Date(Date.now() - 48 * HORA);

    // 1.500 km en 10 horas es mucho, pero no imposible: no se alerta,
    // porque no hay un límite de km/día defendible sin inventarlo.
    await despacharConMedidor(grifo.id, equipo.id, serieAlta, 1, { odometro: 50000 }, t0);
    await despacharConMedidor(
      grifo.id,
      equipo.id,
      serieAlta,
      2,
      { odometro: 51500 },
      new Date(t0.getTime() + 10 * HORA)
    );
    let alertas = await alertasDeTipo("medidor_inconsistente");
    expect(alertas.some((a: { serie_talonario: string }) => a.serie_talonario === serieAlta)).toBe(
      false
    );

    // Retroceder sí es imposible.
    const serieRetro = serieUnica();
    await despacharConMedidor(
      grifo.id,
      equipo.id,
      serieRetro,
      1,
      { odometro: 51000 },
      new Date(t0.getTime() + 20 * HORA)
    );
    alertas = await alertasDeTipo("medidor_inconsistente");
    const propia = alertas.find(
      (a: { serie_talonario: string }) => a.serie_talonario === serieRetro
    );
    expect(propia).toBeDefined();
    expect(propia.detalle.motivo).toBe("retroceso");
  });

  it("el PRIMER despacho de un equipo nunca alerta: no hay con qué comparar", async () => {
    const grifo = await crearGrifo();
    const equipo = await crearEquipo("horometro");
    const serie = serieUnica();

    const res = await despacharConMedidor(
      grifo.id,
      equipo.id,
      serie,
      1,
      { horometro: 99999 },
      new Date()
    );
    expect(res.status).toBe(201);

    const alertas = await alertasDeTipo("medidor_inconsistente");
    expect(alertas.some((a: { serie_talonario: string }) => a.serie_talonario === serie)).toBe(
      false
    );
  });

  // ── 3. Nivel bajo ──────────────────────────────────────────────────────

  it("cruzar el nivel mínimo alerta UNA sola vez, aunque haya más lecturas bajas", async () => {
    const tanque = await crearTanque({ nivel_minimo: 5000, nivel_actual: 10000 });

    for (const nivel of [4000, 3500, 3000]) {
      await agente.post("/api/erp/combustible/lecturas").send({ combustible_id: tanque.id, nivel });
    }

    const alertas = await alertasDeTipo("nivel_bajo");
    const propias = alertas.filter(
      (a: { combustible_id: number }) => a.combustible_id === tanque.id
    );
    // Sin deduplicación serían tres, y la pantalla se llenaría de repetidos.
    expect(propias).toHaveLength(1);
    expect(Number(propias[0].detalle.nivel)).toBe(4000);
    expect(Number(propias[0].detalle.nivelMinimo)).toBe(5000);
    expect(propias[0].resuelta_en).toBeNull();
  });

  it("reponer por encima del mínimo resuelve la alerta sola", async () => {
    const tanque = await crearTanque({ nivel_minimo: 5000, nivel_actual: 10000 });
    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanque.id, nivel: 4000 });

    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanque.id, nivel: 9000 });

    const alertas = await alertasDeTipo("nivel_bajo");
    const propia = alertas.find((a: { combustible_id: number }) => a.combustible_id === tanque.id);
    expect(propia.resuelta_en).not.toBeNull();
    // La resolvió el sistema, no una persona.
    expect(propia.resuelta_por).toBeNull();
  });

  it("con nivel_minimo 0 (sin configurar) nunca alerta", async () => {
    const tanque = await crearTanque({ nivel_minimo: 0, nivel_actual: 10000 });
    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanque.id, nivel: 1 });

    const alertas = await alertasDeTipo("nivel_bajo");
    expect(alertas.some((a: { combustible_id: number }) => a.combustible_id === tanque.id)).toBe(
      false
    );
  });

  it("nivel_bajo NUNCA se congela como anomalía, por vieja que sea", async () => {
    const tanque = await crearTanque({ nivel_minimo: 5000, nivel_actual: 10000 });
    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanque.id, nivel: 4000 });

    // Se envejece muy por encima de cualquier ventana.
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE combustible_alertas SET creado_en = now() - interval '500 hours'
         WHERE tenant_id = $1 AND tipo = 'nivel_bajo' AND combustible_id = $2`,
        [tenantId, tanque.id]
      )
    );

    await correrConciliacion(tenantId);

    const res = await agente.get("/api/erp/combustible/anomalias").query({ pageSize: 200 });
    expect(
      res.body.data.some((a: { tipo: string }) => a.tipo === "nivel_bajo"),
      "nivel_bajo es operativo: se arregla reponiendo, no es un faltante que congelar"
    ).toBe(false);
  });

  // ── Aislamiento ────────────────────────────────────────────────────────

  it("un tenant no ve las alertas operativas de otro (RLS)", async () => {
    const tanque = await crearTanque({ nivel_minimo: 5000, nivel_actual: 10000 });
    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanque.id, nivel: 100 });

    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const res = await agenteOtro.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
      expect(
        res.body.data.some((a: { combustible_id: number }) => a.combustible_id === tanque.id)
      ).toBe(false);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
