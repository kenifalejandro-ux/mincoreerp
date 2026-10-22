/** tests/combustible-tanqueta-asignar-vale.test.ts
 *
 * Asignar una tanqueta a una unidad desde la pestaña Tanquetas pide el vale de
 * esa salida (migración 0141): es obligatorio, queda en el historial y no se
 * puede repetir contra un despacho ni contra otra asignación.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: asignar la tanqueta con su vale (0141)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let principal: number;
  let tanqueId: number;
  let unidadA: number;
  let unidadB: number;
  let nVale = 1;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
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
    unidadA = await equipo();
    unidadB = await equipo();
    tanqueId = (
      await admin.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Huamachuco",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 10000,
        nivel_actual: 8000,
        requiere_documento: false,
        grifo_interno_id: principal,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const tanquetaConSaldo = async () => {
    const id = Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "HMC",
      n_vale: nVale++,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    return id;
  };

  const asignar = (id: number, equipo: number, vale: Record<string, unknown>) =>
    admin.put(`/api/erp/combustible/tanquetas/${id}/asignar`).send({ equipo_id: equipo, ...vale });
  const ver = async (id: number) =>
    (await admin.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === id
    );

  it("sin serie o sin n° de vale no asigna", async () => {
    const tq = await tanquetaConSaldo();
    expect((await asignar(tq, unidadA, {})).status).toBe(400);
    expect((await asignar(tq, unidadA, { serie_talonario: "ASG" })).status).toBe(400);
    expect((await asignar(tq, unidadA, { n_vale: 700 })).status).toBe(400);
    expect((await ver(tq)).equipo_asignado_id).toBeNull();
  });

  it("con vale asigna; para pasarla a otra unidad se libera primero y se asigna con otro vale", async () => {
    const tq = await tanquetaConSaldo();
    const r = await asignar(tq, unidadA, { serie_talonario: "ASG", n_vale: 710 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await ver(tq)).equipo_asignado_id).toBe(unidadA);
    expect((await asignar(tq, unidadB, { serie_talonario: "ASG", n_vale: 711 })).status).toBe(409);
    await admin
      .put(`/api/erp/combustible/tanquetas/${tq}/liberar`)
      .send({ motivo: "cambia de unidad" });
    const otra = await asignar(tq, unidadB, { serie_talonario: "ASG", n_vale: 711 });
    expect(otra.status).toBe(200);
    expect((await ver(tq)).equipo_asignado_id).toBe(unidadB);
  });

  it("un vale usado en otra asignación no se repite, aunque la tanqueta ya haya pasado a otra unidad", async () => {
    const a = await tanquetaConSaldo();
    expect((await asignar(a, unidadA, { serie_talonario: "ASG", n_vale: 720 })).status).toBe(200);
    await admin
      .put(`/api/erp/combustible/tanquetas/${a}/liberar`)
      .send({ motivo: "cambia de unidad" });
    expect((await asignar(a, unidadB, { serie_talonario: "ASG", n_vale: 721 })).status).toBe(200);
    const b = await tanquetaConSaldo();
    const repetido = await asignar(b, unidadA, { serie_talonario: "ASG", n_vale: 720 });
    expect(repetido.status, JSON.stringify(repetido.body)).toBe(409);
    expect(repetido.body.error ?? repetido.body.message).toMatch(/ya está registrado/);
    expect((await ver(b)).equipo_asignado_id).toBeNull();
  });

  it("un vale ya usado en un despacho tampoco se puede usar para asignar", async () => {
    const tq = await tanquetaConSaldo();
    // HMC-<n> lo usó el vale que la llenó (el último nVale usado).
    const r = await asignar(tq, unidadA, { serie_talonario: "HMC", n_vale: nVale - 1 });
    expect(r.status).toBe(409);
  });

  it("el vale de la asignación tampoco lo puede usar un despacho", async () => {
    const tq = await tanquetaConSaldo();
    expect((await asignar(tq, unidadA, { serie_talonario: "ASG", n_vale: 730 })).status).toBe(200);
    const otra = await tanquetaConSaldo();
    const r = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: otra,
      serie_talonario: "ASG",
      n_vale: 730,
      cantidad: 10,
      lectura_contometro: 10,
      costo_unitario: 16,
    });
    expect(r.status).toBe(409);
  });

  it("liberar sigue sin pedir vale", async () => {
    const tq = await tanquetaConSaldo();
    await asignar(tq, unidadA, { serie_talonario: "ASG", n_vale: 740 });
    const r = await admin
      .put(`/api/erp/combustible/tanquetas/${tq}/liberar`)
      .send({ motivo: "volvió al grifo" });
    expect(r.status).toBe(200);
  });
  it("la asignación guarda la cantidad que la tanqueta llevaba al salir (0142)", async () => {
    const tq = await tanquetaConSaldo();
    const r = await asignar(tq, unidadA, { serie_talonario: "CNT", n_vale: 720 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cantidad = await withTenant(tenantId, async (client) => {
      const q = await client.query(
        `SELECT cantidad FROM combustible_tanqueta_asignaciones
          WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tenantId, tq]
      );
      return Number(q.rows[0].cantidad);
    });
    expect(cantidad).toBe(100);
  });
});
