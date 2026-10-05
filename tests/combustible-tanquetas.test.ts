/** tests/combustible-tanquetas.test.ts
 *
 * Tanquetas / cubetas (migración 0111): el registro con código, el tope de
 * capacidad que impone el servidor al repartir un excedente, la sede, y el
 * saldo derivado (entradas de recepciones vigentes).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

describe("combustible: tanquetas con código y reparto con tope (0111)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let grifoProveedor: number;
  let principal: number;
  let otroGrifo: number;
  let seq = 0;

  async function conRol(rol: string): Promise<Agente> {
    const agente = request.agent(app);
    const dni = String(87100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return agente;
  }

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    grifoProveedor = (
      await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("CISTERNA") })
    ).body.id;
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    principal = sedes[0].grifos[0].id;
    const otro = await admin
      .post("/api/erp/administracion/grifos")
      .send({ sede_id: sedes[0].id, nombre: idUnico("Grifo") });
    otroGrifo = otro.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const nuevaTanqueta = (extra: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal, ...extra });

  /** Tanque lleno (2000/2000) y flexible: toda recepción es excedente. */
  async function tanqueLleno(grifo = principal) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque Cancha",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 2000,
      nivel_actual: 2000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: grifo,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  const recibir = (tanqueId: number, cantidad: number, reparto?: unknown[]) =>
    admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanqueId,
      grifo_id: grifoProveedor,
      cantidad,
      costo_unitario: 17,
      recibido_en: new Date().toISOString(),
      reparto_excedente: reparto,
    });

  const tanqueta = async (id: number) =>
    (await admin.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === id
    );

  it("sin código asigna el siguiente TQT-nnn, con 280 de capacidad por defecto", async () => {
    const a = await nuevaTanqueta();
    const b = await nuevaTanqueta();
    expect(a.status).toBe(201);
    expect(a.body.codigo).toMatch(/^TQT-\d{3}$/);
    expect(Number(a.body.capacidad)).toBe(280);
    const n = (c: string) => Number(c.slice(4));
    expect(n(b.body.codigo)).toBe(n(a.body.codigo) + 1);
    expect(Number(a.body.saldo)).toBe(0);
  });

  it("un código repetido (sin importar mayúsculas) da 409", async () => {
    const codigo = idUnico("CUBETA");
    expect((await nuevaTanqueta({ codigo })).status).toBe(201);
    expect((await nuevaTanqueta({ codigo: codigo.toLowerCase() })).status).toBe(409);
  });

  it("el 409 de la recepción trae las tanquetas libres de la sede del tanque", async () => {
    const libre = (await nuevaTanqueta()).body;
    const ajena = (await nuevaTanqueta({ grifo_interno_id: otroGrifo })).body;
    const tq = await tanqueLleno();
    const r = await recibir(tq, 500);
    expect(r.status).toBe(409);
    const ids = r.body.detalle.tanquetasLibres.map((t: { id: number }) => t.id);
    expect(ids).toContain(Number(libre.id));
    expect(ids).not.toContain(Number(ajena.id));
  });

  it("500 de excedente: 280 + 220 en dos tanquetas, y el saldo de cada una queda bien", async () => {
    const a = (await nuevaTanqueta()).body;
    const b = (await nuevaTanqueta()).body;
    const tq = await tanqueLleno();
    const r = await recibir(tq, 500, [
      { destino: "cubeta", cantidad: 280, tanqueta_id: Number(a.id) },
      { destino: "cubeta", cantidad: 220, tanqueta_id: Number(b.id) },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ta = await tanqueta(Number(a.id));
    const tb = await tanqueta(Number(b.id));
    expect(Number(ta.saldo)).toBe(280);
    expect(Number(ta.libre)).toBe(0);
    expect(Number(tb.saldo)).toBe(220);
    expect(Number(tb.libre)).toBe(60);

    const historial = await admin.get(`/api/erp/combustible/tanquetas/${b.id}/historial`);
    expect(historial.status).toBe(200);
    expect(Number(historial.body[0].cantidad)).toBe(220);
  });

  it("ponerle a una tanqueta más que su espacio libre se rechaza (el tope de 280)", async () => {
    const a = (await nuevaTanqueta()).body;
    const tq = await tanqueLleno();
    const r = await recibir(tq, 500, [
      { destino: "cubeta", cantidad: 500, tanqueta_id: Number(a.id) },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("solo tiene 280 gal libres");
  });

  it("dos líneas a la misma tanqueta suman contra su espacio libre", async () => {
    const a = (await nuevaTanqueta()).body;
    const tq = await tanqueLleno();
    const r = await recibir(tq, 300, [
      { destino: "cubeta", cantidad: 200, tanqueta_id: Number(a.id) },
      { destino: "cubeta", cantidad: 100, tanqueta_id: Number(a.id) },
    ]);
    expect(r.status).toBe(400);
  });

  it("una tanqueta de otra sede no se puede llenar con este tanque", async () => {
    const ajena = (await nuevaTanqueta({ grifo_interno_id: otroGrifo })).body;
    const tq = await tanqueLleno();
    const r = await recibir(tq, 100, [
      { destino: "cubeta", cantidad: 100, tanqueta_id: Number(ajena.id) },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("otra sede");
  });

  it("una línea de cubeta sin tanqueta se rechaza", async () => {
    const tq = await tanqueLleno();
    const r = await recibir(tq, 100, [{ destino: "cubeta", cantidad: 100 }]);
    expect(r.status).toBe(400);
  });

  it("anular la recepción devuelve el espacio de la tanqueta", async () => {
    const a = (await nuevaTanqueta()).body;
    const tq = await tanqueLleno();
    const r = await recibir(tq, 100, [
      { destino: "cubeta", cantidad: 100, tanqueta_id: Number(a.id) },
    ]);
    expect(r.status).toBe(201);
    expect(Number((await tanqueta(Number(a.id))).saldo)).toBe(100);
    const anulada = await admin
      .patch(`/api/erp/combustible/recepciones/${r.body.id}/anular`)
      .send({ motivo: "cargada por error" });
    expect(anulada.status).toBe(200);
    expect(Number((await tanqueta(Number(a.id))).saldo)).toBe(0);
  });

  it("no se da de baja ni se achica por debajo del saldo; vacía sí se da de baja con motivo", async () => {
    const a = (await nuevaTanqueta()).body;
    const tq = await tanqueLleno();
    await recibir(tq, 100, [{ destino: "cubeta", cantidad: 100, tanqueta_id: Number(a.id) }]);
    const url = `/api/erp/combustible/tanquetas/${a.id}`;
    expect((await admin.put(url).send({ activa: false, motivo: "rota" })).status).toBe(400);
    expect((await admin.put(url).send({ capacidad: 50 })).status).toBe(400);

    const vacia = (await nuevaTanqueta()).body;
    const urlVacia = `/api/erp/combustible/tanquetas/${vacia.id}`;
    expect((await admin.put(urlVacia).send({ activa: false })).status).toBe(400);
    const baja = await admin.put(urlVacia).send({ activa: false, motivo: "se rompió" });
    expect(baja.status).toBe(200);
    expect(baja.body.activa).toBe(false);
  });

  it("Lectura ve el panel pero no puede dar de alta; el grifero no ve el panel por defecto", async () => {
    const lectura = await conRol("lectura");
    expect((await lectura.get("/api/erp/combustible/tanquetas")).status).toBe(200);
    expect(
      (await lectura.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .status
    ).toBe(403);
    const grifero = await conRol("grifero");
    expect((await grifero.get("/api/erp/combustible/tanquetas")).status).toBe(403);
  });
});
