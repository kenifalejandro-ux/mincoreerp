/** tests/combustible-huecos-de-configuracion.test.ts
 *
 * Los dos hallazgos GRAVES de la tercera auditoría adversaria, convertidos en
 * regresión. Los dos pasaron con la vigilancia al máximo -- los cuatro
 * umbrales en 1%, techo de 1 llenado por día, tope absoluto de 500 L.
 *
 * El ataque de esta ronda no fue sacar combustible: fue CAMBIAR LA
 * CONFIGURACIÓN para que sacarlo dejara de verse.
 *
 * 1. CAMBIAR LA UNIDAD DEL TANQUE (L → gal). Un solo campo, 200 OK, sin
 *    alerta y sin quedar registrado como aflojamiento. La capacidad no se
 *    convierte: el 20.000 que significaba litros pasa a significar galones
 *    (75.708 L), y como los cuatro umbrales son % de la capacidad, todas las
 *    bandas se multiplican por 3,785. En la simulación, después del cambio se
 *    despacharon 400 "gal" (1.514 L reales) contra un techo de 500 L sin una
 *    sola alerta.
 *
 * 2. SUBIR LA CAPACIDAD DEL EQUIPO. El techo diario sale de
 *    `capacidad_tanque × llenados_por_dia_max`, así que subir la capacidad
 *    del volquete lo anula -- y el cambio se hacía desde OTRO módulo, con la
 *    auditoría registrando `{ equipoId }` y nada más. Con capacidad 500 un
 *    despacho de 700 alertaba; con 50.000, uno de 5.000 no alertaba nada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serie = () => `S${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

describe("combustible: huecos de configuración (3ª auditoría adversaria)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    await ag.put("/api/erp/combustible/config").send({
      ventana_gracia_horas: 24,
      dias_sin_medir: 2,
      dias_ventana_descuadre: 30,
      llenados_por_dia_max: 1,
      tope_diario_sin_capacidad_l: 500,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const equipoCon = async (capacidad: number | null) => {
    const r = await ag.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      ...(capacidad === null ? {} : { capacidad_tanque: capacidad, capacidad_tanque_unidad: "L" }),
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  };

  async function tanque(unidad = "L") {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad,
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 20000,
      nivel_minimo: 2000,
      tolerancia_capacidad_pct: 0,
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: 1,
      umbral_descuadre_ciclo_pct: 1,
      umbral_descuadre_ventana_pct: 1,
      umbral_diferencia_pct: 1,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  /** PUT con la fila entera (el PUT reemplaza, no parchea). */
  const editar = async (tq: number, cambios: Record<string, unknown>) => {
    const f = (await ag.get(`/api/erp/combustible/${tq}`)).body;
    const num = (v: unknown) => (v === null ? null : Number(v));
    return ag.put(`/api/erp/combustible/${tq}`).send({
      codigo: f.codigo,
      tanque_nombre: f.tanque_nombre,
      tipo_combustible: f.tipo_combustible,
      unidad: f.unidad,
      tipo_punto: f.tipo_punto,
      moneda: f.moneda,
      activo: f.activo,
      capacidad_total: Number(f.capacidad_total),
      nivel_minimo: Number(f.nivel_minimo),
      tolerancia_capacidad_pct: Number(f.tolerancia_capacidad_pct),
      requiere_documento: f.requiere_documento,
      umbral_diferencia_pct: num(f.umbral_diferencia_pct),
      umbral_descuadre_pct: num(f.umbral_descuadre_pct),
      umbral_descuadre_ciclo_pct: num(f.umbral_descuadre_ciclo_pct),
      umbral_descuadre_ventana_pct: num(f.umbral_descuadre_ventana_pct),
      ...cambios,
    });
  };

  const desp = (tq: number, cant: number, cuando: string, equipoId: number) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie(),
      n_vale: 1,
      cantidad: cant,
      lectura_contometro: cant,
      costo_unitario: 16,
      despachado_en: cuando,
    });

  const topes = async () => {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 400 });
    return r.body.data.filter((a: { tipo: string }) => a.tipo === "tope_diario_excedido").length;
  };

  const ultimaAuditoria = (accion: string) =>
    withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle FROM platform_audit_log WHERE tenant_id = $1 AND accion = $2
         ORDER BY id DESC LIMIT 1`,
        [tenantId, accion]
      )
    );

  // ── 1. La unidad del tanque ───────────────────────────────────────────

  it("un tanque CON movimientos no puede cambiar de unidad", async () => {
    const tq = await tanque();
    const eq = await equipoCon(500);
    expect((await desp(tq, 100, hace(10), eq)).status).toBe(201);

    const res = await editar(tq, { unidad: "gal", motivo_ajuste: "correccion" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no se puede cambiar la unidad");
    // Y la ficha no se movió.
    expect((await ag.get(`/api/erp/combustible/${tq}`)).body.unidad).toBe("L");
  });

  it("una lectura también cuenta como movimiento", async () => {
    const tq = await tanque();
    await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel: 19000, leido_en: hace(5) });

    expect((await editar(tq, { unidad: "gal" })).status).toBe(400);
  });

  it("un tanque RECIÉN creado sí puede corregir la unidad", async () => {
    // Acá no se reinterpreta nada: es un tipeo recién hecho. La lectura
    // `inicial` la crea el propio sistema y no cuenta como movimiento.
    const tq = await tanque();
    const res = await editar(tq, { unidad: "gal" });
    expect(res.status).toBe(200);
    expect((await ag.get(`/api/erp/combustible/${tq}`)).body.unidad).toBe("gal");
  });

  it("editar otra cosa sin tocar la unidad sigue funcionando", async () => {
    const tq = await tanque();
    const eq = await equipoCon(500);
    await desp(tq, 100, hace(10), eq);
    expect((await editar(tq, { tanque_nombre: "Nombre nuevo" })).status).toBe(200);
  });

  // ── 2. La capacidad del equipo ────────────────────────────────────────

  it("subir la capacidad del equipo se audita con los valores y avisa", async () => {
    const eq = await equipoCon(500);
    const res = await ag.put(`/api/erp/equipos/${eq}`).send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      capacidad_tanque: 50000,
      capacidad_tanque_unidad: "L",
      activo: true,
    });
    expect(res.status).toBe(200);

    const log = await ultimaAuditoria("equipos.capacidad_tanque_ampliada");
    expect(log.rows[0]).toBeDefined();
    // Lo que faltaba: el "de cuánto a cuánto". Antes el detalle era solo
    // { equipoId } y la bitácora no podía decir si eso aflojó algo.
    expect(log.rows[0].detalle.de).toContain("500");
    expect(log.rows[0].detalle.a).toContain("50000");
  });

  it("quitarle la capacidad también amplía: pierde su techo propio", async () => {
    const eq = await equipoCon(500);
    const res = await ag
      .put(`/api/erp/equipos/${eq}`)
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete", activo: true });
    expect(res.status).toBe(200);

    const log = await ultimaAuditoria("equipos.capacidad_tanque_ampliada");
    expect(log.rows[0].detalle.a).toContain("sin capacidad");
  });

  it("BAJARLA no dispara nada: estrecha el techo", async () => {
    const eq = await equipoCon(5000);
    const antes = (await ultimaAuditoria("equipos.capacidad_tanque_ampliada")).rows[0];
    await ag.put(`/api/erp/equipos/${eq}`).send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      capacidad_tanque: 500,
      capacidad_tanque_unidad: "L",
      activo: true,
    });
    const despues = (await ultimaAuditoria("equipos.capacidad_tanque_ampliada")).rows[0];
    expect(despues?.detalle).toEqual(antes?.detalle);
  });

  it("cargarla por primera vez tampoco: encender un control nunca es aflojar", async () => {
    const eq = await equipoCon(null);
    const antes = (await ultimaAuditoria("equipos.capacidad_tanque_ampliada")).rows[0];
    await ag.put(`/api/erp/equipos/${eq}`).send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      capacidad_tanque: 800,
      capacidad_tanque_unidad: "L",
      activo: true,
    });
    const despues = (await ultimaAuditoria("equipos.capacidad_tanque_ampliada")).rows[0];
    expect(despues?.detalle).toEqual(antes?.detalle);
  });

  it("compara en litros: 100 gal NO es menos que 500 L", async () => {
    // 100 gal = 378,5 L, o sea que baja. Comparar los números crudos
    // (100 < 500) daría el mismo resultado por casualidad; el caso que
    // importa es el inverso.
    const eq = await equipoCon(500);
    const antes = (await ultimaAuditoria("equipos.capacidad_tanque_ampliada")).rows[0];
    await ag.put(`/api/erp/equipos/${eq}`).send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      capacidad_tanque: 200, // 200 gal = 757 L → AMPLÍA, aunque 200 < 500
      capacidad_tanque_unidad: "gal",
      activo: true,
    });
    const despues = (await ultimaAuditoria("equipos.capacidad_tanque_ampliada")).rows[0];
    expect(despues.detalle.a).toContain("gal");
    expect(despues.detalle).not.toEqual(antes?.detalle);
  });

  it("el aflojamiento de Equipos aparece en la bitácora de Combustible", async () => {
    // Vive en otro módulo, pero afloja un control de combustible: tiene que
    // verse en la pantalla donde gerencia busca quién tocó la vigilancia.
    const eq = await equipoCon(500);
    await ag.put(`/api/erp/equipos/${eq}`).send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      capacidad_tanque: 90000,
      capacidad_tanque_unidad: "L",
      activo: true,
    });

    const bit = await ag.get("/api/erp/combustible/bitacora").query({ pageSize: 100 });
    expect(bit.status).toBe(200);
    const fila = bit.body.data.find(
      (f: { accion: string }) => f.accion === "equipos.capacidad_tanque_ampliada"
    );
    expect(fila).toBeDefined();
  });

  it("el techo diario sigue funcionando con la capacidad de verdad", async () => {
    const tq = await tanque();
    const eq = await equipoCon(500);
    const antes = await topes();
    await desp(tq, 700, hace(6), eq); // 700 > 500 × 1 llenado
    expect(await topes()).toBe(antes + 1);
  });
});
