/** tests/combustible-recepcion-con-compra.test.ts
 *
 * La recepción vinculada a la compra de su cisterna (migración 0173): toma el documento de la
 * compra, la marca recibida una sola vez, compara lo descargado con lo que dice el documento y
 * deja anotada la descarga que se hizo sin compra hasta que se vincule.
 *
 * Método de siempre: cada ataque con su gemelo (el mismo pedido que sí debe funcionar).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { diferenciaEnGalones } from "../src/modules/combustible/comprasCisterna.service";

const BASE = "/api/erp/combustible";
const password = "ClaveDePrueba123";

type Agente = ReturnType<typeof request.agent>;

interface Compra {
  id: string;
  estado: "registrada" | "por_llegar" | "recibida" | "anulada";
  recepcion_id: string | null;
}

describe("diferenciaEnGalones", () => {
  it("negativa si llegó menos, en galones aunque el tanque o el documento vengan en litros", () => {
    expect(
      diferenciaEnGalones({
        cantidadDelDocumento: 11100,
        unidadDelDocumento: "gal",
        descargado: 11090,
        unidadDelTanque: "gal",
      })
    ).toBe(-10);
    expect(
      diferenciaEnGalones({
        cantidadDelDocumento: 1000,
        unidadDelDocumento: "gal",
        descargado: 3785.41,
        unidadDelTanque: "L",
      })
    ).toBeCloseTo(0, 1);
    expect(
      diferenciaEnGalones({
        cantidadDelDocumento: 3785.41,
        unidadDelDocumento: "L",
        descargado: 1010,
        unidadDelTanque: "gal",
      })
    ).toBeCloseTo(10, 1);
  });
});

describe("combustible: recepción con la compra de su cisterna", () => {
  let tenantId: string;
  let otroTenantId: string;
  let slug: string;
  const admin = request.agent(app);
  const otraEmpresa = request.agent(app);
  let proveedor: number;
  let otroProveedor: number;
  let grifoA: number;
  let grifoB: number;
  let seq = 0;
  let documento = 0;

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(88700000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    expect(
      (
        await agente
          .post("/api/auth/login")
          .send({ tenantSlug: slug, identificador: dni, password })
      ).status
    ).toBe(200);
    return agente;
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    proveedor = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("PROV") })).body.id;
    otroProveedor = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("OTRO") })).body.id;
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    grifoA = sedes[0].grifos[0].id;
    grifoB = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: "Grifo B" })
    ).body.id;
    const o = await crearTenantDePrueba(password);
    otroTenantId = o.tenant.id;
    await otraEmpresa
      .post("/api/auth/login")
      .send({ tenantSlug: o.tenant.slug, email: o.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(otroTenantId);
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
      requiere_documento: true,
      grifo_interno_id: grifoA,
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  // La fecha de Lima, no la UTC: el servidor decide "ya llegó" con la de Lima, y entre las 7 p.m. y la
  // medianoche de Lima la UTC ya está en el día siguiente.
  const enDias = (n: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(
      new Date(Date.now() + n * 86_400_000)
    );
  const hoy = () => enDias(0);

  async function compra(extra: Record<string, unknown> = {}): Promise<Compra> {
    const r = await admin.post(`${BASE}/compras-cisterna`).send({
      grifo_interno_id: grifoA,
      grifo_id: proveedor,
      tipo_combustible: "diesel_b5",
      tipo_documento: "guia_remision",
      numero_documento: `TRR1-${++documento}`,
      fecha_compra: hoy(),
      llegada_estimada: hoy(),
      cantidad_facturada: 11100,
      costo_unitario: 24.5,
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  }

  const recibir = (tq: number, extra: Record<string, unknown> = {}, ag: Agente = admin) =>
    ag.post(`${BASE}/recepciones`).send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad: 11100,
      costo_unitario: 24.5,
      ...extra,
    });

  const alertasDe = (recepcionId: number | string) =>
    withTenant(
      tenantId,
      async (c) =>
        (
          await c.query<{ tipo: string; resuelta: boolean; detalle: Record<string, unknown> }>(
            `SELECT tipo, resuelta_en IS NOT NULL AS resuelta, detalle
             FROM combustible_alertas WHERE recepcion_id = $1 ORDER BY id`,
            [recepcionId]
          )
        ).rows
    );

  const lista = async (ag: Agente): Promise<Compra[]> => {
    const r = await ag.get(`${BASE}/compras-cisterna`);
    expect(r.status).toBe(200);
    return r.body;
  };
  const estadoDe = async (id: string) => (await lista(admin)).find((c) => c.id === id)!.estado;

  it("toma el documento de la compra si no se escribió, y respeta el que se escribió", async () => {
    const tq = await tanque();
    const c = await compra({ numero_documento: "TRR1-3638" });
    const r = await recibir(tq, { compra_id: Number(c.id) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.tipo_documento).toBe("guia_remision");
    expect(r.body.numero_documento).toBe("TRR1-3638");

    const c2 = await compra();
    const r2 = await recibir(tq, {
      compra_id: Number(c2.id),
      tipo_documento: "factura",
      numero_documento: "F001-77",
    });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.numero_documento).toBe("F001-77");
  });

  it("la compra queda recibida con su recepción, y una segunda descarga da 400 (no 500)", async () => {
    const tq = await tanque();
    const c = await compra();
    const r = await recibir(tq, { compra_id: Number(c.id) });
    expect(r.status).toBe(201);
    const vista = (await lista(admin)).find((x) => x.id === c.id)!;
    expect(vista.estado).toBe("recibida");
    expect(String(vista.recepcion_id)).toBe(String(r.body.id));
    const otra = await recibir(tq, { compra_id: Number(c.id), cantidad: 10 });
    expect(otra.status, JSON.stringify(otra.body)).toBe(400);
    expect(otra.body.error).toMatch(/ya tiene su recepción/);
    // Una recibida no se puede habilitar ni anular.
    expect((await admin.patch(`${BASE}/compras-cisterna/${c.id}/habilitar`)).status).toBe(409);
    expect(
      (await admin.patch(`${BASE}/compras-cisterna/${c.id}/anular`).send({ motivo: "x" })).status
    ).toBe(409);
  });

  it("anular la recepción libera la compra, y se puede recibir otra vez", async () => {
    const tq = await tanque();
    const c = await compra();
    const r = await recibir(tq, { compra_id: Number(c.id) });
    expect(r.status).toBe(201);
    const a = await admin
      .patch(`${BASE}/recepciones/${r.body.id}/anular`)
      .send({ motivo: "se registró con la cantidad mal" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(await estadoDe(c.id)).toBe("por_llegar");
    const de_nuevo = await recibir(tq, { compra_id: Number(c.id) });
    expect(de_nuevo.status, JSON.stringify(de_nuevo.body)).toBe(201);
    expect(await estadoDe(c.id)).toBe("recibida");
  });

  it("la compra tiene que coincidir en combustible, grifo y proveedor", async () => {
    const tq = await tanque();
    const c = await compra();
    const gasolina = await tanque({ tipo_combustible: "gasolina_90" });
    const enB = await tanque({ grifo_interno_id: grifoB });

    const r1 = await recibir(gasolina, { compra_id: Number(c.id) });
    expect(r1.status, JSON.stringify(r1.body)).toBe(400);
    expect(r1.body.error).toMatch(/otro tipo de combustible/);
    const r2 = await recibir(enB, { compra_id: Number(c.id) });
    expect(r2.status, JSON.stringify(r2.body)).toBe(400);
    expect(r2.body.error).toMatch(/otro grifo/);
    const r3 = await recibir(tq, { compra_id: Number(c.id), grifo_id: otroProveedor });
    expect(r3.status, JSON.stringify(r3.body)).toBe(400);
    expect(r3.body.error).toMatch(/proveedor/);
    // Ninguno de los rechazos la consumió: el gemelo correcto sí entra.
    expect(await estadoDe(c.id)).not.toBe("recibida");
    expect((await recibir(tq, { compra_id: Number(c.id) })).status).toBe(201);
  });

  it("una compra anulada, inexistente, de otra empresa o para urea: 400", async () => {
    const tq = await tanque();
    const c = await compra();
    await admin.patch(`${BASE}/compras-cisterna/${c.id}/anular`).send({ motivo: "duplicada" });
    expect((await recibir(tq, { compra_id: Number(c.id) })).status).toBe(400);
    expect((await recibir(tq, { compra_id: 99999999 })).status).toBe(400);
    const ajena = (await otraEmpresa.get("/api/erp/sedes")).body.sedes[0].grifos[0].id as number;
    void ajena;
    const buena = await compra();
    // La otra empresa no puede recibir una compra de esta.
    const tqAjeno = (
      await otraEmpresa.post(BASE).send({
        codigo: idUnico("TQ"),
        tanque_nombre: "T",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 5000,
        nivel_actual: 100,
        requiere_documento: false,
      })
    ).body.id;
    const provAjeno = (await otraEmpresa.post(`${BASE}/grifos`).send({ nombre: idUnico("PA") }))
      .body.id;
    const intrusa = await otraEmpresa.post(`${BASE}/recepciones`).send({
      combustible_id: tqAjeno,
      grifo_id: provAjeno,
      cantidad: 100,
      costo_unitario: 20,
      compra_id: Number(buena.id),
    });
    expect(intrusa.status, JSON.stringify(intrusa.body)).toBe(400);
    expect(await estadoDe(buena.id)).not.toBe("recibida");
    // Urea no lleva compra de cisterna.
    const urea = await admin.post(`${BASE}/recepciones`).send({
      producto: "urea",
      grifo_id: proveedor,
      presentacion: "caja",
      cantidad_bultos: 1,
      costo_unitario: 70,
      compra_id: Number(buena.id),
    });
    expect(urea.status).toBe(400);
  });

  describe("la diferencia con lo que dice el documento", () => {
    it("llegó menos que la tolerancia (3 gal): sin alerta; pasada la tolerancia: alerta con el detalle", async () => {
      const tq = await tanque();
      const dentro = await compra({ cantidad_facturada: 5000 });
      const r1 = await recibir(tq, { compra_id: Number(dentro.id), cantidad: 4998 });
      expect(r1.status).toBe(201);
      expect((await alertasDe(r1.body.id)).filter((a) => a.tipo === "compra_diferencia")).toEqual(
        []
      );
      // Justo en la tolerancia (−3) tampoco alerta: solo lo que la pasa.
      const justo = await compra({ cantidad_facturada: 5000 });
      const r2 = await recibir(tq, { compra_id: Number(justo.id), cantidad: 4997 });
      expect((await alertasDe(r2.body.id)).filter((a) => a.tipo === "compra_diferencia")).toEqual(
        []
      );
      const fuera = await compra({ cantidad_facturada: 5000 });
      const r3 = await recibir(tq, { compra_id: Number(fuera.id), cantidad: 4990 });
      const alertas = (await alertasDe(r3.body.id)).filter((a) => a.tipo === "compra_diferencia");
      expect(alertas).toHaveLength(1);
      expect(alertas[0].detalle).toMatchObject({
        compraId: Number(fuera.id),
        cantidadDelDocumento: 5000,
        descargado: 4990,
        diferenciaGalones: -10,
        toleranciaGalones: 3,
      });
    });

    it("si llegó MÁS de lo que dice el documento, también alerta", async () => {
      const tq = await tanque();
      const c = await compra({ cantidad_facturada: 5000 });
      const r = await recibir(tq, { compra_id: Number(c.id), cantidad: 5020 });
      const a = (await alertasDe(r.body.id)).filter((x) => x.tipo === "compra_diferencia");
      expect(a).toHaveLength(1);
      expect(a[0].detalle).toMatchObject({ diferenciaGalones: 20 });
    });

    it("el sobrante repartido cuenta como descargado: cantidad al tanque + sobrante = lo entregado", async () => {
      // Tanque con 100 de espacio: de 1,000 entregados, 100 entran y 900 quedan en la cisterna.
      const tq = await tanque({
        capacidad_total: 1100,
        nivel_actual: 1000,
        modo_excedente_recepcion: "flexible",
      });
      const c = await compra({ cantidad_facturada: 1000 });
      const r = await recibir(tq, {
        compra_id: Number(c.id),
        cantidad: 1000,
        reparto_excedente: [{ destino: "cisterna", cantidad: 900 }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await alertasDe(r.body.id)).filter((a) => a.tipo === "compra_diferencia")).toEqual(
        []
      );
    });

    it("la tolerancia se configura: en cero, un galón de menos ya alerta", async () => {
      const antes = await admin.get(`${BASE}/compras-cisterna/tolerancia`);
      expect(antes.status).toBe(200);
      expect(antes.body.tolerancia_galones).toBe(3);
      const fijar = await admin
        .put(`${BASE}/compras-cisterna/tolerancia`)
        .send({ tolerancia_galones: 0 });
      expect(fijar.status, JSON.stringify(fijar.body)).toBe(200);
      expect(fijar.body.tolerancia_galones).toBe(0);
      try {
        const tq = await tanque();
        const c = await compra({ cantidad_facturada: 2000 });
        const r = await recibir(tq, { compra_id: Number(c.id), cantidad: 1999 });
        const a = (await alertasDe(r.body.id)).filter((x) => x.tipo === "compra_diferencia");
        expect(a).toHaveLength(1);
        expect(a[0].detalle).toMatchObject({ toleranciaGalones: 0, diferenciaGalones: -1 });
      } finally {
        await admin.put(`${BASE}/compras-cisterna/tolerancia`).send({ tolerancia_galones: 3 });
      }
    });

    it("la tolerancia no acepta negativos ni exageros, y solo la fija el admin", async () => {
      for (const malo of [-1, 5000, "tres"]) {
        const r = await admin
          .put(`${BASE}/compras-cisterna/tolerancia`)
          .send({ tolerancia_galones: malo });
        expect(r.status, String(malo)).toBe(400);
      }
      const operador = await persona("operador");
      expect(
        (await operador.put(`${BASE}/compras-cisterna/tolerancia`).send({ tolerancia_galones: 9 }))
          .status
      ).toBe(403);
      expect((await admin.get(`${BASE}/compras-cisterna/tolerancia`)).body.tolerancia_galones).toBe(
        3
      );
    });

    it("litros y galones: un tanque en litros contra un documento en galones se compara bien", async () => {
      const tq = await tanque({ unidad: "L", capacidad_total: 200000, nivel_actual: 10000 });
      const c = await compra({ cantidad_facturada: 1000, unidad: "gal" });
      // 3,780 L son 998.6 gal: 1.4 gal menos, dentro de la tolerancia.
      const r = await recibir(tq, { compra_id: Number(c.id), cantidad: 3780 });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await alertasDe(r.body.id)).filter((a) => a.tipo === "compra_diferencia")).toEqual(
        []
      );
      const c2 = await compra({ cantidad_facturada: 1000, unidad: "gal" });
      // 3,600 L son 951 gal: 49 gal menos, muy fuera.
      const r2 = await recibir(tq, { compra_id: Number(c2.id), cantidad: 3600 });
      const a = (await alertasDe(r2.body.id)).filter((x) => x.tipo === "compra_diferencia");
      expect(a).toHaveLength(1);
      expect(Number(a[0].detalle.diferenciaGalones)).toBeLessThan(-40);
    });
  });

  describe("descarga sin compra registrada", () => {
    it("vincularla después resuelve la alerta; antes de usar compras no hay alerta", async () => {
      // La empresa de este test ya usa compras (las pruebas de arriba registraron varias).
      const tq = await tanque();
      const sin = await recibir(tq, {
        cantidad: 700,
        tipo_documento: "factura",
        numero_documento: "F-SIN-1",
      });
      expect(sin.status, JSON.stringify(sin.body)).toBe(201);
      const alertas = await alertasDe(sin.body.id);
      expect(alertas.filter((a) => a.tipo === "recepcion_sin_compra" && !a.resuelta)).toHaveLength(
        1
      );

      const c = await compra({ cantidad_facturada: 700, tipo_documento: "factura" });
      const v = await admin
        .patch(`${BASE}/compras-cisterna/${c.id}/vincular`)
        .send({ recepcion_id: Number(sin.body.id) });
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(v.body.estado).toBe("recibida");
      expect(String(v.body.recepcion_id)).toBe(String(sin.body.id));
      const despues = await alertasDe(sin.body.id);
      expect(despues.filter((a) => a.tipo === "recepcion_sin_compra" && !a.resuelta)).toEqual([]);
    });

    it("al vincular también se revisa la diferencia", async () => {
      const tq = await tanque();
      const sin = await recibir(tq, {
        cantidad: 690,
        tipo_documento: "factura",
        numero_documento: "F-SIN-2",
      });
      const c = await compra({ cantidad_facturada: 700 });
      const v = await admin
        .patch(`${BASE}/compras-cisterna/${c.id}/vincular`)
        .send({ recepcion_id: Number(sin.body.id) });
      expect(v.status).toBe(200);
      const a = (await alertasDe(sin.body.id)).filter((x) => x.tipo === "compra_diferencia");
      expect(a).toHaveLength(1);
      expect(a[0].detalle).toMatchObject({ diferenciaGalones: -10 });
    });

    it("no se vincula lo que no corresponde: recepción ya vinculada, anulada, de otra empresa o de otro combustible", async () => {
      const tq = await tanque();
      const conCompra = await compra();
      const r = await recibir(tq, { compra_id: Number(conCompra.id) });
      const otra = await compra();
      const yaTiene = await admin
        .patch(`${BASE}/compras-cisterna/${otra.id}/vincular`)
        .send({ recepcion_id: Number(r.body.id) });
      expect(yaTiene.status, JSON.stringify(yaTiene.body)).toBe(409);

      const sin = await recibir(tq, {
        cantidad: 50,
        tipo_documento: "factura",
        numero_documento: "F-SIN-3",
      });
      await admin
        .patch(`${BASE}/recepciones/${sin.body.id}/anular`)
        .send({ motivo: "mal registrada" });
      const anulada = await admin
        .patch(`${BASE}/compras-cisterna/${otra.id}/vincular`)
        .send({ recepcion_id: Number(sin.body.id) });
      expect(anulada.status).toBe(409);

      const ajena = await otraEmpresa
        .patch(`${BASE}/compras-cisterna/${otra.id}/vincular`)
        .send({ recepcion_id: Number(r.body.id) });
      expect([404, 409]).toContain(ajena.status);

      const gasolina = await tanque({ tipo_combustible: "gasolina_90" });
      const deGasolina = await recibir(gasolina, {
        cantidad: 50,
        tipo_documento: "factura",
        numero_documento: "F-SIN-4",
      });
      const noCoincide = await admin
        .patch(`${BASE}/compras-cisterna/${otra.id}/vincular`)
        .send({ recepcion_id: Number(deGasolina.body.id) });
      expect(noCoincide.status, JSON.stringify(noCoincide.body)).toBe(400);
      // La compra sigue libre para su recepción correcta.
      expect(await estadoDe(otra.id)).not.toBe("recibida");
    });
  });

  describe("la cancha", () => {
    it("el grifero recibe una compra por llegar; una aún registrada no existe para él", async () => {
      const grifero = await persona("grifero");
      const tq = await tanque();
      const futura = await compra({
        llegada_estimada: enDias(5),
      });
      const rechazada = await recibir(tq, { compra_id: Number(futura.id) }, grifero);
      expect(rechazada.status, JSON.stringify(rechazada.body)).toBe(400);
      expect(await estadoDe(futura.id)).toBe("registrada");

      // El gemelo: habilitada por la encargada, el mismo grifero la recibe.
      expect((await admin.patch(`${BASE}/compras-cisterna/${futura.id}/habilitar`)).status).toBe(
        200
      );
      const ok = await recibir(tq, { compra_id: Number(futura.id) }, grifero);
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      // Una vez recibida, ya no sale en su lista.
      expect((await lista(grifero)).find((c) => c.id === futura.id)).toBeUndefined();
    });

    it("el grifero no vincula compras ni ve la tolerancia", async () => {
      const grifero = await persona("grifero");
      const tq = await tanque();
      const sin = await recibir(tq, {
        cantidad: 30,
        tipo_documento: "factura",
        numero_documento: "F-SIN-5",
      });
      const c = await compra();
      expect(
        (
          await grifero
            .patch(`${BASE}/compras-cisterna/${c.id}/vincular`)
            .send({ recepcion_id: Number(sin.body.id) })
        ).status
      ).toBe(403);
      expect((await grifero.get(`${BASE}/compras-cisterna/tolerancia`)).status).toBe(403);
    });
  });

  it("una recepción sin compra sigue siendo la de siempre: no pide nada nuevo", async () => {
    const tq = await tanque();
    const r = await recibir(tq, { tipo_documento: "factura", numero_documento: "F-LIBRE" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.compra_id ?? null).toBeNull();
  });
});
