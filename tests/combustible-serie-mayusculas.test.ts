/** tests/combustible-serie-mayusculas.test.ts
 *
 * La serie del talonario se guarda SIEMPRE en mayúsculas: "a3" y "A3" son el mismo
 * talonario. Si no, el control de huecos las tomaría por series distintas y
 * armaría huecos falsos (o dejaría esquivar el tope de salto cambiando una letra).
 * Vale para todo lo que registra un vale: despacho, asignación, retorno a otra
 * unidad y línea de excedente, y para las consultas por serie.
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

let seq = 0;
const serieUnica = () =>
  `M${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`.toUpperCase();
const password = "ClaveDePrueba123";

type Agente = ReturnType<typeof request.agent>;
interface Contexto {
  tenantId: string;
  ag: Agente;
  principal: number;
  proveedor: number;
  tanque: number;
}

async function montar(): Promise<Contexto> {
  const creado = await crearTenantDePrueba(password);
  const ag = request.agent(app);
  await ag
    .post("/api/auth/login")
    .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  const principal = (await ag.get("/api/erp/sedes")).body.sedes[0].grifos[0].id as number;
  const proveedor = (await ag.post("/api/erp/combustible/grifos").send({ nombre: idUnico("CIS") }))
    .body.id as number;
  const tanque = (
    await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de los vales",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: principal,
    })
  ).body.id as number;
  return { tenantId: creado.tenant.id, ag, principal, proveedor, tanque };
}

const equipo = async (c: Contexto) =>
  (
    await c.ag.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "horometro",
      grifo_interno_id: c.principal,
    })
  ).body.id as number;

const despacho = (c: Contexto, serie: string, n: number) =>
  c.ag.post("/api/erp/combustible/despachos").send({
    origen: "tanque_propio",
    combustible_id: c.tanque,
    tipo_combustible: "diesel_b5",
    tipo_destino: "planta",
    serie_talonario: serie,
    n_vale: n,
    cantidad: 10,
    lectura_contometro: 10,
    costo_unitario: 16,
  });

/** Una tanqueta con 20 gal, sin unidad todavía. */
async function tanquetaConSaldo(c: Contexto) {
  const tanqueta = Number(
    (await c.ag.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: c.principal })).body
      .id
  );
  const llenado = await c.ag.post("/api/erp/combustible/despachos").send({
    cliente_uuid: crypto.randomUUID(),
    origen: "tanque_propio",
    combustible_id: c.tanque,
    tipo_combustible: "diesel_b5",
    tipo_destino: "reserva_cubeta",
    tanqueta_destino_id: tanqueta,
    cantidad: 20,
    lectura_contometro: 20,
    costo_unitario: 16,
  });
  expect(llenado.status, JSON.stringify(llenado.body)).toBe(201);
  return tanqueta;
}

/** Asigna una tanqueta con saldo a una unidad nueva, con su vale. */
async function asignar(c: Contexto, serie: string, n: number) {
  const tanqueta = await tanquetaConSaldo(c);
  const unidad = await equipo(c);
  const r = await c.ag
    .put(`/api/erp/combustible/tanquetas/${tanqueta}/asignar`)
    .send({ equipo_id: unidad, serie_talonario: serie, n_vale: n });
  return { r, tanqueta };
}

/** Una recepción cuyo excedente reparte una tanqueta a una unidad por cada vale. */
async function recepcionConLineas(c: Contexto, serie: string, vales: number[]) {
  const reparto = [];
  for (const n of vales) {
    reparto.push({
      destino: "cubeta",
      cantidad: 280,
      tanqueta_id: Number(
        (await c.ag.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: c.principal }))
          .body.id
      ),
      tanqueta_equipo_id: await equipo(c),
      serie_talonario: serie,
      n_vale: n,
    });
  }
  const fuente = (
    await c.ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque cancha",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 2000,
      nivel_actual: 2000,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: c.principal,
    })
  ).body.id as number;
  return c.ag.post("/api/erp/combustible/recepciones").send({
    combustible_id: fuente,
    grifo_id: c.proveedor,
    cantidad: 280 * vales.length,
    costo_unitario: 17,
    recibido_en: new Date().toISOString(),
    reparto_excedente: reparto,
  });
}

