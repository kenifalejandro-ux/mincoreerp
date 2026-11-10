/** tests/control-tv-consumo.test.ts
 *
 * GET /api/erp/viajes/control-tv/consumo (Control TV): lo que llegó a una unidad por hora o por día,
 * sin contar el vale que solo llena una tanqueta (un traspaso, no consumo); la entrada de
 * combustible del período; el permiso «Control TV» (admin y lectura sí; operador no, salvo que se
 * le dé) y que cada empresa vea lo suyo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";

type Agente = ReturnType<typeof request.agent>;

const PASSWORD = "ClaveDePrueba123";
const URL = "/api/erp/viajes/control-tv/consumo";

describe("control TV: consumo y entrada", () => {
  const tenants: string[] = [];
  let slug: string;
  let tenantId: string;
  let admin: Agente;
  let principal: number;
  let tanque: number;
  let equipo: number;
  let seq = 0;
  let nVale = 1;

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(88600000 + Math.floor(Math.random() * 500000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password: PASSWORD, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const entrar = () =>
      agente
        .post("/api/auth/login")
        .send({ tenantSlug: slug, identificador: dni, password: PASSWORD });
    await entrar();
    return { agente, id: alta.body.id as string, entrar };
  }

  /** El permiso por pestaña de una persona (el administrador lo da o lo quita). */
  const pestana = (id: string, permitido: boolean) =>
    request(app)
      .put(`/api/platform/tenants/${tenantId}/usuarios/${id}/pestanas`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ pestanas: [{ modulo: "combustible", pestana: "viajes:control_tv", permitido }] });

  const vale = (extra: Record<string, unknown>, cantidad: number) => {
    return admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanque,
      tipo_combustible: "diesel_b5",
      serie_talonario: "TV",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      ...extra,
    });
  };

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(PASSWORD);
    tenants.push(creado.tenant.id);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    admin = request.agent(app);
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password: PASSWORD })
      .expect(200);
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const tq = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque TV",
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
    expect(tq.status, JSON.stringify(tq.body)).toBe(201);
    tanque = tq.body.id;
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: principal,
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    equipo = Number(eq.body.id);
  });

  afterAll(async () => {
    for (const id of tenants) await borrarTenantDePrueba(id);
    await closeDatabase();
  });

  it("cuenta lo cargado a una unidad y NO el vale que solo llena una tanqueta", async () => {
    const vacio = await admin.get(URL);
    expect(vacio.status, JSON.stringify(vacio.body)).toBe(200);
    expect(vacio.body.consumo.total.gal).toBe(0);

    const aUnidad = await vale({ tipo_destino: "equipo", equipo_id: equipo, medidor: 100 }, 10);
    expect(aUnidad.status, JSON.stringify(aUnidad.body)).toBe(201);
    const tanqueta = Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );
    const aTanqueta = await vale(
      { tipo_destino: "reserva_cubeta", tanqueta_destino_id: tanqueta },
      100
    );
    expect(aTanqueta.status, JSON.stringify(aTanqueta.body)).toBe(201);

    const r = await admin.get(`${URL}?periodo=24h`);
    expect(r.status).toBe(200);
    // Solo los 10 gal que llegaron a la unidad; los 100 de la tanqueta no son consumo.
    expect(r.body.consumo.total.gal).toBeCloseTo(10, 2);
    expect(r.body.consumo.total.interno_gal).toBeCloseTo(10, 2);
    expect(r.body.consumo.total.costo).toBeCloseTo(160, 2);
    expect(r.body.consumo.agrupado_por).toBe("hora");
    // 24 cortes por hora, sin huecos, y la suma de la serie es el total.
    expect(r.body.consumo.serie).toHaveLength(24);
    const suma = r.body.consumo.serie.reduce((s: number, x: { gal: number }) => s + x.gal, 0);
    expect(suma).toBeCloseTo(10, 2);

    // Los últimos eventos: la carga a la unidad sí; el llenado de la tanqueta no es un evento.
    const ev = (await admin.get("/api/erp/viajes/control-tv/resumen")).body.eventos as {
      tipo: string;
      detalle: string;
    }[];
    const cargas = ev.filter((e) => e.tipo === "carga");
    expect(cargas).toHaveLength(1);
    expect(cargas[0].detalle).toContain("10.0 gal");
    expect(cargas[0].detalle).toContain("desde el tanque");

    // El nivel del tanque trae su lectura inicial, su capacidad y su mínimo.
    const nv = r.body.niveles.find((n: { nombre: string }) => n.nombre === "Tanque TV");
    expect(nv).toMatchObject({ capacidad: 50000, minimo: 100, unidad: "gal" });
    expect(nv.puntos.length).toBeGreaterThanOrEqual(1);
    expect(nv.puntos[0].nivel).toBeCloseTo(40000, 0);
  });

  it("7 y 30 días se agrupan por día; el período por defecto es 24 h; uno inválido da 400", async () => {
    const siete = await admin.get(`${URL}?periodo=7d`);
    expect(siete.body.consumo.agrupado_por).toBe("dia");
    expect(siete.body.consumo.serie).toHaveLength(7);
    expect(siete.body.consumo.total.gal).toBeCloseTo(10, 2);
    expect((await admin.get(`${URL}?periodo=30d`)).body.consumo.serie).toHaveLength(30);
    expect((await admin.get(URL)).body.consumo.serie).toHaveLength(24);
    expect((await admin.get(`${URL}?periodo=1y`)).status).toBe(400);
  });

  it("la entrada del período suma lo recibido y trae las últimas recepciones", async () => {
    const prov = await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("CIST") });
    expect(prov.status, JSON.stringify(prov.body)).toBe(201);
    const rec = await admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanque,
      grifo_id: prov.body.id,
      cantidad: 500,
      costo_unitario: 16.5,
      tipo_documento: "factura",
      numero_documento: idUnico("F001"),
      recibido_en: new Date().toISOString(),
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const r = await admin.get(URL);
    expect(r.body.entrada.recepciones).toBe(1);
    expect(r.body.entrada.recibido_gal).toBeCloseTo(500, 2);
    expect(r.body.entrada.al_tanque_gal).toBeCloseTo(500, 2);
    expect(r.body.entrada.derivado_gal).toBe(0);
    expect(r.body.entrada.costo).toBeCloseTo(8250, 2);
    expect(r.body.entrada.ultimas).toHaveLength(1);
    expect(r.body.entrada.ultimas[0]).toMatchObject({
      tanque: "Tanque TV",
      compra_documento: null,
    });
  });

  it("permiso «Control TV»: lectura sí, operador y conductor no, y el operador lo recibe si se le da", async () => {
    for (const ruta of [URL, "/api/erp/viajes/control-tv/resumen"]) {
      expect((await (await persona("lectura")).agente.get(ruta)).status, ruta).toBe(200);
      expect((await (await persona("conductor_ruta")).agente.get(ruta)).status, ruta).toBe(403);
    }
    // El operador no lo trae; el administrador se lo da, y a lectura se lo quita.
    const op = await persona("operador");
    expect((await op.agente.get(URL)).status).toBe(403);
    const dar = await pestana(op.id, true);
    expect(dar.status, JSON.stringify(dar.body)).toBe(200);
    await op.entrar(); // el permiso se lee al iniciar sesión
    expect((await op.agente.get(URL)).status).toBe(200);
    const lectura = await persona("lectura");
    expect((await pestana(lectura.id, false)).status).toBe(200);
    await lectura.entrar();
    expect((await lectura.agente.get(URL)).status).toBe(403);
  });

  it("una empresa sin movimientos ve todo en cero y sin ver lo de otra", async () => {
    const otra = await crearTenantDePrueba(PASSWORD);
    tenants.push(otra.tenant.id);
    const ajeno = request.agent(app);
    await ajeno
      .post("/api/auth/login")
      .send({ tenantSlug: otra.tenant.slug, email: otra.usuario.email, password: PASSWORD })
      .expect(200);
    const r = await ajeno.get(URL);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.consumo.total.gal).toBe(0);
    expect(r.body.entrada.recepciones).toBe(0);
  });
});
