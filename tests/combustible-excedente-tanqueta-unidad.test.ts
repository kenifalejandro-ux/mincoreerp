/** tests/combustible-excedente-tanqueta-unidad.test.ts
 *
 * El reparto del excedente puede mandar una tanqueta a una unidad con su vale
 * (migración 0140): al guardar la recepción la tanqueta queda asignada, y el
 * vale no se puede repetir ni en el reparto ni en un despacho.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: excedente a una tanqueta con unidad y vale (0140)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let grifoProveedor: number;
  let principal: number;
  let unidad: number;
  let otraUnidad: number;
  let nVale = 100;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    grifoProveedor = (
      await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("CISTERNA") })
    ).body.id;
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const equipo = async () =>
      (
        await admin.post("/api/erp/equipos").send({
          placa_codigo: idUnico("VQ"),
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
          grifo_interno_id: principal,
        })
      ).body.id as number;
    unidad = await equipo();
    otraUnidad = await equipo();
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const tanqueLleno = async () =>
    (
      await admin.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Tanque Cancha",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 2000,
        nivel_actual: 2000,
        requiere_documento: false,
        modo_excedente_recepcion: "flexible",
        grifo_interno_id: principal,
      })
    ).body.id as number;

  const nuevaTanqueta = async () =>
    Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );

  // El tanque se crea ANTES de armar la petición: dos agentes de supertest
  // anidados se pisan el puerto (ECONNREFUSED).
  const recibir = async (cantidad: number, reparto: unknown[]) => {
    const tanque = await tanqueLleno();
    return admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanque,
      grifo_id: grifoProveedor,
      cantidad,
      costo_unitario: 17,
      recibido_en: new Date().toISOString(),
      reparto_excedente: reparto,
    });
  };

  const linea = (tanqueta: number, cantidad: number, extra: Record<string, unknown> = {}) => ({
    destino: "cubeta",
    cantidad,
    tanqueta_id: tanqueta,
    ...extra,
  });
  const conUnidad = (equipo: number, vale = nVale++) => ({
    tanqueta_equipo_id: equipo,
    serie_talonario: "CIS",
    n_vale: vale,
  });

  const ver = async (id: number) =>
    (await admin.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === id
    );

  it("la tanqueta con unidad y vale queda asignada a esa unidad", async () => {
    const tq = await nuevaTanqueta();
    const r = await recibir(280, [linea(tq, 280, conUnidad(unidad))]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const fila = await ver(tq);
    expect(Number(fila.saldo)).toBe(280);
    expect(fila.equipo_asignado_id).toBe(unidad);
    expect(fila.asignada_vigente).toBe(true);
  });

  it("sin unidad ni vale, la tanqueta se llena y queda sin asignar", async () => {
    const tq = await nuevaTanqueta();
    expect((await recibir(280, [linea(tq, 280)])).status).toBe(201);
    expect((await ver(tq)).equipo_asignado_id).toBeNull();
  });

  it("unidad, serie y vale van juntos: faltando uno es 400", async () => {
    const tq = await nuevaTanqueta();
    const sinVale = await recibir(280, [linea(tq, 280, { tanqueta_equipo_id: unidad })]);
    expect(sinVale.status).toBe(400);
    const soloVale = await recibir(280, [linea(tq, 280, { serie_talonario: "CIS", n_vale: 5 })]);
    expect(soloVale.status).toBe(400);
    expect((await ver(tq)).equipo_asignado_id).toBeNull();
  });

  it("el vale de una línea de equipo o devolución no es válido", async () => {
    const r = await recibir(100, [{ destino: "devolucion", cantidad: 100, ...conUnidad(unidad) }]);
    expect(r.status).toBe(400);
  });

  it("un vale ya usado no se repite: ni en otro reparto ni en la misma solicitud", async () => {
    const a = await nuevaTanqueta();
    const vale = nVale++;
    expect((await recibir(100, [linea(a, 100, conUnidad(unidad, vale))])).status).toBe(201);

    const b = await nuevaTanqueta();
    const repetido = await recibir(100, [linea(b, 100, conUnidad(otraUnidad, vale))]);
    expect(repetido.status, JSON.stringify(repetido.body)).toBe(400);
    expect(repetido.body.error).toMatch(/ya está registrado/);
    expect(Number((await ver(b)).saldo)).toBe(0);

    const c = await nuevaTanqueta();
    const d = await nuevaTanqueta();
    const mismo = nVale++;
    const enLaMisma = await recibir(200, [
      linea(c, 100, conUnidad(otraUnidad, mismo)),
      linea(d, 100, conUnidad(otraUnidad, mismo)),
    ]);
    expect(enLaMisma.status).toBe(400);
  });

  it("una tanqueta no va a dos unidades en el mismo reparto", async () => {
    const tq = await nuevaTanqueta();
    const r = await recibir(200, [
      linea(tq, 100, conUnidad(unidad)),
      linea(tq, 100, conUnidad(otraUnidad)),
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/dos unidades/);
  });

  it("si la unidad ya lleva 3 tanquetas, la recepción entera se rechaza", async () => {
    const llena = await (async () => {
      const u = (
        await admin.post("/api/erp/equipos").send({
          placa_codigo: idUnico("VQ"),
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
          grifo_interno_id: principal,
        })
      ).body.id as number;
      for (let i = 0; i < 3; i++) {
        const t = await nuevaTanqueta();
        expect((await recibir(100, [linea(t, 100, conUnidad(u))])).status).toBe(201);
      }
      return u;
    })();
    const cuarta = await nuevaTanqueta();
    const r = await recibir(100, [linea(cuarta, 100, conUnidad(llena))]);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toMatch(/3 tanquetas/);
    expect(Number((await ver(cuarta)).saldo)).toBe(0);
  });
});