interface Alerta {
  tipo: string;
  n_vale: number;
  detalle: Record<string, unknown>;
  resuelta_en: string | null;
}
const alertas = async (c: Contexto, serie: string, tipo?: string) =>
  (
    await withTenant(c.tenantId, (cl) =>
      cl.query<Alerta>(
        `SELECT tipo, n_vale, detalle, resuelta_en FROM combustible_alertas
          WHERE tenant_id = $1 AND serie_talonario = $2 ${tipo ? "AND tipo = $3" : ""}
          ORDER BY id`,
        tipo ? [c.tenantId, serie, tipo] : [c.tenantId, serie]
      )
    )
  ).rows;

const filaDeSerie = async (c: Contexto, tabla: string, serie: string) =>
  (
    await withTenant(c.tenantId, (cl) =>
      cl.query<{ serie_talonario: string }>(
        `SELECT serie_talonario FROM ${tabla} WHERE tenant_id = $1 AND upper(serie_talonario) = $2`,
        [c.tenantId, serie]
      )
    )
  ).rows.map((f) => f.serie_talonario);

describe("combustible: la serie del talonario no distingue mayúsculas", () => {
  let A: Contexto;
  beforeAll(async () => {
    A = await montar();
  });
  afterAll(async () => {
    await borrarTenantDePrueba(A.tenantId);
  });

  it("un despacho con la serie en minúsculas (y espacios) se guarda en mayúsculas", async () => {
    const s = serieUnica();
    const r = await despacho(A, `  ${s.toLowerCase()} `, 1);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.serie_talonario).toBe(s);
    expect(await filaDeSerie(A, "combustible_despachos", s)).toEqual([s]);
  });

  it("'a3' y 'A3' son el mismo talonario: no repiten número y no arman huecos", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const repetido = await despacho(A, s.toLowerCase(), 1);
    expect(repetido.status).toBe(409);
    expect(JSON.stringify(repetido.body)).toMatch(/ya está registrado/);
    expect((await despacho(A, s.toLowerCase(), 2)).status).toBe(201);
    expect((await despacho(A, s, 3)).status).toBe(201);
    const h = await A.ag
      .get("/api/erp/combustible/despachos/huecos")
      .query({ serie_talonario: s.toLowerCase() });
    expect(h.body).toEqual({ serie: s, huecos: [], ultimo: 3 });
    expect(await alertas(A, s)).toEqual([]);
  });

  it("cambiar una mayúscula ya no esquiva el tope de salto", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const salta = await despacho(A, s.toLowerCase(), 5000);
    expect(salta.status).toBe(400);
    expect(JSON.stringify(salta.body)).toMatch(/salta/);
    const { r } = await asignar(A, s.toLowerCase(), 5000);
    expect(r.status).toBe(400);
  });

  it("la asignación y el retorno a otra unidad guardan la serie en mayúsculas", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const { r, tanqueta } = await asignar(A, s.toLowerCase(), 2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await filaDeSerie(A, "combustible_tanqueta_asignaciones", s)).toEqual([s]);

    const otra = serieUnica();
    const retorno = await recibirTanqueta(A.ag, tanqueta, {
      destino: "unidad",
      unidad: { equipo_id: await equipo(A), serie_talonario: otra.toLowerCase(), n_vale: 1 },
    });
    expect(retorno.status, JSON.stringify(retorno.body)).toBe(201);
    expect(await filaDeSerie(A, "combustible_tanqueta_asignaciones", otra)).toEqual([otra]);
  });

  it("la línea del reparto de excedente guarda la serie en mayúsculas", async () => {
    const s = serieUnica();
    const rec = await recepcionConLineas(A, s.toLowerCase(), [1]);
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(await filaDeSerie(A, "combustible_recepcion_excedentes", s)).toEqual([s]);
  });

  it("el historial de despachos encuentra la serie escribiéndola en minúsculas", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const lista = await A.ag
      .get("/api/erp/combustible/despachos")
      .query({ serie_talonario: s.toLowerCase() });
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    expect(lista.body.data.length).toBe(1);
    expect(lista.body.data[0].serie_talonario).toBe(s);
  });

  it("una serie que al pasar a mayúsculas se alarga de más (ß) da 400, no 500", async () => {
    const r = await despacho(A, "ß".repeat(15), 1);
    expect(r.status).toBe(400);
  });

  it("la serie lleva solo letras, números y guion entre grupos: lo demás da 400 y no guarda nada", async () => {
    const base = serieUnica();
    const malas: Record<string, string> = {
      "A cirílica": base.replace(/^./, "\u0410"),
      "A de ancho completo": base.replace(/^./, "\uFF21"),
      "É descompuesta": "\u00C9".normalize("NFD") + base,
      "byte nulo": "A\u00003",
      "espacio dentro": "A 3",
      barra: "A/3",
      punto: "A.3",
      "guion al inicio": "-A3",
      "guion al final": "A3-",
      "guion doble": "A--3",
      "solo un guion": "-",
    };
    for (const [nombre, serie] of Object.entries(malas)) {
      const r = await despacho(A, serie, 1);
      expect(r.status, nombre).toBe(400);
      expect(JSON.stringify(r.body), nombre).toMatch(/letras, números y guion/);
    }
    const t = await tanquetaConSaldo(A);
    const unidad = await equipo(A);
    const asignacion = await A.ag
      .put(`/api/erp/combustible/tanquetas/${t}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: "A\u00003", n_vale: 1 });
    expect(asignacion.status).toBe(400);
    expect(await filaDeSerie(A, "combustible_despachos", "A 3")).toEqual([]);
  });

  it("una serie con guion (A-2, t-01-b) se acepta, se guarda en mayúsculas y cuenta como una sola", async () => {
    const s = `${serieUnica()}-2`;
    const r = await despacho(A, s.toLowerCase(), 1);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.serie_talonario).toBe(s);
    expect((await despacho(A, s, 1)).status).toBe(409);
    expect((await despacho(A, s, 3)).status).toBe(201);
    const h = await A.ag
      .get("/api/erp/combustible/despachos/huecos")
      .query({ serie_talonario: s.toLowerCase() });
    expect(h.body).toEqual({ serie: s, huecos: [2], ultimo: 3 });
  });

  it("las consultas por serie con caracteres que nunca se guardan dan 400, no 500", async () => {
    for (const url of [
      "/api/erp/combustible/despachos/huecos?serie_talonario=%00",
      "/api/erp/combustible/despachos/huecos?serie_talonario=A%2F3",
      "/api/erp/combustible/despachos?serie_talonario=%00",
      "/api/erp/combustible/despachos?serie_talonario=A%203",
    ]) {
      expect((await A.ag.get(url)).status, url).toBe(400);
    }
  });
});

describe("combustible: la serie de un vale de urea también se guarda en mayúsculas", () => {
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let tenantId: string;
  let equipoId: number;
  let grifoUrea: number;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    equipoId = (
      await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("UE"), tipo: "VOLQUETE" })
    ).body.id;
    grifoUrea = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREAMAY"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
    const entrada = await agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      tipo_documento: "factura",
      numero_documento: `F-${Math.floor(Math.random() * 1e8)}`,
      lineas: [{ presentacion: "caja", cantidad_bultos: 5, costo_unitario: 90 }],
      recibido_en: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(201);
  });
  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const vale = (serie: string, n: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "almacen",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: n,
      lineas: [{ presentacion: "caja", cantidad_bultos: 1 }],
      despachado_en: new Date(Date.now() - 5 * 86400000).toISOString(),
    });

  it("un vale de urea con la serie en minúsculas se guarda en mayúsculas y no repite número", async () => {
    const s = serieUnica();
    const r = await vale(s.toLowerCase(), 1);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.fila?.serie_talonario ?? r.body.serie_talonario).toBe(s);
    expect((await vale(s, 1)).status).toBe(409);
    expect((await vale(s.toLowerCase(), 2)).status).toBe(201);
    const h = await agente
      .get("/api/erp/combustible/despachos/huecos")
      .query({ serie_talonario: s.toLowerCase(), producto: "urea" });
    expect(h.body).toEqual({ serie: s, huecos: [], ultimo: 2 });
  });
});
