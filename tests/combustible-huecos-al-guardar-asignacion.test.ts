/** tests/combustible-huecos-al-guardar-asignacion.test.ts
 *
 * Los vales que NO son un despacho --el de una asignación de tanqueta a unidad
 * (0141), el del retorno a otra unidad y el de las líneas de un reparto de
 * excedente (0140)-- hacen lo mismo que un despacho con el talonario:
 *  1. Un salto de más de 300 números se rechaza ANTES de guardar.
 *  2. Un salto menor deja una alerta de hueco por cada número que falta.
 *  3. Un vale que llena un hueco alertado lo resuelve; uno que llega por debajo
 *     del máximo sin que nadie lo esperara es "fuera de orden".
 *  4. Varias líneas de una misma recepción no se acusan entre sí.
 * Siempre con las alertas de siempre: ninguna alerta nueva.
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
  `G${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`.toUpperCase();
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
const numeros = (filas: Alerta[]) => filas.map((a) => a.n_vale).sort((a, b) => a - b);

describe("combustible: los vales de tanqueta revisan el talonario al guardarse", () => {
  let A: Contexto;
  let B: Contexto;

  beforeAll(async () => {
    A = await montar();
    B = await montar();
  });
  afterAll(async () => {
    await borrarTenantDePrueba(A.tenantId);
    await borrarTenantDePrueba(B.tenantId);
    await closeDatabase();
  });

  // ── 1. El tope de salto, antes de guardar ─────────────────────────────

  it("una asignación que salta más de 300 números se rechaza y no guarda nada", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const tanqueta = await tanquetaConSaldo(A);
    const unidad = await equipo(A);
    const r = await A.ag
      .put(`/api/erp/combustible/tanquetas/${tanqueta}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: s, n_vale: 500 });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/salta/);
    const fila = (await A.ag.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === tanqueta
    );
    expect(fila.equipo_asignado_id).toBeNull();
    expect(await alertas(A, s)).toEqual([]);
    // y con un número cercano, la misma tanqueta sí se asigna
    const bien = await A.ag
      .put(`/api/erp/combustible/tanquetas/${tanqueta}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: s, n_vale: 2 });
    expect(bien.status, JSON.stringify(bien.body)).toBe(200);
  });

  it("el retorno a otra unidad con un salto de más de 300 se rechaza y la tanqueta no se mueve", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const { r: asig, tanqueta } = await asignar(A, serieUnica(), 1);
    expect(asig.status, JSON.stringify(asig.body)).toBe(200);
    const destino = await equipo(A);
    const antes = (await A.ag.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === tanqueta
    );
    const r = await recibirTanqueta(A.ag, tanqueta, {
      destino: "unidad",
      unidad: { equipo_id: destino, serie_talonario: s, n_vale: 900 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/salta/);
    const despues = (await A.ag.get("/api/erp/combustible/tanquetas")).body.find(
      (t: { id: string }) => Number(t.id) === tanqueta
    );
    expect(despues.equipo_asignado_id).toBe(antes.equipo_asignado_id);
    expect(Number(despues.saldo)).toBe(Number(antes.saldo));
  });

  it("un reparto de excedente que salta más de 300 se rechaza entero", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const r = await recepcionConLineas(A, s, [2, 800]);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/reparto del excedente/);
    expect(await alertas(A, s)).toEqual([]);
  });

  it("el salto se mide por tanda: varias líneas que juntas pasan de 300 se rechazan, aunque cada una sola no", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const r = await recepcionConLineas(A, s, [150, 300, 450]);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/reparto del excedente/);
    expect(await alertas(A, s)).toEqual([]);

    // y una serie nueva con líneas muy separadas tampoco se cuela
    const nueva = serieUnica();
    const sola = await recepcionConLineas(A, nueva, [1, 400]);
    expect(sola.status, JSON.stringify(sola.body)).toBe(400);

    // el límite exacto (300 desde el último) sí entra
    const justo = await recepcionConLineas(A, s, [101, 201, 301]);
    expect(justo.status, JSON.stringify(justo.body)).toBe(201);
    expect((await alertas(A, s, "hueco_detectado")).length).toBe(297);
  });

  // ── 2. Hueco revelado ─────────────────────────────────────────────────

  it("una asignación que salta pocos números deja una alerta por cada hueco", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const { r } = await asignar(A, s, 4);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const huecos = await alertas(A, s, "hueco_detectado");
    expect(numeros(huecos)).toEqual([2, 3]);
    expect(huecos.every((h) => h.detalle.revelado_por_vale === 4)).toBe(true);
  });

  it("el retorno a otra unidad también revela los huecos", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const { r: asig, tanqueta } = await asignar(A, serieUnica(), 1);
    expect(asig.status).toBe(200);
    const r = await recibirTanqueta(A.ag, tanqueta, {
      destino: "unidad",
      unidad: { equipo_id: await equipo(A), serie_talonario: s, n_vale: 4 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(numeros(await alertas(A, s, "hueco_detectado"))).toEqual([2, 3]);
  });

  it("las líneas de una misma recepción no se acusan entre sí, y el salto entre ellas sí se avisa", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 10)).status).toBe(201);
    const seguidas = await recepcionConLineas(A, s, [13, 11, 12]);
    expect(seguidas.status, JSON.stringify(seguidas.body)).toBe(201);
    // 11, 12 y 13 en cualquier orden: ni huecos ni "fuera de orden".
    expect(await alertas(A, s)).toEqual([]);

    const conSalto = await recepcionConLineas(A, s, [14, 17]);
    expect(conSalto.status, JSON.stringify(conSalto.body)).toBe(201);
    expect(numeros(await alertas(A, s, "hueco_detectado"))).toEqual([15, 16]);
    expect((await alertas(A, s, "vale_fuera_de_orden")).length).toBe(0);
  });

  // ── 3. Resolver y fuera de orden ──────────────────────────────────────

  it("el vale que llena un hueco alertado lo resuelve; uno por debajo que nadie esperaba es fuera de orden", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 20)).status).toBe(201);
    expect((await asignar(A, s, 24)).r.status).toBe(200);
    expect(numeros(await alertas(A, s, "hueco_detectado"))).toEqual([21, 22, 23]);

    // el 22 llega a destiempo: era un hueco esperado
    expect((await asignar(A, s, 22)).r.status).toBe(200);
    const huecos = await alertas(A, s, "hueco_detectado");
    expect(huecos.find((h) => h.n_vale === 22)!.resuelta_en).not.toBeNull();
    expect(huecos.find((h) => h.n_vale === 21)!.resuelta_en).toBeNull();
    expect(await alertas(A, s, "vale_fuera_de_orden")).toEqual([]);

    // el 5 es de otra época del talonario y nadie lo esperaba
    const viejo = await asignar(A, s, 15);
    expect(viejo.r.status, JSON.stringify(viejo.r.body)).toBe(200);
    const fuera = await alertas(A, s, "vale_fuera_de_orden");
    expect(fuera.length).toBe(1);
    expect(fuera[0].n_vale).toBe(15);
    expect(fuera[0].detalle.maxAnteriorDeLaSerie).toBe(24);
  });

  it("un vale que llena un hueco ya congelado como anomalía deja un 'despacho tardío'", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 30)).status).toBe(201);
    expect((await asignar(A, s, 33)).r.status).toBe(200);
    await withTenant(A.tenantId, (cl) =>
      cl.query(
        `UPDATE combustible_alertas SET congelada_en = now()
          WHERE tenant_id = $1 AND serie_talonario = $2 AND n_vale = 31`,
        [A.tenantId, s]
      )
    );
    expect((await asignar(A, s, 31)).r.status).toBe(200);
    const tardios = await alertas(A, s, "despacho_tardio");
    expect(numeros(tardios)).toEqual([31]);
    // el hueco congelado no se toca
    const hueco31 = (await alertas(A, s, "hueco_detectado")).find((h) => h.n_vale === 31)!;
    expect(hueco31.resuelta_en).toBeNull();
  });

  // ── 4. Lo que no debe pasar ───────────────────────────────────────────

  it("un vale repetido se rechaza (409) y no crea alertas", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    expect((await asignar(A, s, 3)).r.status).toBe(200);
    const antes = (await alertas(A, s)).length;
    const repetido = await asignar(A, s, 3);
    expect(repetido.r.status).toBe(409);
    expect((await alertas(A, s)).length).toBe(antes);
  });

  it("la serie de otra empresa no se mezcla: ni alertas ni huecos ajenos", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    expect((await asignar(B, s, 3)).r.status).toBe(200);
    // en B es el primer vale de la serie: no hay con qué compararlo
    expect(await alertas(B, s)).toEqual([]);
    expect(await alertas(A, s)).toEqual([]);
  });

  it("dos asignaciones a la vez no duplican la alerta de ningún hueco", async () => {
    const s = serieUnica();
    expect((await despacho(A, s, 1)).status).toBe(201);
    const t1 = await tanquetaConSaldo(A);
    const t2 = await tanquetaConSaldo(A);
    const [u1, u2] = [await equipo(A), await equipo(A)];
    const [r1, r2] = await Promise.all([
      A.ag
        .put(`/api/erp/combustible/tanquetas/${t1}/asignar`)
        .send({ equipo_id: u1, serie_talonario: s, n_vale: 3 }),
      A.ag
        .put(`/api/erp/combustible/tanquetas/${t2}/asignar`)
        .send({ equipo_id: u2, serie_talonario: s, n_vale: 5 }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    // Límite conocido (igual que en los despachos): cada guardado mira el talonario
    // sin ver al otro, así que el 2 puede quedar sin avisar y, rara vez, el 3
    // (que sí existe) puede salir como hueco. Lo que no puede pasar es repetir una alerta.
    const n = numeros(await alertas(A, s, "hueco_detectado"));
    expect(new Set(n).size).toBe(n.length);
  });
});
