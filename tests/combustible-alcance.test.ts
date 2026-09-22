/** tests/combustible-alcance.test.ts
 *
 * Alcance por usuario y reportes por sede (migración 0100, entregas 3 y 4 de
 * docs/architecture/combustible-sedes-grifos-surtidores.md).
 *
 * Método de siempre: atacar la API con un usuario de OTRO grifo, y cada ataque
 * con su GEMELO en el grifo propio. Si el gemelo también fallara, el "no pudo"
 * del ataque no probaría nada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { vaciarEventoDeCombustible } from "../src/modules/combustible/alcance";

const password = "ClaveDePrueba123";
let seq = 0;
const serieUnica = () => `A${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;
const ahora = () => new Date().toISOString();

type Agente = ReturnType<typeof request.agent>;

afterAll(async () => {
  await closeDatabase();
});

describe("combustible: alcance por usuario", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let sede: number;
  let grifoA: number;
  let grifoB: number;
  let tA: { id: number; surtidor: number };
  let tB: { id: number; surtidor: number };
  let eqA: number;
  let eqB: number;

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(88100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    const entro = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entro.status).toBe(200);
    const entrar = () =>
      agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return { agente, id: alta.body.id as string, entrar };
  }

  /** Achicar el alcance cierra las sesiones del usuario (como cualquier
   *  recorte de permisos): así un tiempo real abierto con el alcance viejo se
   *  corta. Por eso vuelve a entrar después. */
  async function asignar(p: { id: string; entrar: () => Promise<unknown> }, alcance: object) {
    const r = await admin.put(`/api/erp/usuarios/${p.id}/permisos`).send({
      modulos: [],
      alcanceCombustible: { todo: false, sedes: [], grifos: [], surtidores: [], ...alcance },
      motivo: "Asignar planta",
    });
    await p.entrar();
    return r;
  }

  async function tanque(grifo: number, extra: Record<string, unknown> = {}) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: grifo,
      ...extra,
    });
    expect(r.status).toBe(201);
    return { id: r.body.id as number, surtidor: r.body.surtidores[0].id as number };
  }

  const vale = (ag: Agente, tq: number, equipo: number, extra: Record<string, unknown> = {}) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
      despachado_en: ahora(),
      ...extra,
    });

  const varilla = (ag: Agente, tq: number) =>
    ag.post("/api/erp/combustible/lecturas").send({ combustible_id: tq, nivel: 9000 });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    sede = sedes[0].id;
    grifoA = sedes[0].grifos[0].id;
    grifoB = (
      await admin.post("/api/erp/administracion/grifos").send({ sede_id: sede, nombre: "B" })
    ).body.id;
    tA = await tanque(grifoA);
    tB = await tanque(grifoB);
    eqA = (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EA"), tipo: "Volquete", grifo_interno_id: grifoA })
    ).body.id;
    eqB = (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EB"), tipo: "Volquete", grifo_interno_id: grifoB })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("un operador del grifo A no ve, ni mide, ni despacha en el grifo B", async () => {
    const op = await persona("operador");
    expect((await asignar(op, { grifos: [grifoA] })).status).toBe(200);

    const lista = (await op.agente.get("/api/erp/combustible")).body as { id: number }[];
    expect(lista.map((t) => t.id)).toEqual([tA.id]);
    // Gemelo: el admin ve los dos.
    const todos = (await admin.get("/api/erp/combustible")).body as { id: number }[];
    expect(todos.map((t) => t.id)).toEqual(expect.arrayContaining([tA.id, tB.id]));

    expect((await op.agente.get(`/api/erp/combustible/${tB.id}`)).status).toBe(404);
    expect((await op.agente.get(`/api/erp/combustible/${tB.id}/lecturas`)).status).toBe(404);
    expect((await op.agente.get(`/api/erp/combustible/${tA.id}/lecturas`)).status).toBe(200);

    expect((await varilla(op.agente, tB.id)).status).toBe(400);
    expect((await varilla(op.agente, tA.id)).status).toBe(201);
    const ataque = await vale(op.agente, tB.id, eqB);
    expect(ataque.status).toBe(400);
    expect(ataque.body.error).toMatch(/no existe/);
    expect((await vale(op.agente, tA.id, eqA)).status).toBe(201);
  });

  it("los vales y los reportes solo muestran lo del alcance", async () => {
    const op = await persona("operador");
    await asignar(op, { grifos: [grifoA] });
    const deB = await vale(admin, tB.id, eqB);
    expect(deB.status).toBe(201);

    const lista = (await op.agente.get("/api/erp/combustible/despachos")).body.data as {
      id: number;
    }[];
    expect(lista.some((d) => Number(d.id) === Number(deB.body.id))).toBe(false);
    // Tampoco se puede anular un vale de B: para el operador no existe.
    const anular = await op.agente
      .patch(`/api/erp/combustible/despachos/${deB.body.id}/anular`)
      .send({ motivo: "x" });
    expect(anular.status).toBe(404);

    const rep = (await op.agente.get("/api/erp/combustible/consumo-por-vehiculo")).body.data as {
      equipo_id: number;
    }[];
    expect(rep.some((f) => f.equipo_id === eqB)).toBe(false);
  });

  it("con un solo surtidor ve el tanque y carga vales, pero no mide", async () => {
    const g = await persona("grifero");
    await asignar(g, { surtidores: [tB.surtidor] });

    const lista = (await g.agente.get("/api/erp/combustible")).body as { id: number }[];
    expect(lista.map((t) => t.id)).toEqual([tB.id]);
    expect((await vale(g.agente, tB.id, eqB)).status).toBe(201);
    expect((await varilla(g.agente, tB.id)).status).toBe(400);
    expect((await g.agente.get(`/api/erp/combustible/${tB.id}/lecturas`)).status).toBe(404);
    // Por otro surtidor del mismo tanque, no.
    const otro = (
      await admin
        .post("/api/erp/combustible/surtidores")
        .send({ grifo_interno_id: grifoB, nombre: idUnico("S2") })
    ).body.id;
    await admin
      .post(`/api/erp/combustible/surtidores/${otro}/conexiones`)
      .send({ combustible_id: tB.id, motivo: "Segundo surtidor" });
    expect((await vale(g.agente, tB.id, eqB, { surtidor_id: otro })).status).toBe(400);
    expect((await vale(g.agente, tB.id, eqB, { surtidor_id: tB.surtidor })).status).toBe(201);
  });

  it("una sede incluye los grifos que se creen después", async () => {
    const op = await persona("operador");
    await asignar(op, { sedes: [sede] });
    const nuevo = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sede, nombre: idUnico("C") })
    ).body.id;
    const tC = await tanque(nuevo);
    const lista = (await op.agente.get("/api/erp/combustible")).body as { id: number }[];
    expect(lista.map((t) => t.id)).toContain(tC.id);
  });

  it("un id de otra empresa en el alcance se rechaza con 400", async () => {
    const op = await persona("operador");
    const otra = await crearTenantDePrueba(password);
    try {
      const ag = request.agent(app);
      await ag
        .post("/api/auth/login")
        .send({ tenantSlug: otra.tenant.slug, email: otra.usuario.email, password });
      const ajeno = (await ag.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
      expect((await asignar(op, { grifos: [ajeno] })).status).toBe(400);
    } finally {
      await borrarTenantDePrueba(otra.tenant.id);
    }
  });

  it("con doble firma, ampliar el alcance queda pendiente; achicarlo sale ya", async () => {
    const op = await persona("operador");
    await asignar(op, { grifos: [grifoA] });
    // Encender la doble firma pide dos administradores activos.
    await persona("admin");
    const firma = await admin
      .put("/api/erp/administracion/doble-firma")
      .send({ dobleFirma: true, motivo: "Prueba" });
    expect(firma.status).toBe(200);
    try {
      // Achicar sale con una firma. Después, ampliar queda pendiente de la
      // segunda (y con una orden pendiente no se puede pedir otra: 409).
      const achicar = await asignar(op, { grifos: [] });
      expect(achicar.status).toBe(200);
      const ampliar = await asignar(op, { grifos: [grifoA, grifoB] });
      expect(ampliar.status).toBe(202);
    } finally {
      // Apagarla pide dos firmas: en esta empresa de prueba queda prendida,
      // y el afterAll la borra entera.
    }
  });

  it("el tiempo real le llega sin contenido a quien ve solo algunas plantas", () => {
    const evento = { id: "1", tipo: "combustible.lectura_registrada", payload: { nivel: 9000 } };
    expect(vaciarEventoDeCombustible(evento).payload).toEqual({});
    const otro = { id: "2", tipo: "equipos.creado", payload: { equipoId: 1 } };
    expect(vaciarEventoDeCombustible(otro).payload).toEqual({ equipoId: 1 });
  });
});

