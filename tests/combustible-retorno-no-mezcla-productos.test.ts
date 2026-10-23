/** tests/combustible-retorno-no-mezcla-productos.test.ts
 *
 * El saldo de una tanqueta no se mezcla con otro producto: no vuelve a un tanque
 * de otro tipo de combustible ni pasa a una tanqueta que lleva otro (auditoría de
 * #316-#321, hallazgo 5: el saldo de un tanque diésel volvía a uno de gasolina y la
 * API respondía 201). La tanqueta no guarda su tipo; se deduce de lo que le entró.
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

describe("combustible: el saldo de una tanqueta no se mezcla con otro producto", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let principal: number;
  let dieselFuente: number;
  let gasolinaFuente: number;
  let pozoDiesel: number;
  let pozoGasolina: number;
  let nVale = 1;
  let nAsig = 1;

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    dieselFuente = await tanque("diesel_b5", 50000, 40000);
    gasolinaFuente = await tanque("gasolina_90", 50000, 20000);
    pozoDiesel = await tanque("diesel_b5", 100000, 5000);
    pozoGasolina = await tanque("gasolina_90", 100000, 5000);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(tipo: string, capacidad: number, nivel: number) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: `Tanque ${tipo}`,
      tipo_combustible: tipo,
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as number;
    const base = await admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: id, nivel, leido_en: hace(50) });
    expect(base.status, JSON.stringify(base.body)).toBe(201);
    return id;
  }

  const nuevaTanqueta = async () =>
    Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );

  /** Le entran `cantidad` gal de `tipo`, desde la fuente de ese tipo. */
  async function llenar(tqt: number, tipo: "diesel_b5" | "gasolina_90", cantidad: number) {
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tipo === "diesel_b5" ? dieselFuente : gasolinaFuente,
      tipo_combustible: tipo,
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tqt,
      serie_talonario: "MEZ",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
  }

  async function asignar(tqt: number) {
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
      .send({ equipo_id: unidad, serie_talonario: "MEA", n_vale: nAsig++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
  }

  /** Una tanqueta con `cantidad` gal de `tipo`, ya asignada a una unidad. */
  async function tanquetaAsignada(tipo: "diesel_b5" | "gasolina_90", cantidad = 100) {
    const id = await nuevaTanqueta();
    await llenar(id, tipo, cantidad);
    await asignar(id);
    return id;
  }

  const nRetornos = (tqt: number) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM combustible_tanqueta_retornos
          WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tenantId, tqt]
      );
      return r.rows[0].n as number;
    });

  it("el saldo de diésel no vuelve a un tanque de gasolina, y sí a uno de diésel", async () => {
    const t = await tanquetaAsignada("diesel_b5");
    const mal = await recibirTanqueta(admin, t, { destino: "pozo", tanqueId: pozoGasolina });
    expect(mal.status).toBe(400);
    expect(mal.body.message).toContain("no se pueden mezclar");
    expect(mal.body.message).toContain("diésel B5");
    expect(mal.body.message).toContain("gasolina 90");
    expect(await nRetornos(t)).toBe(0);
    const bien = await recibirTanqueta(admin, t, { destino: "pozo", tanqueId: pozoDiesel });
    expect(bien.status, JSON.stringify(bien.body)).toBe(201);
  });

  it("el saldo no pasa a una tanqueta que lleva otro producto, y sí a una vacía", async () => {
    const t = await tanquetaAsignada("diesel_b5");
    const deGasolina = await nuevaTanqueta();
    await llenar(deGasolina, "gasolina_90", 50);
    const mal = await recibirTanqueta(admin, t, {
      destino: "tanqueta",
      tanquetaDestinoId: deGasolina,
    });
    expect(mal.status).toBe(400);
    expect(mal.body.message).toContain("no se pueden mezclar");
    expect(await nRetornos(t)).toBe(0);
    const vacia = await nuevaTanqueta();
    const bien = await recibirTanqueta(admin, t, { destino: "tanqueta", tanquetaDestinoId: vacia });
    expect(bien.status, JSON.stringify(bien.body)).toBe(201);
  });

  it("lo que una tanqueta recibió de otra cuenta: el diésel pasado no vuelve a un tanque de gasolina", async () => {
    const a = await tanquetaAsignada("diesel_b5");
    const b = await nuevaTanqueta();
    expect(
      (await recibirTanqueta(admin, a, { destino: "tanqueta", tanquetaDestinoId: b })).status
    ).toBe(201);
    await asignar(b);
    const mal = await recibirTanqueta(admin, b, { destino: "pozo", tanqueId: pozoGasolina });
    expect(mal.status).toBe(400);
    expect(mal.body.message).toContain("no se pueden mezclar");
    const bien = await recibirTanqueta(admin, b, { destino: "pozo", tanqueId: pozoDiesel });
    expect(bien.status, JSON.stringify(bien.body)).toBe(201);
  });

  it("una tanqueta que quedó mezclada no puede devolver su saldo a ningún tanque", async () => {
    const t = await tanquetaAsignada("diesel_b5", 50);
    await llenar(t, "gasolina_90", 50);
    for (const pozo of [pozoDiesel, pozoGasolina]) {
      const r = await recibirTanqueta(admin, t, { destino: "pozo", tanqueId: pozo });
      expect(r.status).toBe(400);
      expect(r.body.message).toContain("no se pueden mezclar");
    }
    expect(await nRetornos(t)).toBe(0);
  });
});
