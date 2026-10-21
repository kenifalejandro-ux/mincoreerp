/** tests/combustible-tanqueta-asignar-al-llenar.test.ts
 *
 * El vale del tanque a "reserva en cubeta" puede decir para qué unidad va la
 * tanqueta (migración 0139): llenarla y asignarla es un solo paso, y si la
 * unidad ya lleva 3 el vale entero se rechaza.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: asignar la tanqueta al llenarla desde el tanque (0139)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const grifero = request.agent(app);
  let principal: number;
  let tanqueId: number;
  let unidad: number;
  let nVale = 1;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    const slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const dni = String(88400000 + Math.floor(Math.random() * 400000));
    await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Grifero", dni, password, rol: "grifero" });
    await grifero.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
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

  const nuevaTanqueta = async () =>
    Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );

  const llenar = (ag: ReturnType<typeof request.agent>, tanquetaId: number, extra = {}) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tanquetaId,
      serie_talonario: "HMC",
      n_vale: nVale++,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
      ...extra,
    });

  const ver = async (id: number) =>
    (await admin.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === id
    );

  it("el vale llena la tanqueta y la deja asignada a la unidad, también el grifero", async () => {
    const a = await nuevaTanqueta();
    const r = await llenar(admin, a, { tanqueta_equipo_id: unidad });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const fila = await ver(a);
    expect(Number(fila.saldo)).toBe(100);
    expect(fila.equipo_asignado_id).toBe(unidad);
    expect(fila.asignada_vigente).toBe(true);

    const b = await nuevaTanqueta();
    expect((await llenar(grifero, b, { tanqueta_equipo_id: unidad })).status).toBe(201);
    expect((await ver(b)).equipo_asignado_id).toBe(unidad);
  });

  it("sin unidad, la tanqueta se llena y queda sin asignar", async () => {
    const a = await nuevaTanqueta();
    expect((await llenar(admin, a)).status).toBe(201);
    expect((await ver(a)).equipo_asignado_id).toBeNull();
  });

  it("si la unidad ya lleva 3, el vale entero se rechaza y la tanqueta no se llena", async () => {
    // La unidad ya tiene 2 de los tests anteriores: una más llega a 3, la siguiente no.
    expect(
      (await llenar(admin, await nuevaTanqueta(), { tanqueta_equipo_id: unidad })).status
    ).toBe(201);
    const cuarta = await nuevaTanqueta();
    const r = await llenar(admin, cuarta, { tanqueta_equipo_id: unidad });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/3 tanquetas/);
    expect(Number((await ver(cuarta)).saldo)).toBe(0);
  });

  it("decir la unidad sin que el vale llene una tanqueta es un error", async () => {
    const r = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: unidad,
      tanqueta_equipo_id: unidad,
      serie_talonario: "HMC",
      n_vale: nVale++,
      cantidad: 10,
      lectura_contometro: 10,
      costo_unitario: 16,
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("tanqueta_equipo_id");
  });
});
