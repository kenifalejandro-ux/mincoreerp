/** tests/combustible-retorno-otra-tanqueta.test.ts
 *
 * Al recibir una tanqueta de vuelta, su saldo puede pasar a OTRA tanqueta de la
 * misma sede (0146): la de origen queda en cero y sin unidad, la de destino
 * suma el saldo con el costo con que viajó. Nada entra si no cabe, y dos
 * tanquetas que se pasan saldo al mismo tiempo no se esperan entre sí.
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
import { costoPromedioTanqueta } from "../src/modules/combustible/tanquetas.service";

describe("combustible: el saldo de una tanqueta pasa a otra tanqueta (0146)", () => {
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
    // De este tanque salen los llenados de las tanquetas.
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

  const nuevaTanqueta = async (grifo = principal) =>
    Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: grifo })).body.id
    );

  /** Le entra `cantidad` gal desde la fuente, al costo declarado. */
  async function llenar(id: number, cantidad: number, costo = 16) {
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: fuenteId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "OTR",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: costo,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
  }

  /** Una tanqueta con `cantidad` gal, asignada a una unidad propia. */
  async function tanquetaAsignada(cantidad: number, costo = 16) {
    const id = await nuevaTanqueta();
    const unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    await llenar(id, cantidad, costo);
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${id}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: "OAS", n_vale: nAsig++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return id;
  }

  const estado = async (id: number) => {
    const lista: { id: string; saldo: string; asignada_vigente: boolean }[] = (
      await admin.get("/api/erp/combustible/tanquetas")
    ).body;
    const t = lista.find((x) => String(x.id) === String(id))!;
    return { saldo: Number(t.saldo), asignada: t.asignada_vigente };
  };

  const filas = (origen: number) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT destino, tanqueta_destino_id, costo_unitario_tanqueta::float AS costo,
                saldo_validado::float AS validado
           FROM combustible_tanqueta_retornos WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tenantId, origen]
      );
      return r.rows;
    });

  const pasar = (origen: number, destino: number, opciones = {}) =>
    recibirTanqueta(admin, origen, {
      destino: "tanqueta",
      tanquetaDestinoId: destino,
      ...opciones,
    });

  it("el saldo pasa: el origen queda en cero y sin unidad, el destino lo suma", async () => {
    const origen = await tanquetaAsignada(100);
    const destino = await nuevaTanqueta();
    const r = await pasar(origen, destino);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await estado(origen)).toEqual({ saldo: 0, asignada: false });
    expect((await estado(destino)).saldo).toBe(100);
    expect(await filas(origen)).toEqual([
      expect.objectContaining({
        destino: "tanqueta",
        tanqueta_destino_id: String(destino),
        costo: 16,
        validado: 100,
      }),
    ]);
  });

  it("pasa lo que el grifero validó, no lo calculado", async () => {
    const origen = await tanquetaAsignada(100);
    const destino = await nuevaTanqueta();
    const r = await pasar(origen, destino, { validado: 92, motivo: "se derramó al volver" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await estado(origen)).toEqual({ saldo: 0, asignada: false });
    expect((await estado(destino)).saldo).toBe(92);
  });

  it("el destino mezcla los costos: 100 a S/ 20 y 100 que llegan a S/ 16 promedian S/ 18", async () => {
    const origen = await tanquetaAsignada(100, 16);
    const destino = await nuevaTanqueta();
    await llenar(destino, 100, 20);
    expect((await pasar(origen, destino)).status).toBe(201);
    const costo = await withTenant(tenantId, (client) =>
      costoPromedioTanqueta(client, tenantId, destino)
    );
    expect(costo).toBeCloseTo(18, 4);
  });

  it("una tanqueta que va asignada a otra unidad también puede recibir", async () => {
    const origen = await tanquetaAsignada(60);
    const destino = await tanquetaAsignada(50);
    expect((await pasar(origen, destino)).status).toBe(201);
    expect((await estado(destino)).saldo).toBe(110);
    expect((await estado(destino)).asignada).toBe(true);
  });

  it("si no cabe no entra nada y el origen sigue con su saldo", async () => {
    const origen = await tanquetaAsignada(100);
    const casiLlena = await nuevaTanqueta();
    await llenar(casiLlena, 250);
    const r = await pasar(origen, casiLlena);
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("solo tiene 30 gal libres");
    expect(await filas(origen)).toHaveLength(0);
    expect(await estado(origen)).toEqual({ saldo: 100, asignada: true });
    expect((await estado(casiLlena)).saldo).toBe(250);
  });

  it("no pasa a sí misma, a otra sede, a una dada de baja ni a una que no existe", async () => {
    const origen = await tanquetaAsignada(100);
    const consigo = await pasar(origen, origen);
    expect(consigo.status).toBe(400);
    expect(consigo.body.message).toContain("misma tanqueta");

    const ajena = await nuevaTanqueta(otroGrifo);
    const deOtraSede = await pasar(origen, ajena);
    expect(deOtraSede.status).toBe(400);
    expect(deOtraSede.body.message).toContain("otra sede");

    const baja = await nuevaTanqueta();
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE combustible_tanquetas SET activa = false, motivo_baja = 'prueba'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, baja]
      )
    );
    const aBaja = await pasar(origen, baja);
    expect(aBaja.status).toBe(400);
    expect(aBaja.body.message).toContain("dada de baja");

    expect((await pasar(origen, 99999999)).status).toBe(400);
    expect(await estado(origen)).toEqual({ saldo: 100, asignada: true });
  });

  it("el destino pide su tanqueta, los demás no la llevan y vacía no hay nada que pasar", async () => {
    const origen = await tanquetaAsignada(100);
    const otra = await nuevaTanqueta();
    expect((await recibirTanqueta(admin, origen, { destino: "tanqueta" })).status).toBe(400);
    expect(
      (await recibirTanqueta(admin, origen, { destino: "reserva", tanquetaDestinoId: otra })).status
    ).toBe(400);
    const vacia = await pasar(origen, otra, { validado: 0, motivo: "no volvió nada" });
    expect(vacia.status).toBe(400);
    expect(vacia.body.message).toContain("vacía");
    expect(await estado(origen)).toEqual({ saldo: 100, asignada: true });
  });

  it("bloquea las dos tanquetas en orden de id: no se queda con la mayor mientras espera la menor", async () => {
    // Sin ese orden, A→B y B→A al mismo tiempo se esperarían entre sí (deadlock).
    // Se comprueba a mano: se sostiene el bloqueo de la tanqueta de MENOR id y se
    // lanza el retorno desde la de MAYOR id hacia ella. Si el retorno tomara
    // primero la suya (la mayor), seguiría reteniéndola mientras espera la menor.
    const menor = await nuevaTanqueta();
    const mayor = await tanquetaAsignada(50);
    expect(mayor).toBeGreaterThan(menor);
    const bloquear = (client: import("pg").PoolClient, id: number, nowait = "") =>
      client.query(
        `SELECT 1 FROM combustible_tanquetas WHERE tenant_id = $1 AND id = $2 FOR UPDATE ${nowait}`,
        [tenantId, id]
      );
    let pendiente: ReturnType<typeof pasar> | undefined;
    await withTenant(tenantId, async (cliente) => {
      await bloquear(cliente, menor);
      pendiente = pasar(mayor, menor);
      await new Promise((r) => setTimeout(r, 700));
      // Otra conexión: la mayor tiene que estar libre (NOWAIT falla si no lo está).
      await withTenant(tenantId, (otra) => bloquear(otra, mayor, "NOWAIT"));
    });
    const r = await pendiente!;
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("dos tanquetas que se pasan saldo a la vez terminan sin error de servidor", async () => {
    const a = await tanquetaAsignada(50);
    const b = await tanquetaAsignada(50);
    const [ab, ba] = await Promise.all([pasar(a, b), pasar(b, a)]);
    expect([ab.status, ba.status]).not.toContain(500);
    expect([ab.status, ba.status]).toContain(201);
  });

  it("dos tanquetas que pasan a la vez a una con espacio para una: entra una sola", async () => {
    const a = await tanquetaAsignada(100);
    const b = await tanquetaAsignada(100);
    const destino = await nuevaTanqueta();
    await llenar(destino, 150);
    const [ra, rb] = await Promise.all([pasar(a, destino), pasar(b, destino)]);
    expect([ra.status, rb.status].sort()).toEqual([201, 400]);
    expect((await estado(destino)).saldo).toBe(250);
  });

  it("el historial muestra la salida en el origen y la llegada en el destino", async () => {
    const origen = await tanquetaAsignada(100);
    const destino = await nuevaTanqueta();
    expect((await pasar(origen, destino)).status).toBe(201);
    type Mov = { tipo: string; cantidad: string; tanque_codigo: string };
    const deOrigen = (await admin.get(`/api/erp/combustible/tanquetas/${origen}/historial`))
      .body as Mov[];
    const deDestino = (await admin.get(`/api/erp/combustible/tanquetas/${destino}/historial`))
      .body as Mov[];
    expect(deOrigen.find((m) => m.tipo === "retorno_traslado")).toBeTruthy();
    const llegada = deDestino.find((m) => m.tipo === "traslado_recibido");
    expect(llegada).toBeTruthy();
    expect(Number(llegada!.cantidad)).toBe(100);
  });
});
