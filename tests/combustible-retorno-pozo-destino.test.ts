/** tests/combustible-retorno-pozo-destino.test.ts
 *
 * Al recibir una tanqueta de vuelta, el saldo puede volver al pozo (0145): sube
 * el nivel del tanque, baja la tanqueta a cero y el costo promedio del tanque
 * se rehace con lo que entró. Si el tanque mide en litros, el saldo (galones) y
 * su costo se convierten; si no cabe, no entra nada.
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

const LITROS_POR_GALON = 3.785411784;

describe("combustible: el saldo de una tanqueta vuelve al pozo (0145)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let principal: number;
  let otroGrifo: number;
  let fuenteId: number;
  let nVale = 1;
  let nAsig = 1;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    principal = sedes[0].grifos[0].id;
    otroGrifo = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: idUnico("Grifo") })
    ).body.id;
    // De este tanque salen los llenados de las tanquetas (a S/ 16 el galón).
    fuenteId = await tanque({ capacidad_total: 20000, nivel_actual: 15000 });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(
    o: { unidad?: string; capacidad_total?: number; nivel_actual?: number; grifo?: number } = {}
  ) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Pozo de prueba",
      tipo_combustible: "diesel_b5",
      unidad: o.unidad ?? "gal",
      tipo_punto: "fijo",
      capacidad_total: o.capacidad_total ?? 10000,
      nivel_actual: o.nivel_actual ?? 5000,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: o.grifo ?? principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  /** Una tanqueta con `cantidad` gal, asignada a una unidad propia. */
  async function tanquetaAsignada(cantidad: number) {
    const t = await admin
      .post("/api/erp/combustible/tanquetas")
      .send({ grifo_interno_id: principal });
    const id = Number(t.body.id);
    const unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: fuenteId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "POZ",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${id}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: "PAS", n_vale: nAsig++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return id;
  }

  const saldoDe = async (id: number) => {
    const lista: { id: string; saldo: string; asignada_vigente: boolean }[] = (
      await admin.get("/api/erp/combustible/tanquetas")
    ).body;
    const t = lista.find((x) => String(x.id) === String(id))!;
    return { saldo: Number(t.saldo), asignada: t.asignada_vigente };
  };

  const nivelTeorico = async (tanqueId: number) => {
    const r = await admin.get("/api/erp/combustible");
    const lista: { id: number; nivel_teorico: string | null }[] = r.body.data ?? r.body;
    return Number(lista.find((t) => t.id === tanqueId)!.nivel_teorico);
  };

  const filaDelRetorno = (tanquetaId: number) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT destino, combustible_id, cantidad_pozo::float AS cantidad_pozo,
                costo_unitario_pozo::float AS costo_unitario_pozo, saldo_validado::float AS validado
           FROM combustible_tanqueta_retornos WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tenantId, tanquetaId]
      );
      return r.rows;
    });

  it("el saldo vuelve al pozo: sube el nivel, la tanqueta queda en cero y sin unidad", async () => {
    const pozo = await tanque({ nivel_actual: 5000 });
    const antes = await nivelTeorico(pozo);
    const tqt = await tanquetaAsignada(100);
    const r = await recibirTanqueta(admin, tqt, { destino: "pozo", tanqueId: pozo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    expect(await nivelTeorico(pozo)).toBe(antes + 100);
    expect(await saldoDe(tqt)).toEqual({ saldo: 0, asignada: false });
    expect(await filaDelRetorno(tqt)).toEqual([
      expect.objectContaining({
        destino: "pozo",
        combustible_id: pozo,
        cantidad_pozo: 100,
        costo_unitario_pozo: 16,
      }),
    ]);
  });

  it("vuelve lo que el grifero validó, no lo calculado, y deja el motivo", async () => {
    const pozo = await tanque();
    const tqt = await tanquetaAsignada(100);
    const r = await recibirTanqueta(admin, tqt, {
      destino: "pozo",
      tanqueId: pozo,
      validado: 90,
      motivo: "se derramó al volver",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await saldoDe(tqt)).toEqual({ saldo: 0, asignada: false });
    expect((await filaDelRetorno(tqt))[0]).toMatchObject({ cantidad_pozo: 90, validado: 90 });
  });

  it("a un tanque en litros entra convertido, con su costo por litro", async () => {
    const pozoL = await tanque({ unidad: "L", capacidad_total: 100000, nivel_actual: 50000 });
    const tqt = await tanquetaAsignada(100);
    const r = await recibirTanqueta(admin, tqt, { destino: "pozo", tanqueId: pozoL });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const fila = (await filaDelRetorno(tqt))[0];
    expect(fila.cantidad_pozo).toBeCloseTo(100 * LITROS_POR_GALON, 2);
    expect(fila.costo_unitario_pozo).toBeCloseTo(16 / LITROS_POR_GALON, 4);
  });

  it("si no cabe en el tanque no entra nada y la tanqueta sigue con su saldo", async () => {
    const lleno = await tanque({ capacidad_total: 500, nivel_actual: 450 });
    const tqt = await tanquetaAsignada(100);
    const r = await recibirTanqueta(admin, tqt, { destino: "pozo", tanqueId: lleno });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("solo tiene espacio para 50 gal");
    expect(await filaDelRetorno(tqt)).toHaveLength(0);
    expect(await saldoDe(tqt)).toEqual({ saldo: 100, asignada: true });
  });

  it("no vuelve a un tanque de otra sede, a uno dado de baja ni a uno que no existe", async () => {
    const tqt = await tanquetaAsignada(100);
    const ajeno = await tanque({ grifo: otroGrifo });
    const deOtraSede = await recibirTanqueta(admin, tqt, { destino: "pozo", tanqueId: ajeno });
    expect(deOtraSede.status).toBe(400);
    expect(deOtraSede.body.message).toContain("otra sede");

    const baja = await tanque();
    await withTenant(tenantId, (client) =>
      client.query(`UPDATE combustible SET activo = false WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        baja,
      ])
    );
    const aBaja = await recibirTanqueta(admin, tqt, { destino: "pozo", tanqueId: baja });
    expect(aBaja.status).toBe(400);
    expect(aBaja.body.message).toContain("dado de baja");

    const noExiste = await recibirTanqueta(admin, tqt, { destino: "pozo", tanqueId: 99999999 });
    expect(noExiste.status).toBe(400);
    expect(await saldoDe(tqt)).toEqual({ saldo: 100, asignada: true });
  });

  it("el destino pide su tanque, y reserva no lo lleva; vacía no hay nada que devolver", async () => {
    const pozo = await tanque();
    const tqt = await tanquetaAsignada(100);
    const sinTanque = await recibirTanqueta(admin, tqt, { destino: "pozo" });
    expect(sinTanque.status).toBe(400);
    const reservaConTanque = await recibirTanqueta(admin, tqt, {
      destino: "reserva",
      tanqueId: pozo,
    });
    expect(reservaConTanque.status).toBe(400);
    const vacia = await recibirTanqueta(admin, tqt, {
      destino: "pozo",
      tanqueId: pozo,
      validado: 0,
      motivo: "no volvió nada",
    });
    expect(vacia.status).toBe(400);
    expect(vacia.body.message).toContain("vacía");
    expect(await saldoDe(tqt)).toEqual({ saldo: 100, asignada: true });
  });

  it("dos retornos a la vez a un pozo con espacio para uno: entra uno solo", async () => {
    const justo = await tanque({ capacidad_total: 500, nivel_actual: 350 });
    const a = await tanquetaAsignada(100);
    const b = await tanquetaAsignada(100);
    const [ra, rb] = await Promise.all([
      recibirTanqueta(admin, a, { destino: "pozo", tanqueId: justo }),
      recibirTanqueta(admin, b, { destino: "pozo", tanqueId: justo }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([201, 400]);
    expect(await nivelTeorico(justo)).toBe(450);
  });

  it("el movimiento aparece en el historial de la tanqueta como una salida al pozo", async () => {
    const pozo = await tanque();
    const tqt = await tanquetaAsignada(100);
    expect((await recibirTanqueta(admin, tqt, { destino: "pozo", tanqueId: pozo })).status).toBe(
      201
    );
    const h = await admin.get(`/api/erp/combustible/tanquetas/${tqt}/historial`);
    expect(h.status).toBe(200);
    const fila = (h.body as { tipo: string; cantidad: string; tanque_codigo: string }[]).find(
      (m) => m.tipo === "retorno_pozo"
    );
    expect(fila).toBeTruthy();
    expect(Number(fila!.cantidad)).toBe(100);
  });
});
