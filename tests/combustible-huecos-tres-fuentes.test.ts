/** tests/combustible-huecos-tres-fuentes.test.ts
 *
 * El control de huecos del talonario mira los números de TRES fuentes juntas:
 * los despachos, las líneas de excedente a tanqueta (0140) y las asignaciones
 * de tanqueta a unidad (0141). Si solo mirara los despachos, el vale 101 de una
 * asignación entre el 100 y el 102 de dos despachos saldría como un hueco que
 * no es.
 *
 * Lo que fija este archivo:
 * 1. Una secuencia mezclada, sin huecos falsos; el hueco real sí aparece.
 * 2. Un papel anulado cuenta como rendido (despacho o recepción).
 * 3. Cada serie, cada producto y cada empresa tiene su propia lista.
 * 4. Los otros tres lectores (máximo, vale fuera de orden, hueco revelado)
 *    ven las tres fuentes, y el despacho que se excluye es SOLO ese despacho.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { CombustibleRepository } from "../src/modules/combustible/combustible.repository";

let seq = 0;
const serieUnica = () => `H${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

type Agente = ReturnType<typeof request.agent>;
interface Contexto {
  tenantId: string;
  ag: Agente;
  principal: number;
  proveedor: number;
  tanque: number;
}

const password = "ClaveDePrueba123";

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
      tanque_nombre: "Tanque de los huecos",
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

// Cada fuente, con el número que se le pide.
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

/** Una tanqueta con saldo (traspaso sin vale) asignada a una unidad nueva con su vale. */
async function asignacion(c: Contexto, serie: string, n: number) {
  const tanqueta = Number(
    (await c.ag.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: c.principal })).body
      .id
  );
  const unidad = await equipo(c);
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
  const r = await c.ag
    .put(`/api/erp/combustible/tanquetas/${tanqueta}/asignar`)
    .send({ equipo_id: unidad, serie_talonario: serie, n_vale: n });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Un reparto de excedente que manda una tanqueta a una unidad con su vale. */
