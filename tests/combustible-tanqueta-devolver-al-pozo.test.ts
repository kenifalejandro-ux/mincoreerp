/** tests/combustible-tanqueta-devolver-al-pozo.test.ts
 *
 * El grifero devuelve al tanque (pozo) lo que sobra de una tanqueta que NO va con ninguna unidad
 * (0178): todo el saldo o la parte que quiera, con motivo opcional. Sube el nivel del tanque, baja
 * el saldo de la tanqueta, no es un ajuste (sin diferencia ni alerta) y no cierra ninguna salida
 * en el cuadre. Una tanqueta que va con una unidad no entra por acá: se cuadra al recibirla.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: devolver al pozo lo que sobra de una tanqueta sin unidad (0178)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let principal: number;
  let otroGrifo: number;
  let fuenteId: number;
  let nVale = 1;

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

  /** Una tanqueta con `cantidad` gal que el grifero llenó desde el tanque: sin unidad. */
  async function tanquetaConSaldo(cantidad: number) {
    const t = await admin
      .post("/api/erp/combustible/tanquetas")
      .send({ grifo_interno_id: principal });
    const id = Number(t.body.id);
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: fuenteId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "DEV",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    return id;
  }

  const devolver = (id: number, body: Record<string, unknown>) =>
    admin.post(`/api/erp/combustible/tanquetas/${id}/devolver-al-pozo`).send(body);

  const saldoDe = async (id: number) => {
    const lista: { id: string; saldo: string }[] = (
      await admin.get("/api/erp/combustible/tanquetas")
    ).body;
    return Number(lista.find((x) => String(x.id) === String(id))!.saldo);
  };

  const nivelTeorico = async (tanqueId: number) => {
    const r = await admin.get("/api/erp/combustible");
    const lista: { id: number; nivel_teorico: string | null }[] = r.body.data ?? r.body;
    return Number(lista.find((t) => t.id === tanqueId)!.nivel_teorico);
  };

  const filas = (tanquetaId: number) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT equipo_id, destino, combustible_id, cantidad_pozo::float AS cantidad_pozo,
                costo_unitario_pozo::float AS costo, saldo_calculado::float AS calculado,
                saldo_validado::float AS validado, diferencia::float AS diferencia, motivo
           FROM combustible_tanqueta_retornos
          WHERE tenant_id = $1 AND tanqueta_id = $2 ORDER BY id`,
        [tenantId, tanquetaId]
      );
      return r.rows;
    });

  it("devuelve una parte: sube el nivel del tanque y la tanqueta se queda con el resto", async () => {
    const pozo = await tanque({ nivel_actual: 5000 });
    const antes = await nivelTeorico(pozo);
    const tqt = await tanquetaConSaldo(100);

    const r = await devolver(tqt, { cantidad: 30.5, tanque_id: pozo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    expect(await nivelTeorico(pozo)).toBe(antes + 30.5);
    expect(await saldoDe(tqt)).toBe(69.5);
    // Sin unidad, sin diferencia y sin motivo (es opcional): no es un ajuste.
    expect(await filas(tqt)).toEqual([
      expect.objectContaining({
        equipo_id: null,
        destino: "pozo",
        combustible_id: pozo,
        cantidad_pozo: 30.5,
        costo: 16,
        calculado: 30.5,
        validado: 30.5,
        diferencia: 0,
        motivo: null,
      }),
    ]);
  });

  it("devuelve todo lo que queda, con motivo, y la tanqueta queda en cero", async () => {
    const pozo = await tanque();
    const tqt = await tanquetaConSaldo(80);
    expect((await devolver(tqt, { cantidad: 50, tanque_id: pozo })).status).toBe(201);
    const r = await devolver(tqt, {
      cantidad: 30,
      tanque_id: pozo,
      motivo: "sobró del llenado del turno",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await saldoDe(tqt)).toBe(0);
    expect((await filas(tqt))[1]).toMatchObject({ motivo: "sobró del llenado del turno" });
  });

  it("acepta tres decimales y rechaza un cuarto, cero y más que el saldo", async () => {
    const pozo = await tanque();
    const tqt = await tanquetaConSaldo(100);
    expect((await devolver(tqt, { cantidad: 12.3456, tanque_id: pozo })).status).toBe(400);
    expect((await devolver(tqt, { cantidad: 0, tanque_id: pozo })).status).toBe(400);
    const demasiado = await devolver(tqt, { cantidad: 100.5, tanque_id: pozo });
    expect(demasiado.status).toBe(400);
    expect(JSON.stringify(demasiado.body)).toContain("solo tiene");
    expect((await devolver(tqt, { cantidad: 12.345, tanque_id: pozo })).status).toBe(201);
    expect(await saldoDe(tqt)).toBe(87.655);
    expect(await filas(tqt)).toHaveLength(1);
  });

  it("no entra si el tanque es de otra sede o no cabe: la tanqueta no cambia", async () => {
    const tqt = await tanquetaConSaldo(100);
    const deOtraSede = await tanque({ grifo: otroGrifo });
    const lleno = await tanque({ capacidad_total: 1000, nivel_actual: 990 });
    expect((await devolver(tqt, { cantidad: 10, tanque_id: deOtraSede })).status).toBe(400);
    const noCabe = await devolver(tqt, { cantidad: 50, tanque_id: lleno });
    expect(noCabe.status).toBe(400);
    expect(JSON.stringify(noCabe.body)).toContain("espacio");
    expect(await saldoDe(tqt)).toBe(100);
    expect(await filas(tqt)).toHaveLength(0);
  });

  it("una tanqueta que va con una unidad no entra por acá", async () => {
    const pozo = await tanque();
    const tqt = await tanquetaConSaldo(100);
    const unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${tqt}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: "DEA", n_vale: nVale++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const r = await devolver(tqt, { cantidad: 10, tanque_id: pozo });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("recibirla de vuelta");
    expect(await saldoDe(tqt)).toBe(100);
  });

  it("no cierra ninguna salida en el cuadre ni aparece como retorno de una unidad", async () => {
    const pozo = await tanque();
    const tqt = await tanquetaConSaldo(100);
    const antes = (await admin.get(`/api/erp/combustible/tanquetas/${tqt}/cuadre`)).body;
    expect((await devolver(tqt, { cantidad: 40, tanque_id: pozo })).status).toBe(201);
    const despues = (await admin.get(`/api/erp/combustible/tanquetas/${tqt}/cuadre`)).body;
    expect(despues).toEqual(antes);
    const historial: { tipo: string }[] = (
      await admin.get(`/api/erp/combustible/tanquetas/${tqt}/historial`)
    ).body;
    expect(historial.filter((m) => m.tipo === "retorno")).toHaveLength(0);
    expect(historial.filter((m) => m.tipo === "retorno_pozo")).toHaveLength(1);
  });

  it("la base no admite un retorno sin unidad que no sea al pozo", async () => {
    const tqt = await tanquetaConSaldo(100);
    await expect(
      withTenant(tenantId, (client) =>
        client.query(
          `INSERT INTO combustible_tanqueta_retornos
             (tenant_id, tanqueta_id, equipo_id, saldo_calculado, saldo_validado, destino)
           VALUES ($1, $2, NULL, 10, 10, 'reserva')`,
          [tenantId, tqt]
        )
      )
    ).rejects.toThrow(/tanqueta_retornos_equipo_check/);
  });
});
