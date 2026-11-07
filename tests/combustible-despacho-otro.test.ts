/** tests/combustible-despacho-otro.test.ts
 *
 * Salida a «Otros» (0181): sale del tanque con su vale, sin unidad ni tanqueta,
 * con el texto que redacta el grifero.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const serieUnica = () => `S${Math.floor(Math.random() * 1e8).toString(36)}`.toUpperCase();

describe("combustible: despacho de un «Otros» con texto libre", () => {
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
      tanque_nombre: "Tanque galón",
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
      tipo_destino: "otro",
      otro_detalle: "  2 galones para Antonio ",
      serie_talonario: serieUnica(),
      n_vale: ++n,
      cantidad: 14.555,
      lectura_contometro: 14.555,
      costo_unitario: 27.5,
      despachado_en: new Date().toISOString(),
      ...over,
    });

  it("guarda el texto, sin unidad ni tanqueta", async () => {
    const r = await vale();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.tipo_destino).toBe("otro");
    expect(r.body.otro_detalle).toBe("2 galones para Antonio");
    expect(r.body.equipo_id).toBeNull();
    expect(r.body.tanqueta_destino_id).toBeNull();
  });

  it("acepta cualquier cantidad y un motivo opcional", async () => {
    const r = await vale({ cantidad: 27, lectura_contometro: 27, observaciones: "Para la bomba" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number(r.body.cantidad)).toBeCloseTo(27, 2);
    expect(r.body.observaciones).toBe("Para la bomba");
  });

  it("aparece en el historial con su texto", async () => {
    const creado = await vale({ otro_detalle: "Bomba de agua" });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);
    const lista = await admin.get("/api/erp/combustible/despachos");
    const filas = lista.body.data as Array<Record<string, unknown>>;
    const fila = filas.find((f) => Number(f.id) === Number(creado.body.id));
    expect(fila?.otro_detalle).toBe("Bomba de agua");
  });

  it("exige el texto", async () => {
    const r = await vale({ otro_detalle: undefined });
    expect(r.status).toBe(400);
    const vacio = await vale({ otro_detalle: "   " });
    expect(vacio.status).toBe(400);
  });

  it("el texto no aplica a otros destinos", async () => {
    const r = await vale({ tipo_destino: "planta" });
    expect(r.status).toBe(400);
  });
});
