/** tests/combustible-fecha-limite.test.ts
 *
 * La fecha en que ocurrió un hecho --un vale, una lectura, una recepción, una compra,
 * un conteo, un cambio de precinto-- no puede estar en el futuro (con una hora de
 * margen por el reloj del celular) ni ser de hace más de un año: una fecha absurda como
 * 1900-01-01 ensucia el kardex, los períodos y todos los reportes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { ZodTypeAny } from "zod";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import {
  cambiarPrecintoSchema,
  crearCompraRutaSchema,
  crearConteoUreaSchema,
  crearDespachoCombustibleSchema,
  crearRecepcionCombustibleSchema,
  registrarLecturaCombustibleSchema,
} from "../src/server/schemas/combustible.schema";

const DIA = 24 * 3600 * 1000;
const hace = (dias: number) => new Date(Date.now() - dias * DIA).toISOString();
const enHoras = (h: number) => new Date(Date.now() + h * 3600 * 1000).toISOString();

/** Mensajes que el schema da para ESE campo de fecha, con lo demás vacío: lo que importa
 *  es solo si la fecha es aceptada o por qué se rechaza. */
function mensajesDeLaFecha(schema: ZodTypeAny, campo: string, valor: string): string[] {
  const r = schema.safeParse({ [campo]: valor });
  if (r.success) return [];
  return r.error.issues.filter((i) => i.path[0] === campo).map((i) => i.message);
}

const SEIS: Array<[string, ZodTypeAny, string]> = [
  ["lectura", registrarLecturaCombustibleSchema, "leido_en"],
  ["despacho", crearDespachoCombustibleSchema, "despachado_en"],
  ["compra en ruta", crearCompraRutaSchema, "despachado_en"],
  ["recepción", crearRecepcionCombustibleSchema, "recibido_en"],
  ["conteo de urea", crearConteoUreaSchema, "contado_en"],
  ["cambio de precinto", cambiarPrecintoSchema, "colocado_en"],
];

describe("combustible: la fecha de un hecho, ni futura ni de hace más de un año", () => {
  for (const [nombre, schema, campo] of SEIS) {
    it(`${nombre} (${campo}): 1900 y hace dos años se rechazan; hace 364 días, ahora y hace un rato se aceptan`, () => {
      for (const viejo of ["1900-01-01T00:00:00.000Z", hace(731), hace(367)]) {
        expect(mensajesDeLaFecha(schema, campo, viejo), viejo).toContain(
          "La fecha no puede ser de hace más de un año"
        );
      }
      for (const bien of [hace(364), hace(30), hace(0), enHoras(0.5)]) {
        expect(mensajesDeLaFecha(schema, campo, bien), bien).toEqual([]);
      }
    });

    it(`${nombre} (${campo}): el futuro sigue rechazado (más de una hora)`, () => {
      const mensajes = mensajesDeLaFecha(schema, campo, enHoras(3));
      expect(mensajes.length).toBeGreaterThan(0);
      expect(mensajes.join(" ")).toMatch(/futur/);
    });
  }

  it("una fecha mal escrita sigue dando error (no se acepta por accidente)", () => {
    for (const [, schema, campo] of SEIS) {
      expect(mensajesDeLaFecha(schema, campo, "ayer").length).toBeGreaterThan(0);
    }
  });
});

describe("combustible: la API rechaza el vale y la lectura de 1900 y acepta los del último año", () => {
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  let tenantId: string;
  let tanqueId: number;
  let n = 1;
  const serie = `FE${Date.now().toString(36).slice(-5)}`.toUpperCase();

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const grifo = (await ag.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    tanqueId = (
      await ag.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Tanque de las fechas",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 5000,
        nivel_actual: 4000,
        requiere_documento: false,
        modo_vigilancia: "sin_vigilar",
        grifo_interno_id: grifo,
      })
    ).body.id;
  });
  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const vale = (despachado_en: string) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "planta",
      serie_talonario: serie,
      n_vale: n++,
      cantidad: 10,
      lectura_contometro: 10,
      costo_unitario: 16,
      despachado_en,
    });

  it("un vale con fecha 1900-01-01 da 400 y no se guarda", async () => {
    const r = await vale("1900-01-01T00:00:00.000Z");
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/hace más de un año/);
    const lista = await ag.get("/api/erp/combustible/despachos").query({ serie_talonario: serie });
    expect(lista.body.data).toEqual([]);
  });

  it("un vale de hace 300 días se acepta", async () => {
    const r = await vale(hace(300));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("una lectura de hace dos años da 400; la de ayer se acepta", async () => {
    const vieja = await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 100, leido_en: hace(731) });
    expect(vieja.status).toBe(400);
    const ayer = await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 100, leido_en: hace(1) });
    expect(ayer.status, JSON.stringify(ayer.body)).toBe(201);
  });
});
