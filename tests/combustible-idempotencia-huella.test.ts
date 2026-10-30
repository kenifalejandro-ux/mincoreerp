/** tests/combustible-idempotencia-huella.test.ts
 *
 * Un cliente_uuid repetido ya no se confunde con un reintento si llega para OTRO
 * registro: la clave recuerda una huella de lo que registró (migración 0162). Mismo
 * registro => se devuelve el primero; otro registro, o de otro tipo (el código de una
 * lectura usado en un despacho) => 409 y no se guarda. Las claves anteriores, sin
 * huella, siguen funcionando como reintento.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const password = "ClaveDePrueba123";
type Agente = ReturnType<typeof request.agent>;
const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
let seq = 0;
const serieUnica = () =>
  `HU${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`.toUpperCase();

describe("combustible: el código repetido con otro contenido da 409", () => {
  const A = request.agent(app);
  const B = request.agent(app);
  let tA: string;
  let tB: string;
  let tanqueA: number;
  let tanqueB: number;
  let grifoProveedorA: number;
  let nVale = 1;

  const tanque = async (ag: Agente) => {
    // El grifo se pide ANTES de armar la petición: dos llamadas anidadas del mismo
    // agente de supertest se pisan el puerto.
    const grifo = (await ag.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    return Number(
      (
        await ag.post("/api/erp/combustible").send({
          codigo: idUnico("TQ"),
          tanque_nombre: "Tanque de la huella",
          tipo_combustible: "diesel_b5",
          unidad: "gal",
          tipo_punto: "fijo",
          capacidad_total: 5000,
          nivel_actual: 4000,
          requiere_documento: false,
          modo_vigilancia: "sin_vigilar",
          grifo_interno_id: grifo,
        })
      ).body.id
    );
  };

  beforeAll(async () => {
    const a = await crearTenantDePrueba(password);
    tA = a.tenant.id;
    await A.post("/api/auth/login").send({
      tenantSlug: a.tenant.slug,
      email: a.usuario.email,
      password,
    });
    const b = await crearTenantDePrueba(password);
    tB = b.tenant.id;
    await B.post("/api/auth/login").send({
      tenantSlug: b.tenant.slug,
      email: b.usuario.email,
      password,
    });
    tanqueA = await tanque(A);
    tanqueB = await tanque(B);
    grifoProveedorA = (
      await A.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("PROV"),
        abastece_tanque: true,
      })
    ).body.id;
  });
  afterAll(async () => {
    await borrarTenantDePrueba(tA);
    await borrarTenantDePrueba(tB);
    await closeDatabase();
  });

  const despacho = (cantidad: number, uuid: string, extra: Record<string, unknown> = {}) => ({
    cliente_uuid: uuid,
    origen: "tanque_propio",
    combustible_id: tanqueA,
    tipo_combustible: "diesel_b5",
    tipo_destino: "planta",
    serie_talonario: serieUnica(),
    n_vale: nVale++,
    cantidad,
    lectura_contometro: cantidad,
    costo_unitario: 16,
    despachado_en: hace(2),
    ...extra,
  });
  const postDespacho = (ag: Agente, cuerpo: object) =>
    ag.post("/api/erp/combustible/despachos").send(cuerpo);
  const filasConUuid = async (tenantId: string, tabla: string, uuid: string) =>
    Number(
      (
        await withTenant(tenantId, (c) =>
          c.query(`SELECT count(*) AS n FROM ${tabla} WHERE tenant_id = $1 AND cliente_uuid = $2`, [
            tenantId,
            uuid,
          ])
        )
      ).rows[0].n
    );

  // ── Lo que debe seguir igual ──────────────────────────────────────────

  it("el reintento fiel (mismo cuerpo) devuelve el mismo registro y no duplica", async () => {
    const uuid = randomUUID();
    const cuerpo = despacho(10, uuid);
    const r1 = await postDespacho(A, cuerpo);
    const r2 = await postDespacho(A, cuerpo);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    expect(await filasConUuid(tA, "combustible_despachos", uuid)).toBe(1);
  });

  it("un reintento a mano con la hora recalculada sigue siendo el mismo registro (la hora no cuenta)", async () => {
    const uuid = randomUUID();
    const cuerpo = despacho(10, uuid, { despachado_en: hace(2) });
    const r1 = await postDespacho(A, cuerpo);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const r2 = await postDespacho(A, { ...cuerpo, despachado_en: hace(1.99) });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);

    const lectura = {
      cliente_uuid: randomUUID(),
      combustible_id: tanqueA,
      nivel: 3600,
      leido_en: hace(6),
    };
    expect((await A.post("/api/erp/combustible/lecturas").send(lectura)).status).toBe(201);
    const otraHora = await A.post("/api/erp/combustible/lecturas").send({
      ...lectura,
      leido_en: hace(5.9),
    });
    expect(otraHora.status, JSON.stringify(otraHora.body)).toBe(200);
  });

  it("la clave se guarda con su huella", async () => {
    const uuid = randomUUID();
    expect((await postDespacho(A, despacho(10, uuid))).status).toBe(201);
    const fila = (
      await withTenant(tA, (c) =>
        c.query(`SELECT huella FROM idempotency_keys WHERE tenant_id = $1 AND cliente_uuid = $2`, [
          tA,
          uuid,
        ])
      )
    ).rows[0];
    expect(fila.huella).toMatch(/^despacho:[0-9a-f]{16}$/);
  });

  it("una clave anterior, sin huella, sigue tomándose como reintento", async () => {
    const uuid = randomUUID();
    const r1 = await postDespacho(A, despacho(10, uuid));
    expect(r1.status).toBe(201);
    await withTenant(tA, (c) =>
      c.query(
        `UPDATE idempotency_keys SET huella = NULL WHERE tenant_id = $1 AND cliente_uuid = $2`,
        [tA, uuid]
      )
    );
    const r2 = await postDespacho(A, despacho(99, uuid));
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
  });

  // ── El código reusado para otra cosa ──────────────────────────────────

  it("el mismo código con otra cantidad da 409 y no cambia lo guardado", async () => {
    const uuid = randomUUID();
    const r1 = await postDespacho(A, despacho(10, uuid));
    expect(r1.status).toBe(201);
    const r2 = await postDespacho(A, despacho(70, uuid));
    expect(r2.status, JSON.stringify(r2.body)).toBe(409);
    expect(JSON.stringify(r2.body)).toMatch(/otro registro distinto/);
    expect(await filasConUuid(tA, "combustible_despachos", uuid)).toBe(1);
  });

  it("el código de una lectura usado en un despacho da 409, y al revés", async () => {
    const uuid1 = randomUUID();
    const lectura = await A.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: uuid1,
      combustible_id: tanqueA,
      nivel: 3000,
      leido_en: hace(3),
    });
    expect(lectura.status, JSON.stringify(lectura.body)).toBe(201);
    const aDespacho = await postDespacho(A, despacho(10, uuid1));
    expect(aDespacho.status, JSON.stringify(aDespacho.body)).toBe(409);

    const uuid2 = randomUUID();
    expect((await postDespacho(A, despacho(10, uuid2))).status).toBe(201);
    const aLectura = await A.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: uuid2,
      combustible_id: tanqueA,
      nivel: 2900,
      leido_en: hace(2),
    });
    expect(aLectura.status, JSON.stringify(aLectura.body)).toBe(409);
  });

  it("una lectura repetida: la misma se devuelve, otro nivel da 409", async () => {
    const uuid = randomUUID();
    const cuerpo = { cliente_uuid: uuid, combustible_id: tanqueA, nivel: 3500, leido_en: hace(4) };
    const r1 = await A.post("/api/erp/combustible/lecturas").send(cuerpo);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const r2 = await A.post("/api/erp/combustible/lecturas").send(cuerpo);
    expect(r2.status).toBe(200);
    const r3 = await A.post("/api/erp/combustible/lecturas").send({ ...cuerpo, nivel: 3400 });
    expect(r3.status, JSON.stringify(r3.body)).toBe(409);
    // Las lecturas no guardan el código en su fila: se cuentan por lo que registraron.
    const guardadas = await withTenant(tA, (c) =>
      c.query(
        `SELECT count(*) AS n FROM combustible_lecturas
          WHERE tenant_id = $1 AND combustible_id = $2 AND nivel IN (3500, 3400)`,
        [tA, tanqueA]
      )
    );
    expect(Number(guardadas.rows[0].n)).toBe(1);
  });

  it("una recepción repetida: la misma se devuelve, otro documento da 409", async () => {
    const uuid = randomUUID();
    const cuerpo = {
      cliente_uuid: uuid,
      combustible_id: tanqueA,
      grifo_id: grifoProveedorA,
      cantidad: 100,
      costo_unitario: 17,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: hace(5),
    };
    // una recepción exige una lectura vigente anterior
    expect(
      (
        await A.post("/api/erp/combustible/lecturas").send({
          combustible_id: tanqueA,
          nivel: 3000,
          leido_en: hace(20),
        })
      ).status
    ).toBe(201);
    const r1 = await A.post("/api/erp/combustible/recepciones").send(cuerpo);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const r2 = await A.post("/api/erp/combustible/recepciones").send(cuerpo);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    const r3 = await A.post("/api/erp/combustible/recepciones").send({
      ...cuerpo,
      numero_documento: idUnico("F"),
    });
    expect(r3.status, JSON.stringify(r3.body)).toBe(409);
  });

  it("un conteo de urea repetido: el mismo se devuelve, otras cajas dan 409", async () => {
    const uuid = randomUUID();
    const cuerpo = {
      cliente_uuid: uuid,
      lineas: [{ presentacion: "caja", cantidad_bultos: 4 }],
      suelto_litros: 0,
      contado_en: hace(2),
    };
    const r1 = await A.post("/api/erp/combustible/urea/conteos").send(cuerpo);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const r2 = await A.post("/api/erp/combustible/urea/conteos").send(cuerpo);
    expect(r2.status).toBe(200);
    const r3 = await A.post("/api/erp/combustible/urea/conteos").send({
      ...cuerpo,
      lineas: [{ presentacion: "caja", cantidad_bultos: 5 }],
    });
    expect(r3.status, JSON.stringify(r3.body)).toBe(409);
  });

  it("una compra en ruta repetida: la misma se devuelve, otra boleta da 409", async () => {
    const grifoRuta = (
      await A.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("RUTA"),
        abastece_ruta: true,
      })
    ).body.id;
    const grifoInterno = (await A.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const unidad = (
      await A.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: grifoInterno,
      })
    ).body.id;
    const uuid = randomUUID();
    const cuerpo = {
      cliente_uuid: uuid,
      grifo_id: grifoRuta,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      equipo_id: unidad,
      despachado_en: hace(1),
      total_boleta: 700,
      combustible: {
        tipo_combustible: "diesel_b5",
        cantidad: 40,
        costo_unitario: 17.5,
        lectura_horometro: 1500,
        horas_abastecidas: 12,
      },
    };
    const r1 = await A.post("/api/erp/combustible/compras-ruta").send(cuerpo);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const r2 = await A.post("/api/erp/combustible/compras-ruta").send(cuerpo);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    const r3 = await A.post("/api/erp/combustible/compras-ruta").send({
      ...cuerpo,
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
    });
    expect(r3.status, JSON.stringify(r3.body)).toBe(409);
    // La misma boleta con OTRAS cantidades tampoco es un reintento: el cambio no se pierde.
    const r4 = await A.post("/api/erp/combustible/compras-ruta").send({
      ...cuerpo,
      total_boleta: 1400,
      combustible: { ...cuerpo.combustible, cantidad: 80 },
    });
    expect(r4.status, JSON.stringify(r4.body)).toBe(409);
    // Y con otra hora (reintento a mano) sí es el mismo registro.
    const r5 = await A.post("/api/erp/combustible/compras-ruta").send({
      ...cuerpo,
      despachado_en: hace(0.9),
    });
    expect(r5.status, JSON.stringify(r5.body)).toBe(200);
  });

  // ── Carreras y empresas ───────────────────────────────────────────────

  it("tres envíos a la vez con el mismo código: uno solo gana, los otros 409, una fila", async () => {
    const uuid = randomUUID();
    const rs = await Promise.all([
      postDespacho(A, despacho(11, uuid)),
      postDespacho(A, despacho(12, uuid)),
      postDespacho(A, despacho(13, uuid)),
    ]);
    const estados = rs.map((r) => r.status).sort();
    expect(estados, JSON.stringify(rs.map((r) => r.body))).toEqual([201, 409, 409]);
    expect(await filasConUuid(tA, "combustible_despachos", uuid)).toBe(1);
  });

  it("tres envíos idénticos a la vez siguen siendo uno solo (201, 200, 200)", async () => {
    const uuid = randomUUID();
    const cuerpo = despacho(14, uuid);
    const rs = await Promise.all([
      postDespacho(A, cuerpo),
      postDespacho(A, cuerpo),
      postDespacho(A, cuerpo),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await filasConUuid(tA, "combustible_despachos", uuid)).toBe(1);
  });

  it("otra empresa con el mismo código no choca: cada una guarda lo suyo", async () => {
    const uuid = randomUUID();
    expect((await postDespacho(A, despacho(10, uuid))).status).toBe(201);
    const deB = await postDespacho(B, despacho(20, uuid, { combustible_id: tanqueB }));
    expect(deB.status, JSON.stringify(deB.body)).toBe(201);
    expect(await filasConUuid(tB, "combustible_despachos", uuid)).toBe(1);
  });
});
