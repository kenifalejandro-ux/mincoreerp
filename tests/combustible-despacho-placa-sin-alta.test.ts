/** tests/combustible-despacho-placa-sin-alta.test.ts
 *
 * Un vale del tanque propio a una unidad que todavía no está dada de alta (0176): el grifero
 * escribe la placa y no espera a la oficina. Es un destino propio ('unidad_sin_alta') y no un
 * 'equipo' sin equipo_id, para que lo que lee tipo_destino='equipo' no se rompa.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const serieUnica = () => `S${Math.floor(Math.random() * 1e8).toString(36)}`.toUpperCase();

describe("combustible: despacho a una unidad sin alta (placa libre)", () => {
  let tenantId: string;
  let tanqueId: number;
  const admin = request.agent(app);
  let n = 0;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba("ClaveDePrueba123");
    tenantId = creado.tenant.id;
    await admin.post("/api/auth/login").send({
      tenantSlug: creado.tenant.slug,
      email: creado.usuario.email,
      password: "ClaveDePrueba123",
    });
    const tq = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque placa libre",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
    });
    expect(tq.status, JSON.stringify(tq.body)).toBe(201);
    tanqueId = tq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const vale = (over: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "unidad_sin_alta",
      placa_sin_alta: "t8m-821 ",
      serie_talonario: serieUnica(),
      n_vale: ++n,
      cantidad: 50,
      lectura_contometro: 50,
      costo_unitario: 27.5,
      despachado_en: new Date().toISOString(),
      ...over,
    });

  it("guarda la placa normalizada, sin unidad, con el precio del grifero", async () => {
    const r = await vale();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.tipo_destino).toBe("unidad_sin_alta");
    expect(r.body.equipo_id).toBeNull();
    expect(r.body.placa_sin_alta).toBe("T8M821");
    expect(Number(r.body.costo_unitario)).toBeCloseTo(27.5, 2);
  });

  it("aparece en el historial de despachos con su placa", async () => {
    const creado = await vale({ placa_sin_alta: "ABC 123" });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);
    const lista = await admin.get("/api/erp/combustible/despachos");
    expect(lista.status).toBe(200);
    const filas = lista.body.data as Array<Record<string, unknown>>;
    const fila = filas.find((f) => Number(f.id) === Number(creado.body.id));
    expect(fila?.placa_sin_alta).toBe("ABC123");
  });

  it("si la placa ya está dada de alta, el vale va a esa unidad y no queda 'sin alta'", async () => {
    const eq = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: "QWE-456", tipo: "VOLQUETE", tipo_medidor: "odometro" });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    const r = await vale({ placa_sin_alta: "qwe 456" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.tipo_destino).toBe("equipo");
    expect(r.body.equipo_id).toBe(eq.body.id);
    expect(r.body.placa_sin_alta).toBeNull();
  });

  it("rechaza el destino sin placa, o con una demasiado corta", async () => {
    expect((await vale({ placa_sin_alta: undefined })).status).toBe(400);
    expect((await vale({ placa_sin_alta: "A-" })).status).toBe(400);
  });

  it("rechaza la placa en un destino que no es unidad sin alta", async () => {
    const r = await vale({ tipo_destino: "planta", placa_sin_alta: "ABC123" });
    expect(r.status).toBe(400);
  });

  it("no acepta placa libre junto con una unidad registrada", async () => {
    const r = await vale({ equipo_id: 1 });
    expect(r.status).toBe(400);
  });
});
