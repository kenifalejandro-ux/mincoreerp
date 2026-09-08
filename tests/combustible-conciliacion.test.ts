/** tests/combustible-conciliacion.test.ts
 *
 * Punto 4 de docs/architecture/control-de-combustible.md: lo que pasa la
 * ventana de gracia sin explicarse se congela como hallazgo permanente
 * (migraciones 0071 y 0072).
 *
 * Los tests envejecen las alertas con un UPDATE directo sobre `creado_en`
 * en vez de esperar 72 horas reales -- es la única forma de ejercitar el
 * worker de verdad sin mockear el reloj.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

function serieUnica(): string {
  return `S${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: conciliación de período (Fase D, migraciones 0071/0072)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let tanqueId: number;
  let equipoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const tanque = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque conciliación",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
    });
    tanqueId = tanque.body.id;

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora" });
    equipoId = equipo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function payloadVale(serie: string, nVale: number) {
    return {
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale,
      cantidad: 35,
      lectura_contometro: 35,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
    };
  }

  /** Crea un hueco real: el vale 1 y el 3, sin el 2. */
  async function crearHueco(serie: string) {
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 1));
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 3));
  }

  /** Envejece las alertas de una serie para que superen la ventana. */
  async function envejecerAlertas(serie: string, horas: number) {
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE combustible_alertas
         SET creado_en = now() - make_interval(hours => $1)
         WHERE tenant_id = $2 AND serie_talonario = $3`,
        [horas, tenantId, serie]
      )
    );
  }

  async function anomaliasDeSerie(serie: string) {
    const res = await agente.get("/api/erp/combustible/anomalias").query({ pageSize: 200 });
    return res.body.data.filter((a: { serie_talonario: string }) => a.serie_talonario === serie);
  }

  async function alertasDeSerie(serie: string) {
    const res = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    return res.body.data.filter((a: { serie_talonario: string }) => a.serie_talonario === serie);
  }

  it("un hueco que superó la ventana se congela como anomalía", async () => {
    const serie = serieUnica();
    await crearHueco(serie);
    await envejecerAlertas(serie, 100); // más que las 72h por default

    await correrConciliacion();

    const anomalias = await anomaliasDeSerie(serie);
    expect(anomalias).toHaveLength(1);
    expect(anomalias[0].tipo).toBe("hueco_detectado");
    expect(anomalias[0].n_vale).toBe(2);
    // La ventana que regía queda grabada en la fila, para que el hallazgo
    // siga siendo explicable aunque después alguien la cambie.
    expect(anomalias[0].ventana_horas).toBe(72);
    expect(anomalias[0].congelada_en).not.toBeNull();
  });

  it("un hueco DENTRO de la ventana no se congela", async () => {
    const serie = serieUnica();
    await crearHueco(serie);
    await envejecerAlertas(serie, 10); // muy por debajo de 72h

    await correrConciliacion();

    expect(await anomaliasDeSerie(serie)).toHaveLength(0);
  });

  it("un hueco ya resuelto nunca se congela, aunque sea viejo", async () => {
    const serie = serieUnica();
    await crearHueco(serie);
    // Llega el vale que faltaba: resuelve la alerta.
    await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 2));
    await envejecerAlertas(serie, 500);

    await correrConciliacion();

    expect(await anomaliasDeSerie(serie)).toHaveLength(0);
  });

  it("congelar es idempotente: dos corridas no duplican la anomalía", async () => {
    const serie = serieUnica();
    await crearHueco(serie);
    await envejecerAlertas(serie, 100);

    await correrConciliacion();
    await correrConciliacion();
    await correrConciliacion();

    expect(await anomaliasDeSerie(serie)).toHaveLength(1);
  });

  it("respeta la ventana configurada, no la de 72h por default", async () => {
    const serie = serieUnica();

    const guardada = await agente
      .put("/api/erp/combustible/config")
      // El PUT reemplaza la fila entera: desde 0079 lleva también los dos
      // topes diarios. Omitirlos NO significa "dejalos como están" -- eso
      // apagaría un control sin que nadie lo pidiera.
      .send({
        ventana_gracia_horas: 5,
        dias_sin_medir: 3,
        llenados_por_dia_max: null,
        tope_diario_sin_capacidad_l: null,
      });
    expect(guardada.status).toBe(200);
    expect(guardada.body.ventana_gracia_horas).toBe(5);

    await crearHueco(serie);
    // 10h: dentro de las 72h del default, pero MÁS que las 5h configuradas.
    await envejecerAlertas(serie, 10);

    await correrConciliacion();

    const anomalias = await anomaliasDeSerie(serie);
    expect(anomalias).toHaveLength(1);
    expect(anomalias[0].ventana_horas).toBe(5);

    // Se restaura para no contaminar los tests que siguen.
    await agente.put("/api/erp/combustible/config").send({
      ventana_gracia_horas: 72,
      dias_sin_medir: 3,
      llenados_por_dia_max: null,
      tope_diario_sin_capacidad_l: null,
    });
  });

  it("un vale que llega DESPUÉS de congelarse no resucita la anomalía: entra como despacho_tardio", async () => {
    const serie = serieUnica();
    await crearHueco(serie);
    await envejecerAlertas(serie, 100);
    await correrConciliacion();

    expect(await anomaliasDeSerie(serie)).toHaveLength(1);

    // El jueves aparece el vale del martes (el "bonus" del punto 4).
    const tardio = await agente.post("/api/erp/combustible/despachos").send(payloadVale(serie, 2));
    expect(tardio.status).toBe(201);

    // La anomalía sigue ahí, intacta: es inmutable.
    expect(await anomaliasDeSerie(serie)).toHaveLength(1);

    const alertas = await alertasDeSerie(serie);
    const tardia = alertas.find((a: { tipo: string }) => a.tipo === "despacho_tardio");
    expect(tardia).toBeDefined();
    expect(tardia.n_vale).toBe(2);

    // Y la alerta original del hueco NO se marcó como resuelta -- el hecho
    // de que estuvo 100h sin explicarse ya ocurrió.
    const hueco = alertas.find(
      (a: { tipo: string; n_vale: number }) => a.tipo === "hueco_detectado" && a.n_vale === 2
    );
    expect(hueco.resuelta_en).toBeNull();
    expect(hueco.congelada_en).not.toBeNull();
  });

  it("la ventana rechaza valores fuera del rango permitido", async () => {
    expect(
      (await agente.put("/api/erp/combustible/config").send({ ventana_gracia_horas: 0 })).status
    ).toBe(400);
    expect(
      (await agente.put("/api/erp/combustible/config").send({ ventana_gracia_horas: 99999 })).status
    ).toBe(400);
  });

  it("un tenant sin config usa 72h sin necesitar fila propia", async () => {
    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const config = await agenteOtro.get("/api/erp/combustible/config");
      expect(config.status).toBe(200);
      expect(config.body.ventana_gracia_horas).toBe(72);
      expect(config.body.actualizado_en).toBeNull();
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("un tenant no ve las anomalías de otro (RLS)", async () => {
    const serie = serieUnica();
    await crearHueco(serie);
    await envejecerAlertas(serie, 100);
    await correrConciliacion();

    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const res = await agenteOtro.get("/api/erp/combustible/anomalias").query({ pageSize: 200 });
      expect(
        res.body.data.some((a: { serie_talonario: string }) => a.serie_talonario === serie)
      ).toBe(false);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
