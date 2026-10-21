/** tests/combustible-tanqueta-conductor.test.ts
 *
 * Lo que el conductor ve y puede cargar desde una tanqueta (migración 0139):
 * solo las asignadas a SU unidad (la más antigua primero), y el servidor
 * rechaza cualquier otra aunque el formulario no la muestre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: el conductor carga la tanqueta asignada a su unidad (0139)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const conductor = request.agent(app);
  let principal: number;
  let tanqueId: number;
  let suUnidad: number;
  let otraUnidad: number;
  let nVale = 1;
  let medidor = 1000;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    const slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const dni = String(88300000 + Math.floor(Math.random() * 400000));
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Conductor", dni, password, rol: "conductor_ruta" });
    expect(alta.status).toBe(201);
    await conductor
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    const equipo = async (conductorDni: string) =>
      (
        await admin.post("/api/erp/equipos").send({
          placa_codigo: idUnico("VQ"),
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
          grifo_interno_id: principal,
          conductor_nombre: "Alguien",
          conductor_dni: conductorDni,
        })
      ).body.id as number;
    suUnidad = await equipo(dni);
    otraUnidad = await equipo("40999999");
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

  async function tanquetaAsignada(equipoId: number, cantidad = 100) {
    const t = await admin
      .post("/api/erp/combustible/tanquetas")
      .send({ grifo_interno_id: principal });
    const id = Number(t.body.id);
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "HMC",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${id}/asignar`)
      .send({ equipo_id: equipoId });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return id;
  }

  const cargar = (tanquetaId: number, equipoId: number, extra: Record<string, unknown> = {}) =>
    conductor.post("/api/erp/combustible/despachos").send({
      origen: "tanqueta",
      tanqueta_origen_id: tanquetaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      cantidad: 10,
      lectura_horometro: medidor++,
      ...extra,
    });

  const delFormulario = async () =>
    (await conductor.get("/api/erp/combustible/tanquetas/formulario")).body as {
      id: number;
      equipo_asignado_id: number;
    }[];

  it("el formulario solo trae las de su unidad, la más antigua primero", async () => {
    const ajena = await tanquetaAsignada(otraUnidad);
    const primera = await tanquetaAsignada(suUnidad);
    const segunda = await tanquetaAsignada(suUnidad);
    const lista = await delFormulario();
    expect(lista.map((t) => t.id)).toEqual([primera, segunda]);
    expect(lista.some((t) => t.id === ajena)).toBe(false);
    expect(lista[0].equipo_asignado_id).toBe(suUnidad);
  });

  it("carga la activa, no la segunda ni la de otra unidad ni una sin asignar", async () => {
    const [primera, segunda] = (await delFormulario()).map((t) => t.id);
    const r = await cargar(segunda, suUnidad);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Carga primero/);
    const sinAsignar = Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );
    expect((await cargar(sinAsignar, suUnidad)).status).toBe(400);
    expect((await cargar(primera, otraUnidad)).status).toBe(403);
    const ok = await cargar(primera, suUnidad);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("no carga en planta aunque lo mande", async () => {
    const [activa] = await delFormulario();
    const r = await cargar(activa.id, suUnidad, {
      tanqueta_lugar: "planta",
      serie_talonario: "HMC",
      n_vale: nVale++,
    });
    expect(r.status).toBe(403);
  });

  it("sin tanquetas asignadas el formulario viene vacío", async () => {
    const libres = await delFormulario();
    for (const t of libres) {
      await admin
        .put(`/api/erp/combustible/tanquetas/${t.id}/liberar`)
        .send({ motivo: "prueba sin tanquetas" });
    }
    expect(await delFormulario()).toEqual([]);
  });
});
