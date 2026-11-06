/** tests/combustible-cisterna-al-tanque.test.ts
 *
 * Pasar lo que quedó en la cisterna a un tanque (0169). Es una ENTRADA del
 * tanque que NO es una compra, igual que el retorno al pozo (0145): suma al
 * nivel, al kardex y al costo promedio, pero no abre ciclo ni cuenta como una
 * entrega más en la diferencia de una recepción.
 *
 * Lo que cuesta caro si falla: un pase que se contara como recepción se vería
 * como un sobrante de la recepción real, o reiniciaría la calibración.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { CombustibleRepository } from "../src/modules/combustible/combustible.repository";

type Agente = ReturnType<typeof request.agent>;

interface Cisterna {
  id: string;
  saldo: string;
  recepcion_id: string;
  tanque_codigo: string;
}

describe("combustible: de la cisterna al tanque es una entrada del tanque (0169)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const repo = new CombustibleRepository();
  let tenantId: string;
  let slug: string;
  let proveedor: number;
  let principal: number;
  let unidad: number;
  let seq = 0;
  let nVale = 3000;

  async function conRol(rol: string): Promise<Agente> {
    const agente = request.agent(app);
    const dni = String(88400000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return agente;
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    proveedor = (
      await admin
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("Prov"), abastece_tanque: true })
    ).body.id;
    unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  /** Un tanque en galones con su varilla de base de hace 50 días. */
  async function tanque(
    opciones: {
      nivel?: number;
      capacidad?: number;
      tipo?: string;
      unidad?: string;
      flexible?: boolean;
    } = {}
  ) {
    const nivel = opciones.nivel ?? 1000;
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de prueba",
      tipo_combustible: opciones.tipo ?? "diesel_b5",
      unidad: opciones.unidad ?? "gal",
      tipo_punto: "fijo",
      capacidad_total: opciones.capacidad ?? 10000,
      nivel_actual: nivel,
      nivel_minimo: 100,
      modo_vigilancia: "sin_vigilar",
      ...(opciones.flexible ? { modo_excedente_recepcion: "flexible" } : {}),
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as number;
    const base = await admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: id, nivel, leido_en: hace(50) });
    expect(base.status).toBe(201);
    return id;
  }

  const leer = async (tq: number, nivel: number, cuando: string) => {
    const r = await admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel, leido_en: cuando });
    expect(r.status).toBe(201);
    return Number(r.body.lectura.id);
  };

  const recibir = (tq: number, cantidad: number, costo: number, cuando: string) =>
    admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: costo,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: cuando,
    });

  const listar = async (ag: Agente = admin): Promise<Cisterna[]> =>
    (await ag.get("/api/erp/combustible/despachos/cisternas-con-saldo")).body;

  /** Un tanque LLENO y flexible, y una recepción que se queda entera en la
   *  cisterna, a 16.5 el galón. */
  async function cisterna(cantidad = 500) {
    const lleno = await tanque({ nivel: 2000, capacidad: 2000, flexible: true });
    const rec = await admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: lleno,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: 16.5,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "cisterna", cantidad }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const linea = (await listar()).find((c) => Number(c.recepcion_id) === Number(rec.body.id));
    expect(linea).toBeDefined();
    return { lineaId: Number(linea!.id), recepcionId: rec.body.id as number };
  }

  const pasar = (
    ag: Agente,
    lineaId: number,
    tq: number,
    cantidad: number,
    extra: Record<string, unknown> = {}
  ) =>
    ag.post("/api/erp/combustible/despachos/cisterna-al-tanque").send({
      linea_id: lineaId,
      combustible_id: tq,
      cantidad,
      cliente_uuid: randomUUID(),
      ...extra,
    });

  const saldoDe = async (lineaId: number) =>
    Number((await listar()).find((c) => Number(c.id) === lineaId)?.saldo ?? 0);

  const nivelTeorico = async (id: number) =>
    Number((await admin.get(`/api/erp/combustible/${id}`)).body.nivel_teorico);

  it("el pase suma al nivel del tanque y baja el saldo de la cisterna", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    const antes = await nivelTeorico(tq);

    const r = await pasar(admin, lineaId, tq, 200);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number(r.body.costo_unitario)).toBe(16.5);

    expect(await nivelTeorico(tq)).toBe(antes + 200);
    expect(await saldoDe(lineaId)).toBe(300);
  });

  it("el kardex lo muestra como una entrada", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    expect((await pasar(admin, lineaId, tq, 150)).status).toBe(201);
    const res = await admin
      .get(`/api/erp/combustible/${tq}/kardex`)
      .query({ desde: hace(45), hasta: new Date(Date.now() + 60_000).toISOString() });
    expect(res.status).toBe(200);
    const fila = res.body.filas.find((f: { tipo: string }) => f.tipo === "cisterna_al_tanque");
    expect(fila).toBeTruthy();
    expect(fila.entrada).toBe(150);
    expect(fila.anulada).toBe(false);
  });

  it("el costo promedio del tanque incluye el costo de la factura de la cisterna", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    expect((await recibir(tq, 1000, 10, hace(10))).status).toBe(201);
    const antes = Number((await admin.get(`/api/erp/combustible/${tq}`)).body.costo_promedio);
    expect((await pasar(admin, lineaId, tq, 500)).status).toBe(201);
    const despues = Number((await admin.get(`/api/erp/combustible/${tq}`)).body.costo_promedio);
    // 16.5 es más caro que lo que ya había: el promedio sube.
    expect(despues).toBeGreaterThan(antes);
  });

  it("la diferencia de una recepción no se ensucia con lo que pasó de la cisterna", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    expect((await recibir(tq, 200, 10, hace(10))).status).toBe(201);
    const pase = await pasar(admin, lineaId, tq, 50);
    expect(pase.status).toBe(201);
    // La varilla del alta se estampa con "ahora": para que el pase caiga entre la
    // recepción y la lectura que la mide, se lo pone en el pasado (como el test del
    // retorno al pozo).
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE combustible_cisterna_traslados SET creado_en = $2::timestamptz WHERE id = $1`,
        [pase.body.id, hace(9)]
      )
    );
    // 1.000 + 200 recibidos + 50 pasados desde la cisterna: la varilla cierra exacto.
    await leer(tq, 1250, hace(8));
    const lista = await admin.get("/api/erp/combustible/recepciones").query({ combustible_id: tq });
    expect(lista.status).toBe(200);
    expect(lista.body.data).toHaveLength(1);
    expect(Number(lista.body.data[0].diferencia_litros)).toBe(0);
  });

  it("no cuenta como recepción: no abre ciclo de calibración ni aparece en el historial", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    expect((await recibir(tq, 500, 10, hace(20))).status).toBe(201);
    await leer(tq, 1500, hace(19));
    expect((await pasar(admin, lineaId, tq, 300)).status).toBe(201);
    const cuando = new Date(Date.now() + 5_000).toISOString();
    const lectura = await leer(tq, 1800, cuando);
    const c = await withTenant(tenantId, (client) =>
      repo.findSaldoCiclo(client, tenantId, tq, lectura, cuando)
    );
    // 300 gal es más del 1 % de la capacidad: si abriera ciclo, el inicio se mudaría.
    expect(Number(c!.nivel_inicio)).toBe(1500);
    expect(Number(c!.recepciones)).toBe(300);
    const hist = await admin.get("/api/erp/combustible/recepciones").query({ combustible_id: tq });
    expect(hist.body.data).toHaveLength(1);
  });

  it("no pasa más de lo que queda, ni sumando salidas y pases", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    const demas = await pasar(admin, lineaId, tq, 500.5);
    expect(demas.status).toBe(400);
    expect(demas.body.error).toContain("quedan 500");
    // Un número absurdo es un 400, no un 500.
    expect((await pasar(admin, lineaId, tq, 1e20)).status).toBe(400);

    const salida = await admin.post("/api/erp/combustible/despachos").send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: unidad,
      serie_talonario: "CT",
      n_vale: nVale++,
      cantidad: 300,
      lectura_horometro: 100,
      costo_unitario: 1,
    });
    expect(salida.status, JSON.stringify(salida.body)).toBe(201);
    expect((await pasar(admin, lineaId, tq, 300)).status).toBe(400);
    expect((await pasar(admin, lineaId, tq, 200)).status).toBe(201);
    expect((await listar()).some((c) => Number(c.id) === lineaId)).toBe(false);
  });

  it("el tanque tiene que tener espacio, ser del mismo producto y de la misma unidad", async () => {
    const { lineaId } = await cisterna(500);
    const casi = await tanque({ nivel: 900, capacidad: 1000 });
    const sinEspacio = await pasar(admin, lineaId, casi, 200);
    expect(sinEspacio.status).toBe(400);
    expect(sinEspacio.body.error).toContain("solo tiene espacio");
    expect((await pasar(admin, lineaId, casi, 100)).status).toBe(201);

    const gasolina = await tanque({ tipo: "gasolina_90" });
    const mezcla = await pasar(admin, lineaId, gasolina, 50);
    expect(mezcla.status).toBe(400);
    expect(mezcla.body.error).toContain("mezclar");

    const litros = await tanque({ unidad: "L", capacidad: 40000, nivel: 4000 });
    const unidades = await pasar(admin, lineaId, litros, 50);
    expect(unidades.status).toBe(400);
    expect(unidades.body.error).toContain("misma unidad");
    expect(await saldoDe(lineaId)).toBe(400);
  });

  it("dos pases a la vez no se llevan más de lo que queda en la cisterna", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    const [a, b] = await Promise.all([
      pasar(admin, lineaId, tq, 300),
      pasar(admin, lineaId, tq, 300),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect(await saldoDe(lineaId)).toBe(200);
  });

  it("dos pases a la vez no se reparten el mismo espacio libre del tanque", async () => {
    const { lineaId } = await cisterna(500);
    const { lineaId: otra } = await cisterna(500);
    const tq = await tanque({ nivel: 900, capacidad: 1000 });
    const [a, b] = await Promise.all([pasar(admin, lineaId, tq, 80), pasar(admin, otra, tq, 80)]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
  });

  it("un reintento con el mismo cliente_uuid no duplica; con otro contenido, 409", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    const uuid = randomUUID();
    const a = await pasar(admin, lineaId, tq, 100, { cliente_uuid: uuid });
    expect(a.status).toBe(201);
    const b = await pasar(admin, lineaId, tq, 100, { cliente_uuid: uuid });
    expect(b.status).toBe(200);
    expect(await saldoDe(lineaId)).toBe(400);
    const c = await pasar(admin, lineaId, tq, 120, { cliente_uuid: uuid });
    expect(c.status).toBe(409);
    expect(await saldoDe(lineaId)).toBe(400);
  });

  it("anular la recepción con un pase hecho se bloquea", async () => {
    const { lineaId, recepcionId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    expect((await pasar(admin, lineaId, tq, 100)).status).toBe(201);
    const bloqueada = await admin
      .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
      .send({ motivo: "error" });
    expect(bloqueada.status).toBe(409);
  });

  it("el grifero puede; el conductor de ruta y Lectura no", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    expect((await pasar(await conRol("conductor_ruta"), lineaId, tq, 50)).status).toBe(403);
    expect((await pasar(await conRol("lectura"), lineaId, tq, 50)).status).toBe(403);
    const r = await pasar(await conRol("grifero"), lineaId, tq, 50);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("la cantidad va en milésimas: 0.0004, 0.0001 o 10.0005 son 400, no 500 ni un redondeo callado", async () => {
    const { lineaId } = await cisterna(500);
    const tq = await tanque({ nivel: 1000 });
    for (const cantidad of [0.0004, 0.0001, 10.0005]) {
      const r = await pasar(admin, lineaId, tq, cantidad);
      expect(r.status, `cantidad ${cantidad}: ${JSON.stringify(r.body)}`).toBe(400);
    }
    // Nada se guardó, y una cantidad en milésimas (con el error típico de coma flotante) pasa.
    expect(await saldoDe(lineaId)).toBe(500);
    expect((await pasar(admin, lineaId, tq, 0.007)).status).toBe(201);
    expect((await pasar(admin, lineaId, tq, 10.001)).status).toBe(201);
    expect(await saldoDe(lineaId)).toBe(489.992);
  });

  it("un tanque o una línea que no existen son 400, no 500", async () => {
    const { lineaId } = await cisterna(500);
    expect((await pasar(admin, lineaId, 2147483000, 10)).status).toBe(400);
    const tq = await tanque({ nivel: 1000 });
    expect((await pasar(admin, 999999999, tq, 10)).status).toBe(400);
  });
});
