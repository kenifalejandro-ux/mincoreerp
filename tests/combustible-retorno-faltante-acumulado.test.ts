/** tests/combustible-retorno-faltante-acumulado.test.ts
 *
 * El margen de cada retorno (5 gal o 5 %) mira un retorno por separado: quien
 * devuelve siempre un 5 % de menos no alerta nunca (auditoría de #316-#321,
 * hallazgo 3: 8 retornos de 280 gal declarando 266 hacían desaparecer 112 gal sin
 * una alerta). Ahora, además, se acumula el faltante de la MISMA tanqueta en 30
 * días: con al menos 2 retornos con faltante, 10 gal o más y más del 2 % de lo que
 * se calculaba que volvía, avisa; y vuelve a avisar solo si crece otros 10 gal.
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

describe("combustible: el faltante acumulado de una tanqueta avisa aunque cada retorno parezca normal", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let principal: number;
  let fuenteId: number;
  let pozoId: number;
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
    fuenteId = await tanque(50000, 40000);
    pozoId = await tanque(200000, 5000);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(capacidad: number, nivel: number) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de prueba",
      tipo_combustible: "diesel_b5",
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

  async function nuevaTanqueta() {
    const r = await admin
      .post("/api/erp/combustible/tanquetas")
      .send({ grifo_interno_id: principal });
    return { id: Number(r.body.id), codigo: r.body.codigo as string };
  }

  const nuevaUnidad = async () =>
    Number(
      (
        await admin.post("/api/erp/equipos").send({
          placa_codigo: idUnico("VQ"),
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
          grifo_interno_id: principal,
        })
      ).body.id
    );

  /** Un ciclo: sale con `calculado` gal a una unidad y vuelve al pozo con `validado`. */
  async function ciclo(tqt: number, calculado: number, validado: number) {
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: fuenteId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tqt,
      serie_talonario: "ACU",
      n_vale: nVale++,
      cantidad: calculado,
      lectura_contometro: calculado,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    // La unidad se crea ANTES de armar la petición: dos peticiones de supertest
    // anidadas dan ECONNREFUSED.
    const unidad = await nuevaUnidad();
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${tqt}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: "ACA", n_vale: nAsig++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const r = await recibirTanqueta(admin, tqt, {
      destino: "pozo",
      tanqueId: pozoId,
      validado,
      motivo: validado === calculado ? undefined : "merma al volver",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }

  type Alerta = { tipo: string; detalle: Record<string, unknown> };
  const alertasDe = async (codigo: string) => {
    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    expect(r.status).toBe(200);
    return (r.body.data as Alerta[]).filter(
      (a) => a.tipo === "tanqueta_retorno_diferencia" && a.detalle.tanqueta === codigo
    );
  };

  it("el caso del auditor: dos retornos de 280 gal declarando 266 avisan en el segundo", async () => {
    const t = await nuevaTanqueta();
    await ciclo(t.id, 280, 266);
    expect(await alertasDe(t.codigo)).toHaveLength(0);
    await ciclo(t.id, 280, 266);
    const alertas = await alertasDe(t.codigo);
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle.acumulado).toMatchObject({
      dias: 30,
      retornos: 2,
      faltante: 28,
      calculado: 560,
    });
  });

  it("una merma honesta o pequeña no avisa: 1 % o 1,5 % repartido en varios retornos", async () => {
    const honesta = await nuevaTanqueta();
    for (let i = 0; i < 3; i++) await ciclo(honesta.id, 200, 198);
    expect(await alertasDe(honesta.codigo)).toHaveLength(0);
    const pequena = await nuevaTanqueta();
    for (let i = 0; i < 4; i++) await ciclo(pequena.id, 200, 197);
    expect(await alertasDe(pequena.codigo)).toHaveLength(0);
  });

  it("un faltante sostenido avisa al cruzar y vuelve a avisar solo cuando crece otros 10 gal", async () => {
    const t = await nuevaTanqueta();
    const conteo: number[] = [];
    for (let i = 0; i < 4; i++) {
      await ciclo(t.id, 200, 194);
      conteo.push((await alertasDe(t.codigo)).length);
    }
    // 1.º: un solo faltante. 2.º: 12 gal acumulados (> 2 % de 400) → avisa.
    // 3.º: 18 gal, solo 6 más que el aviso → no. 4.º: 24 gal, 12 más → avisa.
    expect(conteo).toEqual([0, 1, 1, 2]);
  });

  it("los retornos de hace más de 30 días ya no cuentan", async () => {
    const t = await nuevaTanqueta();
    await ciclo(t.id, 280, 266);
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE combustible_tanqueta_retornos SET creado_en = now() - interval '40 days'
          WHERE tenant_id = $1 AND tanqueta_id = $2`,
        [tenantId, t.id]
      )
    );
    await ciclo(t.id, 280, 266);
    expect(await alertasDe(t.codigo)).toHaveLength(0);
  });

  it("el faltante de una tanqueta no se suma al de otra", async () => {
    const a = await nuevaTanqueta();
    const b = await nuevaTanqueta();
    await ciclo(a.id, 280, 266);
    await ciclo(b.id, 280, 266);
    expect(await alertasDe(a.codigo)).toHaveLength(0);
    expect(await alertasDe(b.codigo)).toHaveLength(0);
  });
});
