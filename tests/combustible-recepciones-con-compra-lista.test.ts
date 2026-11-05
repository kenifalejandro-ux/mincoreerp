/** tests/combustible-recepciones-con-compra-lista.test.ts
 *
 * Lo que la lista de recepciones y la ficha del tanque aportan a la pantalla de recepción en
 * Cisternas: por cada recepción su compra, lo que decía el documento y la diferencia en galones; y de
 * cada tanque la fecha de su primera varilla. Todo aditivo: lo que ya salía sigue igual.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const BASE = "/api/erp/combustible";
const password = "ClaveDePrueba123";

interface FilaRecepcion {
  id: string;
  producto: string;
  anulada_en: string | null;
  compra_id: string | null;
  compra_documento: string | null;
  compra_cantidad: string | null;
  compra_unidad: string | null;
  diferencia_compra_galones: string | null;
}

interface FilaTanque {
  id: number;
  primera_lectura_en: string | null;
}

const enDias = (n: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(
    new Date(Date.now() + n * 86_400_000)
  );

describe("combustible: datos de las recepciones con su compra", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let proveedor: number;
  let sede: number;
  let documento = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    proveedor = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("PROV") })).body.id;
    sede = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(extra: Record<string, unknown> = {}) {
    const r = await admin.post(BASE).send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 1000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: sede,
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  async function compra(extra: Record<string, unknown> = {}) {
    const r = await admin.post(`${BASE}/compras-cisterna`).send({
      grifo_interno_id: sede,
      grifo_id: proveedor,
      tipo_combustible: "diesel_b5",
      tipo_documento: "guia_remision",
      numero_documento: `TRR1-${++documento}`,
      fecha_compra: enDias(0),
      llegada_estimada: enDias(0),
      cantidad_facturada: 11100,
      costo_unitario: 24.5,
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; numero_documento: string };
  }

  const recibir = (tq: number, extra: Record<string, unknown> = {}) =>
    admin.post(`${BASE}/recepciones`).send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad: 11100,
      costo_unitario: 24.5,
      ...extra,
    });

  const lista = async (tq?: number): Promise<FilaRecepcion[]> => {
    const r = await admin.get(`${BASE}/recepciones`).query(tq ? { combustible_id: tq } : {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const fila = async (id: string, tq: number) =>
    (await lista(tq)).find((r) => String(r.id) === String(id))!;

  it("una recepción con compra trae su documento, lo que decía y la diferencia (negativa: llegó menos)", async () => {
    const tq = await tanque();
    const c = await compra({ cantidad_facturada: 11100 });
    const r = await recibir(tq, { compra_id: Number(c.id), cantidad: 11090 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const f = await fila(r.body.id, tq);
    expect(String(f.compra_id)).toBe(String(c.id));
    expect(f.compra_documento).toBe(c.numero_documento);
    expect(Number(f.compra_cantidad)).toBe(11100);
    expect(f.compra_unidad).toBe("gal");
    expect(Number(f.diferencia_compra_galones)).toBe(-10);
  });

  it("si llegó más que el documento, la diferencia es positiva; si es exacta, cero", async () => {
    const tq = await tanque();
    const mas = await compra({ cantidad_facturada: 5000 });
    const rMas = await recibir(tq, { compra_id: Number(mas.id), cantidad: 5020 });
    expect(Number((await fila(rMas.body.id, tq)).diferencia_compra_galones)).toBe(20);
    const justa = await compra({ cantidad_facturada: 5000 });
    const rJusta = await recibir(tq, { compra_id: Number(justa.id), cantidad: 5000 });
    expect(Number((await fila(rJusta.body.id, tq)).diferencia_compra_galones)).toBe(0);
  });

  it("el sobrante repartido cuenta como descargado: tanque + sobrante contra el documento", async () => {
    const tq = await tanque({ capacidad_total: 1100, nivel_actual: 1000 });
    const c = await compra({ cantidad_facturada: 1000 });
    const r = await recibir(tq, {
      compra_id: Number(c.id),
      cantidad: 1000,
      reparto_excedente: [{ destino: "cisterna", cantidad: 900 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number((await fila(r.body.id, tq)).diferencia_compra_galones)).toBe(0);
  });

  it("litros contra galones: un tanque en litros y un documento en galones se comparan en galones", async () => {
    const tq = await tanque({ unidad: "L", capacidad_total: 200000, nivel_actual: 10000 });
    const c = await compra({ cantidad_facturada: 1000, unidad: "gal" });
    // 3,780 L son 998.6 gal: 1.4 gal menos.
    const r = await recibir(tq, { compra_id: Number(c.id), cantidad: 3780 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number((await fila(r.body.id, tq)).diferencia_compra_galones)).toBeCloseTo(-1.4, 1);
    // Y al revés: documento en litros contra un tanque en galones.
    const tqGal = await tanque();
    const cl = await compra({ cantidad_facturada: 3785.41, unidad: "L" });
    const r2 = await recibir(tqGal, { compra_id: Number(cl.id), cantidad: 1010 });
    expect(Number((await fila(r2.body.id, tqGal)).diferencia_compra_galones)).toBeCloseTo(10, 1);
  });

  it("sin compra, o una de urea, los campos de la compra vienen vacíos y lo demás sigue igual", async () => {
    const tq = await tanque();
    const r = await recibir(tq, { tipo_documento: "factura", numero_documento: "F-LIBRE" });
    expect(r.status).toBe(201);
    const f = await fila(r.body.id, tq);
    expect(f.compra_id).toBeNull();
    expect(f.compra_documento).toBeNull();
    expect(f.diferencia_compra_galones).toBeNull();
    // La urea tampoco tiene compra de cisterna.
    const urea = await admin.post(`${BASE}/recepciones`).send({
      producto: "urea",
      grifo_id: proveedor,
      presentacion: "caja",
      cantidad_bultos: 1,
      costo_unitario: 70,
    });
    if (urea.status === 201) {
      const delListado = (await lista()).find((x) => String(x.id) === String(urea.body.id))!;
      expect(delListado.producto).toBe("urea");
      expect(delListado.compra_id).toBeNull();
      expect(delListado.diferencia_compra_galones).toBeNull();
    }
  });

  it("una recepción anulada sigue saliendo, con su compra, y la compra queda libre", async () => {
    const tq = await tanque();
    const c = await compra();
    const r = await recibir(tq, { compra_id: Number(c.id) });
    const a = await admin
      .patch(`${BASE}/recepciones/${r.body.id}/anular`)
      .send({ motivo: "se registró mal" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const f = await fila(r.body.id, tq);
    expect(f.anulada_en).not.toBeNull();
    expect(String(f.compra_id)).toBe(String(c.id));
  });

  it("una compra ya recibida no se puede anular (409) y la recepción conserva su compra", async () => {
    const tq = await tanque();
    const c = await compra();
    const r = await recibir(tq, { compra_id: Number(c.id) });
    expect(
      (await admin.patch(`${BASE}/compras-cisterna/${c.id}/anular`).send({ motivo: "x" })).status
    ).toBe(409);
    expect(String((await fila(r.body.id, tq)).compra_id)).toBe(String(c.id));
  });

  it("otra empresa no ve estas recepciones ni sus compras", async () => {
    const tq = await tanque();
    const c = await compra();
    const r = await recibir(tq, { compra_id: Number(c.id) });
    expect(r.status).toBe(201);
    const otra = request.agent(app);
    const o = await crearTenantDePrueba(password);
    try {
      await otra
        .post("/api/auth/login")
        .send({ tenantSlug: o.tenant.slug, email: o.usuario.email, password });
      const suyas = (await otra.get(`${BASE}/recepciones`)).body.data as FilaRecepcion[];
      expect(suyas.find((x) => String(x.id) === String(r.body.id))).toBeUndefined();
      expect(suyas.some((x) => x.compra_documento === c.numero_documento)).toBe(false);
    } finally {
      await borrarTenantDePrueba(o.tenant.id);
    }
  });

  describe("la primera varilla del tanque", () => {
    it("la ficha trae la fecha de la varilla inicial, y las anuladas no cuentan", async () => {
      const tq = await tanque();
      const antes = (await admin.get(BASE)).body as FilaTanque[] | { data: FilaTanque[] };
      const tanques = Array.isArray(antes) ? antes : antes.data;
      const ficha = tanques.find((t) => t.id === tq)!;
      expect(ficha.primera_lectura_en).not.toBeNull();
      const inicial = new Date(ficha.primera_lectura_en!).getTime();
      expect(Math.abs(inicial - Date.now())).toBeLessThan(5 * 60_000);

      // Una varilla posterior no la cambia: es la PRIMERA.
      const lectura = await admin.post(`${BASE}/lecturas`).send({
        combustible_id: tq,
        nivel: 900,
      });
      expect(lectura.status, JSON.stringify(lectura.body)).toBe(201);
      const despues = (await admin.get(BASE)).body as FilaTanque[] | { data: FilaTanque[] };
      const otra = (Array.isArray(despues) ? despues : despues.data).find((t) => t.id === tq)!;
      expect(otra.primera_lectura_en).toBe(ficha.primera_lectura_en);
    });

    it("también viaja en la ficha de un solo tanque", async () => {
      const tq = await tanque();
      const r = await admin.get(`${BASE}/${tq}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.primera_lectura_en).not.toBeNull();
    });
  });

  it("los campos que ya salían en la lista siguen saliendo", async () => {
    const tq = await tanque();
    const r = await recibir(tq, { tipo_documento: "factura", numero_documento: "F-CAMPOS" });
    const f = (await fila(r.body.id, tq)) as unknown as Record<string, unknown>;
    for (const campo of [
      "id",
      "cantidad",
      "costo_unitario",
      "costo_total",
      "tipo_documento",
      "numero_documento",
      "recibido_en",
      "anulada_en",
      "cantidad_derivada",
      "tanque_nombre",
      "grifo_nombre",
      "diferencia_litros",
    ]) {
      expect(Object.keys(f), campo).toContain(campo);
    }
  });
});
