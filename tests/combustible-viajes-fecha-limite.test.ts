/** tests/combustible-viajes-fecha-limite.test.ts
 *
 * Las horas que escribe la oficina o una carga retroactiva en un viaje no pueden ser de
 * hace más de un año (el futuro lo siguen validando los servicios con sus mensajes). Las
 * marcas del celular y la salida programada tienen sus propios topes en el servicio y no
 * cambian. Al EDITAR solo se mira lo que cambia: el formulario reenvía las fechas ya
 * guardadas y un viaje viejo se tiene que poder corregir sin tocarlas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { ZodTypeAny } from "zod";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import {
  corregirMandoSchema,
  corregirMarcaDeParadaSchema,
  crearViajeSchema,
  cerrarViajeSchema,
  descansoViajeSchema,
  editarViajeSchema,
  iniciarMiViajeSchema,
  iniciarViajeSchema,
  llegadaViajeSchema,
  salidaViajeSchema,
  terminarDescansoViajeSchema,
} from "../src/server/schemas/combustible.schema";

const DIA = 24 * 3600 * 1000;
const hace = (dias: number) => new Date(Date.now() - dias * DIA).toISOString();
const MENSAJE = "La fecha no puede ser de hace más de un año";

function mensajesDeLaFecha(schema: ZodTypeAny, campo: string, valor: string): string[] {
  const r = schema.safeParse({ [campo]: valor });
  if (r.success) return [];
  return r.error.issues.filter((i) => i.path[0] === campo).map((i) => i.message);
}

const CON_TOPE: Array<[string, ZodTypeAny, string]> = [
  ["crear viaje (inicio)", crearViajeSchema, "inicio_en"],
  ["crear viaje (fin)", crearViajeSchema, "fin_en"],
  ["iniciar viaje", iniciarViajeSchema, "inicio_en"],
  ["cerrar viaje", cerrarViajeSchema, "fin_en"],
  ["llegada manual", llegadaViajeSchema, "llegada_en"],
  ["salida manual", salidaViajeSchema, "salida_en"],
  ["descanso de la oficina (inicio)", descansoViajeSchema, "inicio_en"],
  ["descanso de la oficina (fin)", terminarDescansoViajeSchema, "fin_en"],
  ["corregir el mando", corregirMandoSchema, "cambio_en"],
  ["corregir una parada", corregirMarcaDeParadaSchema, "hora"],
];

describe("viajes: las horas manuales y retroactivas no pueden ser de hace más de un año", () => {
  for (const [nombre, schema, campo] of CON_TOPE) {
    it(`${nombre} (${campo}): 1900, hace 2 años y hace 367 días se rechazan; hace 364 días, ahora y con zona horaria se aceptan`, () => {
      for (const viejo of ["1900-01-01T00:00:00.000Z", hace(731), hace(367)]) {
        expect(mensajesDeLaFecha(schema, campo, viejo), viejo).toContain(MENSAJE);
      }
      const conZona = new Date(Date.now() - 10 * DIA).toISOString().replace("Z", "-05:00");
      for (const bien of [hace(364), hace(0), conZona]) {
        expect(mensajesDeLaFecha(schema, campo, bien), bien).toEqual([]);
      }
    });
  }

  it("lo que NO cambia: editar (lo mira el servicio), la marca del celular y la salida programada", () => {
    expect(mensajesDeLaFecha(editarViajeSchema, "inicio_en", "1900-01-01T00:00:00.000Z")).toEqual(
      []
    );
    expect(mensajesDeLaFecha(editarViajeSchema, "fin_en", hace(731))).toEqual([]);
    expect(mensajesDeLaFecha(iniciarMiViajeSchema, "marcado_en", hace(731))).toEqual([]);
    expect(mensajesDeLaFecha(crearViajeSchema, "salida_programada_en", hace(731))).toEqual([]);
  });
});

describe("viajes: por la API", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let origen: number;
  let destino: number;
  let seq = 0;

  const lugar = async (nombre: string) =>
    Number((await admin.post("/api/erp/combustible/lugares").send({ nombre })).body.id);
  const unidad = async () => {
    const r = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: String(41000000 + seq++),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const viaje = (equipo_id: number, extra: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/viajes").send({
      equipo_id,
      origen_id: origen,
      destino_id: destino,
      ...extra,
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    origen = await lugar(idUnico("Origen"));
    destino = await lugar(idUnico("Destino"));
  });
  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("registrar un viaje con salida en 1900 o hace dos años da 400; hace 300 días se acepta", async () => {
    const u = await unidad();
    for (const viejo of ["1900-01-01T00:00:00.000Z", hace(731)]) {
      const r = await viaje(u, { inicio_en: viejo });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(JSON.stringify(r.body)).toContain(MENSAJE);
    }
    const bien = await viaje(u, { inicio_en: hace(300) });
    expect(bien.status, JSON.stringify(bien.body)).toBe(201);
  });

  it("iniciar y cerrar un viaje con una hora a mano de hace dos años da 400", async () => {
    const u = await unidad();
    const programado = await viaje(u);
    expect(programado.status, JSON.stringify(programado.body)).toBe(201);
    const iniciar = await admin
      .post(`/api/erp/combustible/viajes/${programado.body.id}/iniciar`)
      .send({ inicio_en: hace(731), motivo: "se olvidó de marcarlo" });
    expect(iniciar.status, JSON.stringify(iniciar.body)).toBe(400);
    expect(JSON.stringify(iniciar.body)).toContain(MENSAJE);
    const cerrar = await admin
      .post(`/api/erp/combustible/viajes/${programado.body.id}/cerrar`)
      .send({ fin_en: hace(731), motivo: "se olvidó de marcarlo" });
    expect(cerrar.status, JSON.stringify(cerrar.body)).toBe(400);
    expect(JSON.stringify(cerrar.body)).toContain(MENSAJE);
  });

  it("editar un viaje viejo sin tocar sus fechas funciona; moverlas a más de un año atrás da 400", async () => {
    const u = await unidad();
    // Un viaje cerrado de hace ~300 días, guardado antes del límite o dentro de él.
    const v = await viaje(u, { inicio_en: hace(300), fin_en: hace(299) });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const id = v.body.id;

    // El formulario reenvía las fechas guardadas junto con lo que cambió.
    const sinTocar = await admin.put(`/api/erp/combustible/viajes/${id}`).send({
      inicio_en: v.body.inicio_en,
      fin_en: v.body.fin_en,
      observaciones: "corregí un dato",
      motivo: "ajuste de observaciones",
    });
    expect(sinTocar.status, JSON.stringify(sinTocar.body)).toBe(200);

    const aLoViejo = await admin.put(`/api/erp/combustible/viajes/${id}`).send({
      inicio_en: hace(731),
      motivo: "me equivoqué de fecha",
    });
    expect(aLoViejo.status, JSON.stringify(aLoViejo.body)).toBe(400);
    expect(JSON.stringify(aLoViejo.body)).toContain(MENSAJE);

    const aOtraReciente = await admin.put(`/api/erp/combustible/viajes/${id}`).send({
      inicio_en: hace(299.5),
      motivo: "corrijo la hora de salida",
    });
    expect(aOtraReciente.status, JSON.stringify(aOtraReciente.body)).toBe(200);
  });
});