async function linea(c: Contexto, serie: string, n: number) {
  const tanqueta = Number(
    (await c.ag.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: c.principal })).body
      .id
  );
  const unidad = await equipo(c);
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
  const r = await c.ag.post("/api/erp/combustible/recepciones").send({
    combustible_id: fuente,
    grifo_id: c.proveedor,
    cantidad: 280,
    costo_unitario: 17,
    recibido_en: new Date().toISOString(),
    reparto_excedente: [
      {
        destino: "cubeta",
        cantidad: 280,
        tanqueta_id: tanqueta,
        tanqueta_equipo_id: unidad,
        serie_talonario: serie,
        n_vale: n,
      },
    ],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as number;
}

const huecos = async (c: Contexto, serie: string, producto?: string) =>
  (
    await c.ag
      .get("/api/erp/combustible/despachos/huecos")
      .query({ serie_talonario: serie, ...(producto ? { producto } : {}) })
  ).body as { serie: string; huecos: number[]; ultimo: number | null };

describe("combustible: el control de huecos junta despachos, asignaciones y excedentes", () => {
  let A: Contexto;
  let B: Contexto;
  const repo = new CombustibleRepository();

  beforeAll(async () => {
    A = await montar();
    B = await montar();
  });

  afterAll(async () => {
    await borrarTenantDePrueba(A.tenantId);
    await borrarTenantDePrueba(B.tenantId);
    await closeDatabase();
  });

  // ── 1. La secuencia mezclada ──────────────────────────────────────────

  it("100 despacho, 101 asignación, 102 excedente, 103 despacho: sin huecos", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 100)).status).toBe(201);
    await asignacion(A, s, 101);
    await linea(A, s, 102);
    expect((await despacho(A, s, 103)).status).toBe(201);
    expect(await huecos(A, s)).toEqual({ serie: s, huecos: [], ultimo: 103 });
  });

  it("el hueco real sí aparece, y los números de otra fuente no lo tapan", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    await asignacion(A, s, 2);
    await linea(A, s, 5);
    expect((await despacho(A, s, 6)).status).toBe(201);
    expect((await huecos(A, s)).huecos).toEqual([3, 4]);
  });

  it("un número de asignación llena el hueco entre dos despachos", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 10)).status).toBe(201);
    expect((await despacho(A, s, 12)).status).toBe(201);
    expect((await huecos(A, s)).huecos).toEqual([11]);
    await asignacion(A, s, 11);
    expect((await huecos(A, s)).huecos).toEqual([]);
  });

  it("una serie que solo tiene asignaciones y excedentes también se controla", async () => {
    const s = serieUnica();
    await asignacion(A, s, 20);
    await linea(A, s, 22);
    expect(await huecos(A, s)).toEqual({ serie: s, huecos: [21], ultimo: 22 });
  });

  // ── 2. Anulado = rendido ──────────────────────────────────────────────

  it("un despacho anulado y una recepción anulada cuentan como papel rendido", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 30)).status).toBe(201);
    const anulado = await despacho(A, s, 31);
    expect(anulado.status).toBe(201);
    const recepcionId = await linea(A, s, 32);
    expect((await despacho(A, s, 33)).status).toBe(201);
    expect(
      (
        await A.ag
          .patch(`/api/erp/combustible/despachos/${anulado.body.id}/anular`)
          .send({ motivo: "se tipeó mal" })
      ).status
    ).toBe(200);
    const anulaRecepcion = await A.ag
      .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
      .send({ motivo: "se tipeó mal" });
    // Si la recepción no se puede anular en este escenario, el test no prueba lo que dice.
    expect(anulaRecepcion.status, JSON.stringify(anulaRecepcion.body)).toBe(200);
    expect((await huecos(A, s)).huecos).toEqual([]);
  });

  // ── 3. Cada serie, producto y empresa con su lista ────────────────────

  it("los números de una serie no llenan los huecos de otra", async () => {
    const s1 = serieUnica();
    const s2 = serieUnica();
    expect((await despacho(A, s1, 1)).status).toBe(201);
    expect((await despacho(A, s1, 3)).status).toBe(201);
    await asignacion(A, s2, 2);
    expect((await huecos(A, s1)).huecos).toEqual([2]);
  });

  it("otra empresa con la misma serie y el número que falta no tapa el hueco", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    expect((await despacho(A, s, 3)).status).toBe(201);
    await asignacion(B, s, 2);
    expect((await despacho(B, s, 3)).status).toBe(201);
    expect((await huecos(A, s)).huecos).toEqual([2]);
    // y la de la otra empresa solo ve lo suyo
    expect((await huecos(B, s)).ultimo).toBe(3);
  });

  it("las asignaciones de combustible no entran a la lista de la urea", async () => {
    const s = serieUnica();
    await asignacion(A, s, 7);
    const urea = await withTenant(A.tenantId, (cl) =>
      repo.findHuecosTalonario(cl, A.tenantId, "urea", s)
    );
    expect(urea).toEqual({ serie: s, huecos: [], ultimo: null });
    expect((await huecos(A, s, "urea")).ultimo).toBeNull();
  });

  // ── 4. Los otros lectores ─────────────────────────────────────────────

  it("el tope de salto cuenta el máximo de las tres fuentes", async () => {
    const s = serieUnica();
    await asignacion(A, s, 10);
    const salta = await despacho(A, s, 500);
    expect(salta.status).toBe(400);
    expect(JSON.stringify(salta.body)).toMatch(/salta/);
    expect((await despacho(A, s, 11)).status).toBe(201);
  });

  it("el máximo, el vale fuera de orden y el hueco revelado ven las tres fuentes", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 50)).status).toBe(201);
    await asignacion(A, s, 52);
    const nuevo = await despacho(A, s, 53);
    expect(nuevo.status).toBe(201);
    const fuera = await despacho(A, s, 40);
    expect(fuera.status).toBe(201);

    const lectores = await withTenant(A.tenantId, async (cl) => ({
      maximo: await repo.findMaxNValeDeSerie(cl, A.tenantId, "combustible", s),
      // El 53 se registró con la asignación 52 ya en la serie: no revela nada nuevo.
      reveladosPor53: await repo.detectarHuecosRevelados(
        cl,
        A.tenantId,
        "combustible",
        s,
        Number(nuevo.body.id),
        53
      ),
      // El 40 llegó por debajo del máximo, que viene de la asignación... y del 53.
      fueraDeOrden: await repo.detectarValeFueraDeOrden(
        cl,
        A.tenantId,
        "combustible",
        s,
        Number(fuera.body.id),
        40
      ),
    }));
    expect(lectores.maximo).toBe(53);
    expect(lectores.reveladosPor53).toEqual([]);
    expect(lectores.fueraDeOrden).toBe(53);
  });

  it("el despacho que se excluye es solo ese despacho: un id igual en otra tabla no cuenta", async () => {
    const s = serieUnica();
    await asignacion(A, s, 60);
    const ids = await withTenant(A.tenantId, (cl) =>
      cl.query<{ id: string }>(
        `SELECT id FROM combustible_tanqueta_asignaciones WHERE tenant_id = $1 AND serie_talonario = $2`,
        [A.tenantId, s]
      )
    );
    const idAsignacion = Number(ids.rows[0].id);
    // Si se excluyera por id a secas, el id de la asignación se comería el 60.
    const max = await withTenant(A.tenantId, (cl) =>
      repo.detectarValeFueraDeOrden(cl, A.tenantId, "combustible", s, idAsignacion, 10)
    );
    expect(max).toBe(60);
    const revelados = await withTenant(A.tenantId, (cl) =>
      repo.detectarHuecosRevelados(cl, A.tenantId, "combustible", s, idAsignacion, 64)
    );
    expect(revelados).toEqual([61, 62, 63]);
  });
});
