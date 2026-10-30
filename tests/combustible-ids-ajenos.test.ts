/** tests/combustible-ids-ajenos.test.ts
 *
 * Un vale que nombra un id de OTRA empresa (o que no existe) se rechaza con 400 y un
 * mensaje claro, y no deja nada guardado. Antes:
 *  - un tanque ajeno o inexistente daba 500 (todas las validaciones eran "si existe…");
 *  - una unidad ajena se GUARDABA (la FK de la tabla no mira la empresa).
 * Y el detalle del kardex dice a dónde fue cada vale, no el texto interno del destino.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const password = "ClaveDePrueba123";
type Agente = ReturnType<typeof request.agent>;
const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
let seq = 0;
const serieUnica = () =>
  `I${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`.toUpperCase();

describe("combustible: ids de otra empresa en un vale, y detalle del kardex", () => {
  const A = request.agent(app);
  const B = request.agent(app);
  let tA: string;
  let tB: string;
  let grifoA: number;
  let grifoB: number;
  let tanqueA: number;
  let tanqueB: number;
  const placaA = idUnico("VQ");
  let unidadA: number;
  let unidadB: number;
  let tanquetaA: number;
  let nVale = 1;

  const tanque = async (ag: Agente, grifo: number) =>
    Number(
      (
        await ag.post("/api/erp/combustible").send({
          codigo: idUnico("TQ"),
          tanque_nombre: "Tanque de los ids",
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
  const unidad = async (ag: Agente, grifo: number, placa = idUnico("VQ")) =>
    Number(
      (
        await ag.post("/api/erp/equipos").send({
          placa_codigo: placa,
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
          grifo_interno_id: grifo,
        })
      ).body.id
    );

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
    grifoA = (await A.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    grifoB = (await B.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    tanqueA = await tanque(A, grifoA);
    tanqueB = await tanque(B, grifoB);
    unidadA = await unidad(A, grifoA, placaA);
    unidadB = await unidad(B, grifoB);
    tanquetaA = Number(
      (await A.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: grifoA })).body.id
    );
  });
  afterAll(async () => {
    await borrarTenantDePrueba(tA);
    await borrarTenantDePrueba(tB);
    await closeDatabase();
  });

  const vale = (extra: Record<string, unknown>) => ({
    origen: "tanque_propio",
    tipo_combustible: "diesel_b5",
    cantidad: 10,
    lectura_contometro: 10,
    costo_unitario: 16,
    serie_talonario: serieUnica(),
    n_vale: nVale++,
    despachado_en: hace(3),
    ...extra,
  });
  const post = (ag: Agente, cuerpo: object) =>
    ag.post("/api/erp/combustible/despachos").send(cuerpo);
  const filasDe = async (tenantId: string) =>
    Number(
      (
        await withTenant(tenantId, (c) =>
          c.query(`SELECT count(*) AS n FROM combustible_despachos WHERE tenant_id = $1`, [
            tenantId,
          ])
        )
      ).rows[0].n
    );

  // ── Ids de otra empresa ───────────────────────────────────────────────

  it("un tanque de otra empresa, o que no existe, da 400 claro y no guarda nada", async () => {
    const antes = await filasDe(tB);
    for (const id of [tanqueA, 99999999]) {
      const r = await post(B, vale({ combustible_id: id, tipo_destino: "planta" }));
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(JSON.stringify(r.body)).toContain(`combustible_id ${id} no existe en este tenant`);
    }
    expect(await filasDe(tB)).toBe(antes);
    expect(await filasDe(tA)).toBe(0);
  });

  it("una unidad de otra empresa, o que no existe, da 400 claro y no guarda nada", async () => {
    const antes = await filasDe(tB);
    for (const id of [unidadA, 99999999]) {
      const r = await post(
        B,
        vale({
          combustible_id: tanqueB,
          tipo_destino: "equipo",
          equipo_id: id,
          lectura_horometro: 5,
        })
      );
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(JSON.stringify(r.body)).toContain(`equipo_id ${id} no existe en este tenant`);
    }
    expect(await filasDe(tB)).toBe(antes);
  });

  it("el mismo vale con ids propios sí se guarda", async () => {
    const r = await post(
      B,
      vale({
        combustible_id: tanqueB,
        tipo_destino: "equipo",
        equipo_id: unidadB,
        lectura_horometro: 5,
      })
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("una tanqueta, un proveedor o un surtidor de otra empresa también dan 400", async () => {
    const tanqueta = await post(
      B,
      vale({
        combustible_id: tanqueB,
        tipo_destino: "reserva_cubeta",
        tanqueta_destino_id: tanquetaA,
        serie_talonario: undefined,
        n_vale: undefined,
        cliente_uuid: crypto.randomUUID(),
      })
    );
    expect(tanqueta.status, JSON.stringify(tanqueta.body)).toBe(400);
    const surtidor = await post(
      B,
      vale({ combustible_id: tanqueB, tipo_destino: "planta", surtidor_id: 99999999 })
    );
    expect(surtidor.status, JSON.stringify(surtidor.body)).toBe(400);
    const proveedor = await post(B, {
      origen: "compra_externa",
      tipo_combustible: "diesel_b5",
      grifo_id: 99999999,
      tipo_destino: "equipo",
      equipo_id: unidadB,
      cantidad: 10,
      costo_unitario: 16,
      comprobante_tipo: "boleta",
      comprobante_numero: "B001-77",
      lectura_horometro: 5,
      horas_abastecidas: 1,
    });
    expect(proveedor.status, JSON.stringify(proveedor.body)).toBe(400);
  });

  it("un id más grande que un entero de la base da 400, no 500", async () => {
    const malos: string[] = [];
    const casos: Array<[string, Record<string, unknown>]> = [
      ["combustible_id", { combustible_id: 2147483648, tipo_destino: "planta" }],
      ["combustible_id 1e20", { combustible_id: 1e20, tipo_destino: "planta" }],
      [
        "equipo_id",
        {
          combustible_id: tanqueB,
          tipo_destino: "equipo",
          equipo_id: 2147483648,
          lectura_horometro: 5,
        },
      ],
      [
        "equipo_id 1e20",
        { combustible_id: tanqueB, tipo_destino: "equipo", equipo_id: 1e20, lectura_horometro: 5 },
      ],
      ["surtidor_id", { combustible_id: tanqueB, tipo_destino: "planta", surtidor_id: 2147483648 }],
      [
        "tanqueta_destino_id 1e20",
        {
          combustible_id: tanqueB,
          tipo_destino: "reserva_cubeta",
          tanqueta_destino_id: 1e20,
          serie_talonario: undefined,
          n_vale: undefined,
          cliente_uuid: crypto.randomUUID(),
        },
      ],
      [
        "tanqueta_origen_id 1e20",
        {
          origen: "tanqueta",
          tanqueta_origen_id: 1e20,
          tanqueta_lugar: "planta",
          tipo_destino: "equipo",
          equipo_id: unidadB,
          serie_talonario: serieUnica(),
          n_vale: nVale++,
        },
      ],
      [
        "excedente_linea_id 1e20",
        {
          origen: "excedente_recepcion",
          excedente_linea_id: 1e20,
          tipo_destino: "equipo",
          equipo_id: unidadB,
        },
      ],
    ];
    for (const [nombre, extra] of casos) {
      const r = await post(B, vale(extra));
      if (r.status !== 400) malos.push(`${nombre}: ${r.status}`);
    }
    const proveedor = await post(B, {
      origen: "compra_externa",
      tipo_combustible: "diesel_b5",
      grifo_id: 2147483648,
      tipo_destino: "equipo",
      equipo_id: unidadB,
      cantidad: 10,
      costo_unitario: 16,
      comprobante_tipo: "boleta",
      comprobante_numero: "B001-88",
      lectura_horometro: 5,
      horas_abastecidas: 1,
    });
    if (proveedor.status !== 400) malos.push(`grifo_id: ${proveedor.status}`);
    expect(malos).toEqual([]);
  });

  it("una lectura o una recepción con un tanque de otra empresa dan 400", async () => {
    const lectura = await B.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanqueA,
      nivel: 100,
      leido_en: hace(1),
    });
    expect(lectura.status).toBe(400);
    const recepcion = await B.post("/api/erp/combustible/recepciones").send({
      combustible_id: tanqueA,
      grifo_id: 99999999,
      cantidad: 10,
      costo_unitario: 17,
      tipo_documento: "factura",
      numero_documento: "F-1",
      recibido_en: hace(1),
    });
    expect(recepcion.status).toBe(400);
  });

  // ── Detalle del kardex ────────────────────────────────────────────────

  const kardex = async (ag: Agente, tanqueId: number) =>
    (
      await ag
        .get(`/api/erp/combustible/${tanqueId}/kardex`)
        .query({ desde: hace(45), hasta: hace(0.2) })
    ).body.filas as { tipo: string; referencia_id: string; detalle: string | null }[];

  it("el detalle dice a dónde fue cada vale: tanqueta, unidad con conductor, planta", async () => {
    const t = await tanque(A, grifoA);
    const tq = Number(
      (await A.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: grifoA })).body.id
    );
    const codigoTanqueta = (await A.get("/api/erp/combustible/tanquetas")).body.find(
      (x: { id: string }) => Number(x.id) === tq
    ).codigo as string;
    const placa = placaA;

    const aTanqueta = await post(
      A,
      vale({
        combustible_id: t,
        tipo_destino: "reserva_cubeta",
        tanqueta_destino_id: tq,
        serie_talonario: undefined,
        n_vale: undefined,
        cliente_uuid: crypto.randomUUID(),
      })
    );
    expect(aTanqueta.status, JSON.stringify(aTanqueta.body)).toBe(201);
    const aUnidad = await post(
      A,
      vale({ combustible_id: t, tipo_destino: "equipo", equipo_id: unidadA, lectura_horometro: 8 })
    );
    expect(aUnidad.status, JSON.stringify(aUnidad.body)).toBe(201);
    const aUnidadConConductor = await post(
      A,
      vale({ combustible_id: t, tipo_destino: "equipo", equipo_id: unidadA, lectura_horometro: 9 })
    );
    expect(aUnidadConConductor.status).toBe(201);
    await withTenant(tA, (c) =>
      c.query(
        `UPDATE combustible_despachos SET conductor_nombre = 'Juan Pérez' WHERE tenant_id = $1 AND id = $2`,
        [tA, aUnidadConConductor.body.id]
      )
    );
    const aPlanta = await post(A, vale({ combustible_id: t, tipo_destino: "planta" }));
    expect(aPlanta.status).toBe(201);

    const filas = await kardex(A, t);
    const detalleDe = (id: string | number) =>
      filas.find((f) => f.referencia_id === String(id) && f.tipo !== "lectura")?.detalle;
    expect(detalleDe(aTanqueta.body.id)).toBe(`A tanqueta ${codigoTanqueta}`);
    expect(detalleDe(aUnidad.body.id)).toBe(placa);
    expect(detalleDe(aUnidadConConductor.body.id)).toBe(`${placa} · conductor Juan Pérez`);
    expect(detalleDe(aPlanta.body.id)).toBe("Consumo en planta");

    // y el CSV lleva los mismos textos
    const csv = await A.get(`/api/erp/combustible/${t}/kardex/csv`).query({
      desde: hace(45),
      hasta: hace(0.2),
    });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`A tanqueta ${codigoTanqueta}`);
    expect(csv.text).toContain("Consumo en planta");
    expect(csv.text).toContain(`${placa} · conductor Juan Pérez`);
    expect(csv.text).not.toContain("reserva_cubeta");
  });
});
