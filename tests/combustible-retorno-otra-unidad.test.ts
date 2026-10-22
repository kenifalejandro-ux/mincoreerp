/** tests/combustible-retorno-otra-unidad.test.ts
 *
 * Al recibir una tanqueta de vuelta, su saldo puede seguir con OTRA unidad: el
 * retorno y la asignación (con el vale de esa salida) son una sola operación.
 * Si algo falla --vale repetido, unidad con sus tres tanquetas, unidad de baja--
 * no queda nada a medias: la tanqueta sigue con la unidad de la que volvió.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  recibirTanqueta,
} from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: el saldo de una tanqueta sigue con otra unidad (retorno + asignación)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let principal: number;
  let fuenteId: number;
  let nVale = 1;
  let nAsig = 1;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Fuente de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    fuenteId = r.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const nuevaUnidad = async () =>
    Number(
      (
        await admin.post("/api/erp/equipos").send({
          placa_codigo: idUnico("VQ"),
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
          grifo_interno_id: principal,
        })
      ).body.id
    );

  /** Una tanqueta con `cantidad` gal asignada a `unidad`. */
  async function tanquetaDe(unidad: number, cantidad: number) {
    const id = Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: fuenteId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "UNI",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${id}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: "UAS", n_vale: nAsig++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return id;
  }

  const estado = async (id: number) => {
    const lista: {
      id: string;
      saldo: string;
      asignada_vigente: boolean;
      equipo_asignado_id: number | null;
    }[] = (await admin.get("/api/erp/combustible/tanquetas")).body;
    const t = lista.find((x) => String(x.id) === String(id))!;
    return {
      saldo: Number(t.saldo),
      asignada: t.asignada_vigente,
      unidad: t.equipo_asignado_id === null ? null : Number(t.equipo_asignado_id),
    };
  };

  const nRetornos = (tanqueta: number) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM combustible_tanqueta_retornos
          WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tenantId, tanqueta]
      );
      return r.rows[0].n as number;
    });

  const valesDe = (tanqueta: number) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT equipo_id, serie_talonario, n_vale, cantidad::float AS cantidad
           FROM combustible_tanqueta_asignaciones
          WHERE tenant_id = $1 AND tanqueta_id = $2 ORDER BY id`,
        [tenantId, tanqueta]
      );
      return r.rows;
    });

  const aOtraUnidad = (
    tanqueta: number,
    equipo_id: number,
    n_vale: number,
    opciones: { validado?: number; motivo?: string; serie?: string } = {}
  ) =>
    recibirTanqueta(admin, tanqueta, {
      destino: "unidad",
      unidad: { equipo_id, serie_talonario: opciones.serie ?? "DST", n_vale },
      validado: opciones.validado,
      motivo: opciones.motivo,
    });

  it("el saldo sigue con la otra unidad, con el vale de esa salida", async () => {
    const u1 = await nuevaUnidad();
    const u2 = await nuevaUnidad();
    const tqt = await tanquetaDe(u1, 100);
    const r = await aOtraUnidad(tqt, u2, 9001);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await estado(tqt)).toEqual({ saldo: 100, asignada: true, unidad: u2 });
    expect(await nRetornos(tqt)).toBe(1);
    const vales = await valesDe(tqt);
    expect(vales[vales.length - 1]).toMatchObject({
      equipo_id: u2,
      serie_talonario: "DST",
      n_vale: 9001,
      cantidad: 100,
    });
  });

  it("el vale lleva lo que el grifero validó, no lo calculado", async () => {
    const u1 = await nuevaUnidad();
    const u2 = await nuevaUnidad();
    const tqt = await tanquetaDe(u1, 100);
    const r = await aOtraUnidad(tqt, u2, 9002, { validado: 92, motivo: "se derramó" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await estado(tqt)).toEqual({ saldo: 92, asignada: true, unidad: u2 });
    const vales = await valesDe(tqt);
    expect(vales[vales.length - 1].cantidad).toBe(92);
  });

  it("no pasa a la misma unidad de la que volvió", async () => {
    const u1 = await nuevaUnidad();
    const tqt = await tanquetaDe(u1, 100);
    const r = await aOtraUnidad(tqt, u1, 9003);
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("elige otra");
    expect(await nRetornos(tqt)).toBe(0);
    expect(await estado(tqt)).toEqual({ saldo: 100, asignada: true, unidad: u1 });
  });

  it("si el vale ya existe no queda nada a medias: sigue con su unidad, sin retorno", async () => {
    const u1 = await nuevaUnidad();
    const u2 = await nuevaUnidad();
    const tqt = await tanquetaDe(u1, 100);
    expect((await aOtraUnidad(await tanquetaDe(u1, 50), u2, 9004)).status).toBe(201);
    const repetido = await aOtraUnidad(tqt, u2, 9004);
    expect(repetido.status).toBe(409);
    expect(repetido.body.message).toContain("ya está registrado");
    expect(await nRetornos(tqt)).toBe(0);
    expect(await estado(tqt)).toEqual({ saldo: 100, asignada: true, unidad: u1 });
  });

  it("si la otra unidad ya lleva sus tres tanquetas, no queda nada a medias", async () => {
    const u1 = await nuevaUnidad();
    const llena = await nuevaUnidad();
    for (let i = 0; i < 3; i++) await tanquetaDe(llena, 10);
    const tqt = await tanquetaDe(u1, 100);
    const r = await aOtraUnidad(tqt, llena, 9005);
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("ya lleva 3 tanquetas");
    expect(await nRetornos(tqt)).toBe(0);
    expect(await estado(tqt)).toEqual({ saldo: 100, asignada: true, unidad: u1 });
  });

  it("no pasa a una unidad dada de baja ni a una que no existe", async () => {
    const u1 = await nuevaUnidad();
    const baja = await nuevaUnidad();
    await withTenant(tenantId, (client) =>
      client.query(`UPDATE equipos SET activo = false WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        baja,
      ])
    );
    const tqt = await tanquetaDe(u1, 100);
    const aBaja = await aOtraUnidad(tqt, baja, 9006);
    expect(aBaja.status).toBe(400);
    expect(aBaja.body.message).toContain("dada de baja");
    expect((await aOtraUnidad(tqt, 99999999, 9007)).status).toBe(400);
    expect(await nRetornos(tqt)).toBe(0);
    expect(await estado(tqt)).toEqual({ saldo: 100, asignada: true, unidad: u1 });
  });

  it("vacía no hay nada que asignar, y el destino pide su unidad y su vale", async () => {
    const u1 = await nuevaUnidad();
    const u2 = await nuevaUnidad();
    const tqt = await tanquetaDe(u1, 100);
    const vacia = await aOtraUnidad(tqt, u2, 9008, { validado: 0, motivo: "no volvió nada" });
    expect(vacia.status).toBe(400);
    expect(vacia.body.message).toContain("vacía");
    expect((await recibirTanqueta(admin, tqt, { destino: "unidad" })).status).toBe(400);
    const otroDestinoConUnidad = await recibirTanqueta(admin, tqt, {
      destino: "reserva",
      unidad: { equipo_id: u2, serie_talonario: "DST", n_vale: 9009 },
    });
    expect(otroDestinoConUnidad.status).toBe(400);
    expect(await nRetornos(tqt)).toBe(0);
    expect(await estado(tqt)).toEqual({ saldo: 100, asignada: true, unidad: u1 });
  });
});
