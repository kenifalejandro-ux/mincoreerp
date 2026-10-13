/** tests/combustible-vale-excede-tanque.test.ts
 *
 * Un vale de tanque propio que el tanque de ORIGEN no puede haber entregado
 * (migración 0128). Lo encontró la simulación previa a la entrega a Cushuro:
 * un vale de 5000 gal contra un tanque de 2000 pasó sin ninguna alerta,
 * porque `sobredespacho` mira el tanque de la UNIDAD, no el del grifo.
 *
 * Fija: no bloquea (el combustible ya salió), distingue "no cabe en el
 * tanque" de "el tanque tenía menos ese día", y un vale normal no alerta.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: vale mayor que el tanque (0128)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    const eq = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete" });
    equipoId = eq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // Un tanque por caso: cada vale descuenta del nivel teórico del anterior.
  async function tanque(capacidad: number, nivel: number) {
    const r = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  async function vale(tanqueId: number, cantidad: number) {
    const serie = `S${Math.floor(Math.random() * 1e8).toString(36)}`;
    const res = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
    });
    const alertas = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const propia = alertas.body.data.find(
      (a: { tipo: string; serie_talonario: string }) =>
        a.tipo === "vale_excede_tanque" && a.serie_talonario === serie
    );
    return { res, propia };
  }

  it("un vale mayor que la capacidad del tanque alerta y NO bloquea", async () => {
    const { res, propia } = await vale(await tanque(2000, 1000), 5000);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(propia).toBeDefined();
    expect(propia.detalle.motivo).toBe("excede_capacidad");
    expect(propia.detalle.capacidad).toBe(2000);
    expect(propia.detalle.cantidad).toBe(5000);
  });

  it("un vale que cabe en el tanque pero supera su nivel de ese día alerta", async () => {
    const { res, propia } = await vale(await tanque(2000, 500), 1200);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(propia).toBeDefined();
    expect(propia.detalle.motivo).toBe("excede_nivel");
    expect(propia.detalle.nivelAntes).toBeCloseTo(500, 1);
  });

  it("un vale normal no alerta", async () => {
    const { res, propia } = await vale(await tanque(2000, 1500), 300);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(propia).toBeUndefined();
  });
});