describe("combustible: reportes por sede (entrega 4)", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let grifoA: number;
  let grifoB: number;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    grifoA = sedes[0].grifos[0].id;
    grifoB = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: "Norte" })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  async function tanque(grifo: number, unidad: "L" | "gal") {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: `Tanque ${unidad}`,
      tipo_combustible: "diesel_b5",
      unidad,
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: grifo,
    });
    return r.body.id as number;
  }

  const equipo = async (grifo: number) =>
    (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EQ"), tipo: "Volquete", grifo_interno_id: grifo })
    ).body.id as number;

  const vale = (tq: number, eq: number, cantidad: number) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: eq,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: ahora(),
    });

  it("suma en litros y galones, y filtra por grifo", async () => {
    const enLitros = await tanque(grifoA, "L");
    const enGalones = await tanque(grifoB, "gal");
    const eqA = await equipo(grifoA);
    const eqB = await equipo(grifoB);
    expect((await vale(enLitros, eqA, 100)).status).toBe(201);
    expect((await vale(enGalones, eqB, 10)).status).toBe(201);

    type Fila = { equipo_id: number; total_litros: string; total_galones: string };
    const todo = (await admin.get("/api/erp/combustible/consumo-por-vehiculo")).body.data as Fila[];
    const deB = todo.find((f) => f.equipo_id === eqB)!;
    expect(Number(deB.total_litros)).toBeCloseTo(37.854, 2);
    expect(Number(deB.total_galones)).toBeCloseTo(10, 5);

    const soloA = (
      await admin
        .get("/api/erp/combustible/consumo-por-vehiculo")
        .query({ grifo_interno_id: grifoA })
    ).body.data as Fila[];
    expect(soloA.map((f) => f.equipo_id)).toEqual([eqA]);
  });

  it("el ranking por origen trae el grifo interno de cada fila", async () => {
    const r = (await admin.get("/api/erp/combustible/consumo-por-grifo")).body.data as {
      tipo_grifo: string;
      grifo_interno: string | null;
    }[];
    const internos = r.filter((f) => f.tipo_grifo === "interno").map((f) => f.grifo_interno);
    expect(internos).toEqual(expect.arrayContaining(["Principal", "Norte"]));
  });

  it("un vale a un equipo de otro grifo alerta; el gemelo del mismo grifo no", async () => {
    const tq = await tanque(grifoA, "L");
    const propio = await equipo(grifoA);
    const prestado = await equipo(grifoB);
    await vale(tq, propio, 50);
    await vale(tq, prestado, 50);
    const alertas = (await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 })).body
      .data as { tipo: string; combustible_id: number; detalle: Record<string, unknown> }[];
    const deEsteTanque = alertas.filter(
      (a) => a.tipo === "equipo_de_otro_grifo" && a.combustible_id === tq
    );
    expect(deEsteTanque).toHaveLength(1);
    expect(deEsteTanque[0].detalle).toMatchObject({
      grifoDelVale: "Principal",
      grifoDelEquipo: "Norte",
    });
  });
});
