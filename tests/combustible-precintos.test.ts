/** tests/combustible-precintos.test.ts
 *
 * Precintos numerados del tanque (migración 0095): el control del robo por
 * FUERA del surtidor. Cada ataque va con su GEMELO de control -- si el gemelo
 * también alertara, el "alertó" del ataque no probaría nada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

const haceMin = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface Alerta {
  tipo: string;
  combustible_id: number | null;
  detalle: Record<string, unknown>;
}

describe("combustible: precintos numerados", () => {
  let tenantId: string;
  let slug: string;
  let grifoId: number;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const operador = request.agent(app);
  const grifero = request.agent(app);
  let seq = 0;

  async function altaYLogin(agente: ReturnType<typeof request.agent>, rol: string) {
    const dni = String(85100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    const entro = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entro.status).toBe(200);
  }

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    const grifo = await admin
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("Prov"), abastece_tanque: true });
    grifoId = grifo.body.id;
    await altaYLogin(operador, "operador");
    await altaYLogin(grifero, "grifero");
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Tanque sin umbrales de descuadre: acá solo interesan los precintos, y
   *  un descuadre de varilla sería ruido en las alertas. */
  async function tanque(usaPrecintos = true) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque precintado",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "personalizado",
      umbral_diferencia_pct: null,
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
      usa_precintos: usaPrecintos,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const numeroUnico = () => String(Math.floor(Math.random() * 1e9));

  async function punto(tq: number, nombre: string, numero: string, seAbre = false) {
    const r = await admin
      .post(`/api/erp/combustible/${tq}/precintos/puntos`)
      .send({ nombre, numero, se_abre_en_recepcion: seAbre });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const varilla = (
    tq: number,
    precintos?: { punto_id: number; numero: string | null }[],
    leidoEn = new Date().toISOString(),
    ag = admin
  ) =>
    ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel: 10000, leido_en: leidoEn, precintos });

  async function alertas(tq: number, tipo: string) {
    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    return (r.body.data as Alerta[]).filter((a) => a.tipo === tipo && a.combustible_id === tq);
  }

  it("un tanque sin precintos no pide nada y descarta lo que venga", async () => {
    const tq = await tanque(false);
    expect((await varilla(tq)).status).toBe(201);
    // La varilla offline que se cargó con el control prendido y llega
    // después de apagarlo: perderla sería peor que ignorar el dato.
    expect((await varilla(tq, [{ punto_id: 999999, numero: "1" }])).status).toBe(201);
  });

  it("con precintos, la varilla sin el número del punto se rechaza", async () => {
    const tq = await tanque();
    await punto(tq, "Drenaje", numeroUnico());
    const r = await varilla(tq);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Drenaje/);
  });

  it("el precinto que coincide no alerta; el que no coincide o falta, sí", async () => {
    const tq = await tanque();
    const n = numeroUnico();
    const drenaje = await punto(tq, "Drenaje", n);

    // Gemelo: mismo sello, tipeado con ceros y guiones.
    expect((await varilla(tq, [{ punto_id: drenaje, numero: `00-${n}` }])).status).toBe(201);
    expect(await alertas(tq, "precinto_alterado")).toHaveLength(0);

    // Ataque: alguien cortó el sello y puso otro que no registró.
    expect((await varilla(tq, [{ punto_id: drenaje, numero: "777" }])).status).toBe(201);
    const [alerta] = await alertas(tq, "precinto_alterado");
    expect(alerta).toBeDefined();
    const puntos = alerta.detalle.puntos as { numero_visto: string; numero_esperado: string }[];
    expect(puntos[0]).toMatchObject({ numero_visto: "777", numero_esperado: n });

    // La varilla siguiente ve lo mismo: es el mismo sello, no otro robo. Se
    // actualiza la alerta abierta en vez de crear otra.
    expect((await varilla(tq, [{ punto_id: drenaje, numero: null }])).status).toBe(201);
    const despues = await alertas(tq, "precinto_alterado");
    expect(despues).toHaveLength(1);
    const ultimos = despues[0].detalle.puntos as { numero_visto: string | null }[];
    expect(ultimos[0].numero_visto).toBeNull();
  });

  it("la recepción exige el sello nuevo de la boca que se abre, y no alerta por eso", async () => {
    const tq = await tanque();
    const nBoca = numeroUnico();
    const boca = await punto(tq, "Boca de llenado", nBoca, true);
    const recibir = (precintos?: { punto_id: number; numero: string }[]) =>
      admin.post("/api/erp/combustible/recepciones").send({
        combustible_id: tq,
        grifo_id: grifoId,
        cantidad: 1000,
        costo_unitario: 16.8,
        precintos,
      });

    const sin = await recibir();
    expect(sin.status).toBe(400);
    expect(sin.body.error).toMatch(/Boca de llenado/);

    const nNuevo = numeroUnico();
    expect((await recibir([{ punto_id: boca, numero: nNuevo }])).status).toBe(201);
    // Recibir es la apertura legítima de todos los días: no es un reemplazo.
    expect(await alertas(tq, "precinto_reemplazado")).toHaveLength(0);

    // Gemelo: la varilla con el sello nuevo no alerta.
    expect((await varilla(tq, [{ punto_id: boca, numero: nNuevo }])).status).toBe(201);
    expect(await alertas(tq, "precinto_alterado")).toHaveLength(0);
    // Ataque: la varilla todavía ve el sello viejo. Nadie puso el nuevo.
    expect((await varilla(tq, [{ punto_id: boca, numero: nBoca }])).status).toBe(201);
    expect(await alertas(tq, "precinto_alterado")).toHaveLength(1);
  });

  it("la varilla offline se compara con el sello que había cuando se midió", async () => {
    const tq = await tanque();
    const nViejo = numeroUnico();
    const drenaje = await punto(tq, "Drenaje", nViejo);
    const medidaEn = new Date().toISOString();

    // Mientras la varilla está en la cola del celular, se cambia el sello.
    const cambio = await operador
      .post(`/api/erp/combustible/precintos/puntos/${drenaje}/cambios`)
      .send({ numero: numeroUnico(), motivo: "Sello roto por la lluvia" });
    expect(cambio.status).toBe(201);

    // Llega la varilla con el número que se vio EN ESE MOMENTO: el viejo.
    expect((await varilla(tq, [{ punto_id: drenaje, numero: nViejo }], medidaEn)).status).toBe(201);
    expect(await alertas(tq, "precinto_alterado")).toHaveLength(0);
  });

  it("cambiar un sello fuera de una recepción se permite, pero siempre queda alerta", async () => {
    const tq = await tanque();
    const drenaje = await punto(tq, "Drenaje", numeroUnico());
    const nuevo = numeroUnico();

    // El grifero es el que tiene el tanque a mano: no cambia sellos.
    const r0 = await grifero
      .post(`/api/erp/combustible/precintos/puntos/${drenaje}/cambios`)
      .send({ numero: numeroUnico(), motivo: "mantenimiento" });
    expect(r0.status).toBe(403);

    const r = await operador
      .post(`/api/erp/combustible/precintos/puntos/${drenaje}/cambios`)
      .send({ numero: nuevo, motivo: "mantenimiento" });
    expect(r.status).toBe(201);
    const [alerta] = await alertas(tq, "precinto_reemplazado");
    expect(alerta.detalle).toMatchObject({ numeroNuevo: nuevo, motivo: "mantenimiento" });

    // Volver a "cerrar" con un número ya usado: bloqueado.
    const reuso = await operador
      .post(`/api/erp/combustible/precintos/puntos/${drenaje}/cambios`)
      .send({ numero: nuevo, motivo: "otra vez" });
    expect(reuso.status).toBe(409);

    // Meter un cambio fechado antes del último reescribiría lo que debieron
    // ver varillas ya verificadas.
    const atras = await operador
      .post(`/api/erp/combustible/precintos/puntos/${drenaje}/cambios`)
      .send({ numero: numeroUnico(), motivo: "tarde", colocado_en: haceMin(60 * 24) });
    expect(atras.status).toBe(400);
  });

  it("apagar los precintos o dar de baja un punto es aflojar la vigilancia", async () => {
    const tq = await tanque();
    const drenaje = await punto(tq, "Drenaje", numeroUnico());
    const ficha = (await admin.get(`/api/erp/combustible/${tq}`)).body;
    const put = (extra: Record<string, unknown>) =>
      admin.put(`/api/erp/combustible/${tq}`).send({
        codigo: ficha.codigo,
        tanque_nombre: ficha.tanque_nombre,
        tipo_combustible: ficha.tipo_combustible,
        unidad: ficha.unidad,
        tipo_punto: ficha.tipo_punto,
        capacidad_total: Number(ficha.capacidad_total),
        nivel_minimo: Number(ficha.nivel_minimo ?? 0),
        moneda: ficha.moneda,
        activo: true,
        tolerancia_capacidad_pct: Number(ficha.tolerancia_capacidad_pct),
        modo_excedente_recepcion: ficha.modo_excedente_recepcion,
        limite_excedente_pct:
          ficha.limite_excedente_pct === null ? null : Number(ficha.limite_excedente_pct),
        requiere_documento: false,
        umbral_diferencia_pct: null,
        umbral_descuadre_pct: null,
        umbral_descuadre_ciclo_pct: null,
        umbral_descuadre_ventana_pct: null,
        ...extra,
      });

    const sinMotivo = await put({ usa_precintos: false });
    expect(sinMotivo.status).toBe(400);
    expect(
      (await put({ usa_precintos: false, motivo_ajuste: "Se sacaron los sellos" })).status
    ).toBe(200);

    expect(
      (
        await operador.patch(`/api/erp/combustible/precintos/puntos/${drenaje}/baja`).send({
          motivo: "x",
        })
      ).status
    ).toBe(403);
    const baja = await admin
      .patch(`/api/erp/combustible/precintos/puntos/${drenaje}/baja`)
      .send({ motivo: "Se soldó el drenaje" });
    expect(baja.status).toBe(200);

    const bitacora = await admin.get("/api/erp/combustible/bitacora?pageSize=200");
    const reducidas = (bitacora.body.data as { accion: string; detalle: Record<string, unknown> }[])
      .filter((e) => e.accion === "combustible.tanque_vigilancia_reducida")
      .filter((e) => e.detalle.combustibleId === tq);
    expect(reducidas.length).toBe(2);
  });

  it("los cambios de precinto aparecen en el kardex sin mover el saldo, y cuentan en segregación", async () => {
    const tq = await tanque();
    const n = numeroUnico();
    await punto(tq, "Tapa", n);
    const q = { desde: haceMin(60), hasta: new Date(Date.now() + 60_000).toISOString() };

    const kardex = await admin.get(`/api/erp/combustible/${tq}/kardex`).query(q);
    expect(kardex.status).toBe(200);
    const fila = (
      kardex.body.filas as { tipo: string; documento: string; entrada: number; salida: number }[]
    ).find((f) => f.tipo === "precinto");
    expect(fila).toMatchObject({ documento: n, entrada: 0, salida: 0 });

    const seg = await admin.get("/api/erp/combustible/reportes/segregacion").query(q);
    const total = (seg.body.personas as { precintos_colocados: number }[]).reduce(
      (a, p) => a + p.precintos_colocados,
      0
    );
    expect(total).toBeGreaterThan(0);
  });
});
