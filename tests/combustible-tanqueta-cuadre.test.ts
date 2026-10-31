/** tests/combustible-tanqueta-cuadre.test.ts
 *
 * El cuadre de cada salida de una tanqueta: del vale con que se entrega a una unidad hasta
 * que vuelve. Salió con · cargó · debía volver · volvió · diferencia. Solo lectura.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  armarCuadre,
  type CargaBruta,
  type RetornoBruto,
  type SalidaBruta,
} from "../src/modules/combustible/cuadreTanqueta";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  recibirTanqueta,
} from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));
const salida = (min: number, extra: Partial<SalidaBruta> = {}): SalidaBruta => ({
  fuente: "asignacion",
  inicio: t(min),
  placa: "VQ-1",
  serie: "A-2",
  nVale: min,
  cantidad: 100,
  ...extra,
});
const retorno = (min: number, extra: Partial<RetornoBruto> = {}): RetornoBruto => ({
  creadoEn: t(min),
  placa: "VQ-1",
  calculado: 30,
  validado: 28,
  diferencia: -2,
  motivo: "se derramó",
  destino: "reserva",
  ...extra,
});
const carga = (min: number, cantidad: number): CargaBruta => ({ en: t(min), cantidad });
const SIN_UNIDAD = { saldo: 0, unidad: null };

describe("cuadre de la tanqueta: el cálculo", () => {
  it("una salida cerrada: salió con, cargó, debía volver, volvió, diferencia", () => {
    const [s] = armarCuadre(
      [salida(0)],
      [retorno(60)],
      [carga(10, 40), carga(20, 30), carga(90, 5)],
      SIN_UNIDAD
    );
    expect(s).toMatchObject({
      vale: "A-2-0",
      estado: "cerrada",
      salioCon: 100,
      cargo: 70,
      cargas: 2,
      debiaVolver: 30,
      volvio: 28,
      diferencia: -2,
      motivo: "se derramó",
      destinoDelRetorno: "reserva",
      llevaAhora: null,
    });
  });

  it("la salida que sigue con la unidad dice cuánto lleva ahora", () => {
    const [s] = armarCuadre([salida(0)], [], [carga(10, 40)], { saldo: 60, unidad: "VQ-9" });
    expect(s).toMatchObject({ estado: "abierta", unidad: "VQ-1", cargo: 40, llevaAhora: 60 });
    const [sinPlaca] = armarCuadre([salida(0, { placa: null })], [], [], {
      saldo: 5,
      unidad: "VQ-9",
    });
    expect(sinPlaca.unidad).toBe("VQ-9");
  });

  it("el retorno a otra unidad (mismo instante que la salida nueva) cierra la anterior y no la nueva", () => {
    const r = armarCuadre(
      [salida(0, { placa: "VQ-1" }), salida(60, { placa: "VQ-2", cantidad: 28, nVale: 2 })],
      [retorno(60)],
      [carga(10, 70)],
      { saldo: 28, unidad: "VQ-2" }
    );
    expect(r.map((x) => [x.vale, x.estado])).toEqual([
      ["A-2-2", "abierta"],
      ["A-2-0", "cerrada"],
    ]);
    expect(r[1].cargo).toBe(70);
    expect(r[0]).toMatchObject({ cargo: 0, llevaAhora: 28 });
  });

  it("dos vales antes de volver: cada uno con sus cargas; el retorno es del último", () => {
    const r = armarCuadre(
      [salida(0, { nVale: 1 }), salida(30, { nVale: 2 })],
      [retorno(90)],
      [carga(10, 20), carga(50, 10)],
      SIN_UNIDAD
    );
    const primero = r.find((x) => x.vale === "A-2-1")!;
    const segundo = r.find((x) => x.vale === "A-2-2")!;
    expect(primero).toMatchObject({ estado: "sin_retorno", cargo: 20, volvio: null });
    expect(segundo).toMatchObject({ estado: "cerrada", cargo: 10, volvio: 28 });
  });

  it("sin salidas no hay nada; sin cantidad en el vale (anterior a la 0142) sale nulo", () => {
    expect(armarCuadre([], [retorno(5)], [carga(1, 1)], SIN_UNIDAD)).toEqual([]);
    expect(armarCuadre([salida(0, { cantidad: null })], [], [], SIN_UNIDAD)[0].salioCon).toBeNull();
  });

  it("una salida liberada sin retorno queda sin_retorno", () => {
    expect(armarCuadre([salida(0)], [], [], SIN_UNIDAD)[0].estado).toBe("sin_retorno");
  });
});

describe("cuadre de la tanqueta: por la API", () => {
  const password = "ClaveDePrueba123";
  const A = request.agent(app);
  const B = request.agent(app);
  let tA: string;
  let tB: string;
  let grifoA: number;
  let tanqueA: number;
  let proveedor: number;
  let nVale = 1;
  let seq = 0;
  const serie = () => `CU${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`.toUpperCase();

  const unidad = async () => {
    const placa = idUnico("VQ");
    const id = Number(
      (
        await A.post("/api/erp/equipos").send({
          placa_codigo: placa,
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
          grifo_interno_id: grifoA,
        })
      ).body.id
    );
    return { id, placa };
  };
  const tanqueta = async () =>
    Number(
      (await A.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: grifoA })).body.id
    );
  const llenar = async (tq: number, extra: Record<string, unknown> = {}) => {
    const r = await A.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      origen: "tanque_propio",
      combustible_id: tanqueA,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tq,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const asignar = async (tq: number, equipo: number) => {
    const r = await A.put(`/api/erp/combustible/tanquetas/${tq}/asignar`).send({
      equipo_id: equipo,
      serie_talonario: serie(),
      n_vale: nVale++,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const cargarEnRuta = async (tq: number, equipo: number, cantidad: number) => {
    const r = await A.post("/api/erp/combustible/despachos").send({
      origen: "tanqueta",
      tanqueta_origen_id: tq,
      tanqueta_lugar: "ruta",
      tipo_destino: "equipo",
      equipo_id: equipo,
      tipo_combustible: "diesel_b5",
      cantidad,
      lectura_horometro: 100 + nVale++,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const cuadre = async (tq: number, ag = A) => {
    const r = await ag.get(`/api/erp/combustible/tanquetas/${tq}/cuadre`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Array<Record<string, unknown>>;
  };

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
          tanque_nombre: "Tanque del cuadre",
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
    proveedor = (await A.post("/api/erp/combustible/grifos").send({ nombre: idUnico("CIS") })).body
      .id;
  });
  afterAll(async () => {
    await borrarTenantDePrueba(tA);
    await borrarTenantDePrueba(tB);
    await closeDatabase();
  });

  it("el caso completo: salió con 100, cargó 70, debía volver 30, volvió 28; la salida nueva queda abierta", async () => {
    const tq = await tanqueta();
    const u1 = await unidad();
    const u2 = await unidad();
    await llenar(tq);
    await asignar(tq, u1.id);
    await cargarEnRuta(tq, u1.id, 70);
    const ret = await recibirTanqueta(A, tq, {
      validado: 28,
      motivo: "se derramó al bajarla",
      destino: "unidad",
      unidad: { equipo_id: u2.id, serie_talonario: serie(), n_vale: nVale++ },
    });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const [nueva, vieja] = await cuadre(tq);
    expect(vieja).toMatchObject({
      fuente: "asignacion",
      unidad: u1.placa,
      estado: "cerrada",
      salioCon: 100,
      cargo: 70,
      cargas: 1,
      debiaVolver: 30,
      volvio: 28,
      diferencia: -2,
      motivo: "se derramó al bajarla",
      destinoDelRetorno: "reserva",
    });
    expect(nueva).toMatchObject({
      unidad: u2.placa,
      estado: "abierta",
      salioCon: 28,
      llevaAhora: 28,
    });
  });

  it("una carga anulada no cuenta", async () => {
    const tq = await tanqueta();
    const u = await unidad();
    await llenar(tq);
    await asignar(tq, u.id);
    const c1 = await cargarEnRuta(tq, u.id, 40);
    await cargarEnRuta(tq, u.id, 20);
    expect(
      (
        await A.patch(`/api/erp/combustible/despachos/${c1}/anular`).send({
          motivo: "se tipeó mal",
        })
      ).status
    ).toBe(200);
    const [s] = await cuadre(tq);
    expect(s).toMatchObject({ cargo: 20, cargas: 1, estado: "abierta", llevaAhora: 80 });
  });

  it("llenar la tanqueta eligiendo la unidad: la unidad sale del retorno que cierra la salida", async () => {
    const tq = await tanqueta();
    const u = await unidad();
    await llenar(tq, {
      tanqueta_equipo_id: u.id,
      serie_talonario: serie(),
      n_vale: nVale++,
      cantidad: 90,
      lectura_contometro: 90,
    });
    const [abierta] = await cuadre(tq);
    expect(abierta).toMatchObject({
      fuente: "llenado",
      unidad: u.placa,
      estado: "abierta",
      salioCon: 90,
    });
    await cargarEnRuta(tq, u.id, 50);
    expect((await recibirTanqueta(A, tq)).status).toBe(201);
    const [cerrada] = await cuadre(tq);
    expect(cerrada).toMatchObject({
      fuente: "llenado",
      unidad: u.placa,
      estado: "cerrada",
      salioCon: 90,
      cargo: 50,
      debiaVolver: 40,
      volvio: 40,
      diferencia: 0,
    });
  });

  it("un llenado SIN unidad no es una salida", async () => {
    const tq = await tanqueta();
    await llenar(tq, { serie_talonario: undefined, n_vale: undefined });
    expect(await cuadre(tq)).toEqual([]);
  });

  it("el reparto de un excedente con unidad y vale es una salida con la unidad de la línea", async () => {
    const tq = await tanqueta();
    const u = await unidad();
    const fuente = (
      await A.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Tanque cancha",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 2000,
        nivel_actual: 2000,
        requiere_documento: false,
        modo_excedente_recepcion: "flexible",
        grifo_interno_id: grifoA,
      })
    ).body.id as number;
    const rec = await A.post("/api/erp/combustible/recepciones").send({
      combustible_id: fuente,
      grifo_id: proveedor,
      cantidad: 280,
      costo_unitario: 17,
      recibido_en: new Date().toISOString(),
      reparto_excedente: [
        {
          destino: "cubeta",
          cantidad: 280,
          tanqueta_id: tq,
          tanqueta_equipo_id: u.id,
          serie_talonario: serie(),
          n_vale: nVale++,
        },
      ],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const [s] = await cuadre(tq);
    expect(s).toMatchObject({
      fuente: "excedente",
      unidad: u.placa,
      salioCon: 280,
      estado: "abierta",
    });
  });

  it("cada destino del retorno queda anotado: tanque (pozo) y otra tanqueta", async () => {
    const tqPozo = await tanqueta();
    const tqTraslado = await tanqueta();
    const tqDestino = await tanqueta();
    const u = await unidad();
    for (const tq of [tqPozo, tqTraslado]) {
      await llenar(tq);
      await asignar(tq, u.id);
      const r =
        tq === tqPozo
          ? await recibirTanqueta(A, tq, { destino: "pozo", tanqueId: tanqueA })
          : await recibirTanqueta(A, tq, { destino: "tanqueta", tanquetaDestinoId: tqDestino });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    expect((await cuadre(tqPozo))[0]).toMatchObject({
      estado: "cerrada",
      destinoDelRetorno: "pozo",
    });
    expect((await cuadre(tqTraslado))[0]).toMatchObject({
      estado: "cerrada",
      destinoDelRetorno: "tanqueta",
    });
  });

  it("una asignación anterior a la 0142 (sin cantidad) sale con 'salió con' nulo", async () => {
    const tq = await tanqueta();
    const u = await unidad();
    await llenar(tq);
    await asignar(tq, u.id);
    await withTenant(tA, (c) =>
      c.query(
        `UPDATE combustible_tanqueta_asignaciones SET cantidad = NULL WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tA, tq]
      )
    );
    expect((await cuadre(tq))[0].salioCon).toBeNull();
  });

  it("una tanqueta liberada sin retorno queda 'sin_retorno', no 'abierta'", async () => {
    const tq = await tanqueta();
    const u = await unidad();
    await llenar(tq);
    await asignar(tq, u.id);
    await withTenant(tA, (c) =>
      c.query(
        `UPDATE combustible_tanquetas SET equipo_asignado_id = NULL, asignada_en = NULL WHERE tenant_id = $1 AND id = $2`,
        [tA, tq]
      )
    );
    expect((await cuadre(tq))[0]).toMatchObject({ estado: "sin_retorno", llevaAhora: null });
  });

  it("una tanqueta de otra empresa da 404 y un id que no es un número válido da 400", async () => {
    const tq = await tanqueta();
    const u = await unidad();
    await llenar(tq);
    await asignar(tq, u.id);
    expect((await B.get(`/api/erp/combustible/tanquetas/${tq}/cuadre`)).status).toBe(404);
    for (const id of ["abc", "0", "-1", "99999999999999999999"]) {
      expect((await A.get(`/api/erp/combustible/tanquetas/${id}/cuadre`)).status, id).toBe(400);
    }
    expect(tB).toBeTruthy();
  });
});
