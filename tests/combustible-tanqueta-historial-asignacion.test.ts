/** tests/combustible-tanqueta-historial-asignacion.test.ts
 *
 * El vale de la salida a una unidad (el que se escribe al asignar la tanqueta, 0141/0142)
 * sale en el historial de la tanqueta: serie, número, lo que llevaba y la unidad. No mueve
 * combustible, así que no cambia su saldo. Las asignaciones anteriores a la 0142 no
 * guardaron la cantidad y salen sin ella.
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

const password = "ClaveDePrueba123";
type Agente = ReturnType<typeof request.agent>;
let seq = 0;
const serieUnica = () =>
  `AS${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`.toUpperCase();

interface Movimiento {
  tipo: string;
  id: string;
  cantidad: string | null;
  equipo: string | null;
  serie_talonario: string | null;
  n_vale: number | null;
  usuario: string | null;
}

describe("combustible: el historial de la tanqueta muestra el vale de la asignación", () => {
  const A = request.agent(app);
  const B = request.agent(app);
  let tA: string;
  let tB: string;
  let grifoA: number;
  let tanqueA: number;
  let nVale = 1;

  const equipo = async (ag: Agente, grifo: number, placa = idUnico("VQ")) => {
    const r = await ag.post("/api/erp/equipos").send({
      placa_codigo: placa,
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: grifo,
    });
    return { id: Number(r.body.id), placa };
  };
  /** Una tanqueta con 100 gal (traspaso sin vale desde el tanque). */
  const tanquetaConSaldo = async () => {
    const id = Number(
      (await A.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: grifoA })).body.id
    );
    const llenado = await A.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      origen: "tanque_propio",
      combustible_id: tanqueA,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
    });
    expect(llenado.status, JSON.stringify(llenado.body)).toBe(201);
    return id;
  };
  const historial = async (ag: Agente, id: number) => {
    const r = await ag.get(`/api/erp/combustible/tanquetas/${id}/historial`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (Array.isArray(r.body) ? r.body : r.body.data) as Movimiento[];
  };
  const saldo = async (id: number) =>
    Number(
      (await A.get("/api/erp/combustible/tanquetas")).body.find(
        (t: { id: string }) => Number(t.id) === id
      ).saldo
    );

  beforeAll(async () => {
    const a = await crearTenantDePrueba(password);
    tA = a.tenant.id;
    await A.post("/api/auth/login").send({
      tenantSlug: a.tenant.slug,
      email: a.usuario.email,
      password,
    });
    const b = await crearTenantDePrueba(password);
    tB = b.tenant.id;
    await B.post("/api/auth/login").send({
      tenantSlug: b.tenant.slug,
      email: b.usuario.email,
      password,
    });
    grifoA = (await A.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    tanqueA = Number(
      (
        await A.post("/api/erp/combustible").send({
          codigo: idUnico("TQ"),
          tanque_nombre: "Tanque del historial",
          tipo_combustible: "diesel_b5",
          unidad: "gal",
          tipo_punto: "fijo",
          capacidad_total: 5000,
          nivel_actual: 4000,
          requiere_documento: false,
          modo_vigilancia: "sin_vigilar",
          grifo_interno_id: grifoA,
        })
      ).body.id
    );
  });
  afterAll(async () => {
    await borrarTenantDePrueba(tA);
    await borrarTenantDePrueba(tB);
    await closeDatabase();
  });

  it("asignar con vale deja una fila con la serie, el número, lo que llevaba y la unidad", async () => {
    const tq = await tanquetaConSaldo();
    const u = await equipo(A, grifoA);
    const serie = serieUnica();
    const r = await A.put(`/api/erp/combustible/tanquetas/${tq}/asignar`).send({
      equipo_id: u.id,
      serie_talonario: serie.toLowerCase(),
      n_vale: nVale++,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const filas = (await historial(A, tq)).filter((m) => m.tipo === "asignacion");
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      equipo: u.placa,
      serie_talonario: serie,
      n_vale: nVale - 1,
    });
    expect(Number(filas[0].cantidad)).toBe(100);
    expect(filas[0].usuario).toBeTruthy();
  });

  it("no mueve combustible: el saldo de la tanqueta no cambia al asignarla", async () => {
    const tq = await tanquetaConSaldo();
    expect(await saldo(tq)).toBe(100);
    const u = await equipo(A, grifoA);
    expect(
      (
        await A.put(`/api/erp/combustible/tanquetas/${tq}/asignar`).send({
          equipo_id: u.id,
          serie_talonario: serieUnica(),
          n_vale: nVale++,
        })
      ).status
    ).toBe(200);
    expect(await saldo(tq)).toBe(100);
  });

  it("una asignación anterior a la 0142 (sin cantidad) sale sin cantidad, sin romper el historial", async () => {
    const tq = await tanquetaConSaldo();
    const u = await equipo(A, grifoA);
    expect(
      (
        await A.put(`/api/erp/combustible/tanquetas/${tq}/asignar`).send({
          equipo_id: u.id,
          serie_talonario: serieUnica(),
          n_vale: nVale++,
        })
      ).status
    ).toBe(200);
    await withTenant(tA, (c) =>
      c.query(
        `UPDATE combustible_tanqueta_asignaciones SET cantidad = NULL WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tA, tq]
      )
    );
    const filas = await historial(A, tq);
    const asignacion = filas.find((m) => m.tipo === "asignacion");
    expect(asignacion).toBeDefined();
    expect(asignacion!.cantidad).toBeNull();
    expect(filas.some((m) => m.tipo === "prevision")).toBe(true);
  });

  it("el retorno a otra unidad deja el retorno y la asignación nueva con su vale", async () => {
    const tq = await tanquetaConSaldo();
    const u1 = await equipo(A, grifoA);
    const u2 = await equipo(A, grifoA);
    expect(
      (
        await A.put(`/api/erp/combustible/tanquetas/${tq}/asignar`).send({
          equipo_id: u1.id,
          serie_talonario: serieUnica(),
          n_vale: nVale++,
        })
      ).status
    ).toBe(200);
    const serie2 = serieUnica();
    const retorno = await recibirTanqueta(A, tq, {
      destino: "unidad",
      unidad: { equipo_id: u2.id, serie_talonario: serie2, n_vale: nVale++ },
    });
    expect(retorno.status, JSON.stringify(retorno.body)).toBe(201);
    const filas = await historial(A, tq);
    const asignaciones = filas.filter((m) => m.tipo === "asignacion");
    expect(asignaciones.map((m) => m.equipo).sort()).toEqual([u1.placa, u2.placa].sort());
    expect(asignaciones.find((m) => m.equipo === u2.placa)!.serie_talonario).toBe(serie2);
    expect(filas.some((m) => m.tipo === "retorno")).toBe(true);
  });

  it("solo salen las asignaciones de ESA tanqueta, y una tanqueta de otra empresa da 404", async () => {
    const tq1 = await tanquetaConSaldo();
    const tq2 = await tanquetaConSaldo();
    const u = await equipo(A, grifoA);
    expect(
      (
        await A.put(`/api/erp/combustible/tanquetas/${tq1}/asignar`).send({
          equipo_id: u.id,
          serie_talonario: serieUnica(),
          n_vale: nVale++,
        })
      ).status
    ).toBe(200);
    expect((await historial(A, tq2)).filter((m) => m.tipo === "asignacion")).toEqual([]);
    const ajena = await B.get(`/api/erp/combustible/tanquetas/${tq1}/historial`);
    expect(ajena.status).toBe(404);
    expect(JSON.stringify(ajena.body)).not.toContain(u.placa);
  });
});
