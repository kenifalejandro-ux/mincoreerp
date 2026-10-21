/** tests/combustible-tanqueta-asignacion.test.ts
 *
 * La tanqueta se asigna a la unidad que la lleva (migración 0139): una unidad
 * lleva hasta 3, una tanqueta va con una sola unidad, la asignación deja de
 * contar sola al vaciarse y un nuevo llenado la limpia.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

describe("combustible: tanqueta asignada a una unidad (0139)", () => {
  let tenantId: string;
  let otroTenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let conductor: Agente;
  let grifero: Agente;
  let principal: number;
  let tanqueId: number;
  let volquete: number;
  let cisterna: number;
  let equipoAjeno: number;
  let dniConductor = "";
  let seq = 0;
  let nVale = 1;

  async function conRol(rol: string): Promise<Agente> {
    const agente = request.agent(app);
    const dni = String(88100000 + Math.floor(Math.random() * 400000) + seq++);
    if (rol === "conductor_ruta") dniConductor = dni;
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return agente;
  }

  const crearEquipo = async (ag: Agente, grifo: number, dni = "40000001") =>
    (
      await ag.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: grifo,
        conductor_nombre: "Juan Pérez",
        conductor_dni: dni,
      })
    ).body.id as number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    volquete = await crearEquipo(admin, principal);
    cisterna = await crearEquipo(admin, principal);
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
    conductor = await conRol("conductor_ruta");
    grifero = await conRol("grifero");

    // Otra empresa: su unidad no se puede asignar desde esta.
    const otro = await crearTenantDePrueba(password);
    otroTenantId = otro.tenant.id;
    const ajeno = request.agent(app);
    await ajeno
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    const grifoAjeno = (await ajeno.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    equipoAjeno = await crearEquipo(ajeno, grifoAjeno);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(otroTenantId);
    await closeDatabase();
  });

  async function tanquetaConSaldo(cantidad = 100) {
    const t = await admin
      .post("/api/erp/combustible/tanquetas")
      .send({ grifo_interno_id: principal });
    expect(t.status).toBe(201);
    const id = Number(t.body.id);
    if (cantidad > 0) {
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
    }
    return id;
  }

  const asignar = (id: number, equipo_id: number, ag: Agente = admin) =>
    ag.put(`/api/erp/combustible/tanquetas/${id}/asignar`).send({ equipo_id });
  const liberar = (id: number, motivo?: string) =>
    admin.put(`/api/erp/combustible/tanquetas/${id}/liberar`).send(motivo ? { motivo } : {});
  const ver = async (id: number) =>
    (await admin.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === id
    );

  it("asigna una tanqueta con saldo y el listado dice a qué unidad va", async () => {
    const tq = await tanquetaConSaldo();
    const r = await asignar(tq, volquete);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.equipo_asignado_id).toBe(volquete);
    const fila = await ver(tq);
    expect(fila.asignada_vigente).toBe(true);
    expect(fila.equipo_asignado).toBeTruthy();
  });

  it("no asigna una tanqueta vacía, una unidad inexistente ni una de otra empresa", async () => {
    const vacia = await tanquetaConSaldo(0);
    expect((await asignar(vacia, volquete)).status).toBe(400);
    const tq = await tanquetaConSaldo();
    expect((await asignar(tq, 999999999)).status).toBe(400);
    expect((await asignar(tq, equipoAjeno)).status).toBe(400);
    expect((await asignar(999999999, volquete)).status).toBe(404);
  });

  it("una unidad lleva hasta 3: la cuarta se rechaza y reasignar la misma no cuenta", async () => {
    const unidad = await crearEquipo(admin, principal);
    const [a, b, c, d] = [
      await tanquetaConSaldo(),
      await tanquetaConSaldo(),
      await tanquetaConSaldo(),
      await tanquetaConSaldo(),
    ];
    for (const t of [a, b, c]) expect((await asignar(t, unidad)).status).toBe(200);
    const cuarta = await asignar(d, unidad);
    expect(cuarta.status).toBe(400);
    expect(cuarta.body.error ?? cuarta.body.message).toMatch(/3 tanquetas/);
    // Volver a asignar una de las tres no es una cuarta.
    expect((await asignar(a, unidad)).status).toBe(200);
  });

  it("reasignar pasa la tanqueta a otra unidad sin liberarla antes", async () => {
    const tq = await tanquetaConSaldo();
    await asignar(tq, volquete);
    const r = await asignar(tq, cisterna);
    expect(r.status).toBe(200);
    expect((await ver(tq)).equipo_asignado_id).toBe(cisterna);
  });

  it("al vaciarse deja de contar para el tope y un llenado nuevo la limpia", async () => {
    const unidad = await crearEquipo(admin, principal, dniConductor);
    const tq = await tanquetaConSaldo(100);
    await asignar(tq, unidad);
    expect((await ver(tq)).asignada_vigente).toBe(true);

    // El conductor carga todo el saldo en la unidad: la tanqueta queda en 0.
    const carga = await conductor.post("/api/erp/combustible/despachos").send({
      origen: "tanqueta",
      tanqueta_origen_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: unidad,
      cantidad: 100,
      lectura_horometro: 5000,
    });
    expect(carga.status, JSON.stringify(carga.body)).toBe(201);
    const vacia = await ver(tq);
    expect(Number(vacia.saldo)).toBe(0);
    expect(vacia.asignada_vigente).toBe(false);

    // Volver a llenarla desde el tanque, sin asignar, no revive la unidad vieja.
    const v = await grifero.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tq,
      serie_talonario: "HMC",
      n_vale: nVale++,
      cantidad: 50,
      lectura_contometro: 50,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const llena = await ver(tq);
    expect(llena.equipo_asignado_id).toBeNull();
    expect(llena.asignada_vigente).toBe(false);
  });

  it("liberar pide motivo y solo sirve si estaba asignada", async () => {
    const tq = await tanquetaConSaldo();
    await asignar(tq, volquete);
    expect((await liberar(tq)).status).toBe(400);
    const r = await liberar(tq, "Volvió al grifo con saldo");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.equipo_asignado_id).toBeNull();
    expect((await liberar(tq, "Otra vez")).status).toBe(400);
  });

  it("el conductor y el grifero no asignan ni liberan", async () => {
    const tq = await tanquetaConSaldo();
    expect((await asignar(tq, volquete, conductor)).status).toBe(403);
    expect((await asignar(tq, volquete, grifero)).status).toBe(403);
    await asignar(tq, volquete);
    const r = await conductor
      .put(`/api/erp/combustible/tanquetas/${tq}/liberar`)
      .send({ motivo: "Prueba" });
    expect(r.status).toBe(403);
  });
});
