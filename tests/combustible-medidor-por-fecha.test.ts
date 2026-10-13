/** tests/combustible-medidor-por-fecha.test.ts
 *
 * El horómetro de un vale se compara contra el vale ANTERIOR A SU FECHA, no
 * contra el último que se cargó. La simulación previa a la entrega a Cushuro
 * mostró que un vale que llega tarde (cola offline, papel del día anterior)
 * se comparaba contra uno más nuevo y salía como "retroceso" falso: alertas
 * que nadie puede explicar son alertas que se dejan de leer.
 *
 * Cada caso con su gemelo: el retroceso REAL sigue alertando.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const hace = (horas: number) => new Date(Date.now() - horas * 3_600_000).toISOString();

describe("combustible: medidor inconsistente se evalúa por fecha del vale", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let tanqueId: number;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const t = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 1000,
      modo_vigilancia: "sin_vigilar",
    });
    tanqueId = t.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const unidad = async () =>
    (
      await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora", tipo_medidor: "horometro" })
    ).body.id as number;

  let n = 0;
  async function vale(equipoId: number, horometro: number, despachadoEn: string) {
    const serie = `M${Date.now().toString(36).slice(-4)}${n++}`;
    const res = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: 1,
      cantidad: 20,
      lectura_contometro: 20,
      lectura_horometro: horometro,
      costo_unitario: 16,
      despachado_en: despachadoEn,
    });
    const alertas = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const propia = (alertas.body.data as { tipo: string; serie_talonario: string }[]).find(
      (a) => a.tipo === "medidor_inconsistente" && a.serie_talonario === serie
    );
    return { res, propia };
  }

  it("un vale que llega tarde, de ANTES del último cargado, no es un retroceso", async () => {
    const eq = await unidad();
    expect((await vale(eq, 1500, hace(1))).res.status).toBe(201);
    // Llega después, pero es de hace 20 h, cuando el horómetro marcaba menos.
    const tarde = await vale(eq, 1490, hace(20));
    expect(tarde.res.status, JSON.stringify(tarde.res.body)).toBe(201);
    expect(tarde.propia).toBeUndefined();
  });

  it("gemelo: un retroceso REAL (menor que el vale anterior en fecha) sigue alertando", async () => {
    const eq = await unidad();
    expect((await vale(eq, 1500, hace(20))).res.status).toBe(201);
    const real = await vale(eq, 1400, hace(1));
    expect(real.res.status).toBe(201);
    expect(real.propia).toBeDefined();
  });
});
