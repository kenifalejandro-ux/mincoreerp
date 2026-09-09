/** tests/combustible-tanque-sin-vigilancia.test.ts
 *
 * Kenif, al ver la etiqueta roja "Sin vigilancia" en la simulación contra el
 * ERP: *"sería bueno que el sistema pida como requisito que estén cargados
 * los umbrales, sin ello que no se cree el tanque"*.
 *
 * NO se bloquea el alta, y el motivo es el mismo que sostiene medio módulo:
 * el número correcto no existe el día uno. El umbral bueno sale del historial
 * del propio tanque, y por eso el asistente de calibración exige 10
 * mediciones. Obligar a poner uno para crear el tanque obliga a INVENTARLO, y
 * un umbral inventado o alerta con el trabajo normal --y se ignora-- o no
 * atrapa nada pero deja el tanque figurando como configurado. Ese segundo
 * caso es peor que la etiqueta roja, que al menos dice la verdad.
 *
 * El hueco real no estaba en el alta --que ya obliga a elegir y avisa por
 * correo si nace ciego-- sino en que DESPUÉS NADIE INSISTE: un tanque puede
 * despachar miles de litros durante meses con los tres umbrales en NULL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

describe("combustible: el tanque que OPERA ciego (migración 0082)", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (dias: number) => new Date(Date.now() - dias * 864e5).toISOString();
  let seq = 0;
  const serie = () => `SV${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

  const CONFIG = {
    ventana_gracia_horas: 72,
    dias_sin_medir: 90,
    dias_ventana_descuadre: 30,
    dias_carga_retroactiva: 90,
    dias_sin_vigilancia: 7,
    llenados_por_dia_max: null,
    tope_diario_sin_capacidad_l: null,
  };

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const e = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete" });
    equipoId = e.body.id;
    await ag.put("/api/erp/combustible/config").send(CONFIG);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(umbrales: Record<string, unknown>) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 1000,
      ...umbrales,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const CIEGO = {
    modo_vigilancia: "sin_vigilar",
    umbral_descuadre_pct: null,
    umbral_descuadre_ciclo_pct: null,
    umbral_descuadre_ventana_pct: null,
    umbral_diferencia_pct: null,
  };

  const despachar = (tq: number, cuando: string) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie(),
      n_vale: 1,
      cantidad: 400,
      lectura_contometro: 400,
      costo_unitario: 16,
      despachado_en: cuando,
    });

  const alertasDe = async (tq: number) => {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 400 });
    return (
      r.body.data as { tipo: string; combustible_id: number; detalle: Record<string, unknown> }[]
    ).filter((a) => a.tipo === "tanque_sin_vigilancia" && a.combustible_id === tq);
  };

  // ── El caso que motivó todo ───────────────────────────────────────────

  it("un tanque que lleva días despachando sin umbrales alerta, con los litros", async () => {
    const tq = await tanque(CIEGO);
    expect((await despachar(tq, hace(20))).status).toBe(201);
    expect((await despachar(tq, hace(3))).status).toBe(201);

    await correrConciliacion(tenantId);

    const al = await alertasDe(tq);
    expect(al).toHaveLength(1);
    // El daño ya hecho, que es lo que convierte el aviso en un número:
    // no es "falta configurar", es "salieron 800 L sin que nada los mirara".
    expect(Number(al[0].detalle.litrosEnLaVentana)).toBe(800);
    expect(Number(al[0].detalle.valesEnLaVentana)).toBe(2);
    expect(Number(al[0].detalle.plazoDias)).toBe(7);
  });

  it("el alta NO se bloquea: sin vigilar sigue siendo una decisión legítima", async () => {
    // El día uno no hay historial con el que calibrar. Obligar a un número
    // ahí obliga a inventarlo, y eso sale peor que la etiqueta roja.
    const tq = await tanque(CIEGO);
    expect(tq).toBeGreaterThan(0);
    expect(await alertasDe(tq)).toHaveLength(0);
  });

  // ── Lo que NO debe alertar ────────────────────────────────────────────

  it("un tanque ciego que TODAVÍA NO DESPACHÓ no alerta", async () => {
    // No hay nada que vigilar aún. Alertarlo sería ruido el primer día.
    const tq = await tanque(CIEGO);
    await correrConciliacion(tenantId);
    expect(await alertasDe(tq)).toHaveLength(0);
  });

  it("un tanque ciego que recién empezó a despachar tampoco", async () => {
    // El plazo se cuenta desde el PRIMER despacho, no desde el alta: un
    // tanque que arranca hoy no tiene historial con el que calibrar.
    const tq = await tanque(CIEGO);
    await despachar(tq, hace(1));
    await correrConciliacion(tenantId);
    expect(await alertasDe(tq)).toHaveLength(0);
  });

  it("con UN solo umbral configurado no alerta: ya no es ciego", async () => {
    // Para vigilancia parcial alcanza la etiqueta ámbar de la lista. La
    // alerta es para el estado en que NINGÚN faltante es detectable.
    const tq = await tanque({
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: 2,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
      umbral_diferencia_pct: null,
    });
    await despachar(tq, hace(20));
    await correrConciliacion(tenantId);
    expect(await alertasDe(tq)).toHaveLength(0);
  });

  it("el umbral de la FACTURA no cuenta: no vigila el faltante del tanque", async () => {
    // `umbral_diferencia_pct` mira al proveedor contra lo descargado. Un
    // tanque que solo lo tiene sigue siendo ciego al robo.
    const tq = await tanque({
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
      umbral_diferencia_pct: 2,
    });
    await despachar(tq, hace(20));
    await correrConciliacion(tenantId);
    expect(await alertasDe(tq)).toHaveLength(1);
  });

  it("no se duplica: es un ESTADO que persiste, no un evento que se repite", async () => {
    const tq = await tanque(CIEGO);
    await despachar(tq, hace(20));
    await correrConciliacion(tenantId);
    await correrConciliacion(tenantId);
    await correrConciliacion(tenantId);
    expect(await alertasDe(tq)).toHaveLength(1);
  });

  // ── Se cierra sola cuando se arregla ──────────────────────────────────

  it("configurar un umbral cierra la alerta sin que nadie la revise", async () => {
    // Mismo criterio que "sin medir" cuando llega una lectura: el problema
    // que reportaba dejó de existir, no lo resolvió una persona.
    const tq = await tanque(CIEGO);
    await despachar(tq, hace(20));
    await correrConciliacion(tenantId);
    expect(await alertasDe(tq)).toHaveLength(1);

    const f = (await ag.get(`/api/erp/combustible/${tq}`)).body;
    const res = await ag.put(`/api/erp/combustible/${tq}`).send({
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
      umbral_diferencia_pct: null,
      umbral_descuadre_pct: 2,
      umbral_descuadre_ciclo_pct: 3,
      umbral_descuadre_ventana_pct: 4,
    });
    expect(res.status).toBe(200);

    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 400 });
    const suya = (
      r.body.data as { tipo: string; combustible_id: number; resuelta_en: string | null }[]
    ).find((a) => a.tipo === "tanque_sin_vigilancia" && a.combustible_id === tq);
    expect(suya!.resuelta_en).not.toBeNull();
  });

  // ── Aflojar el control nuevo ──────────────────────────────────────────

  it("subir los días tolerados sin vigilancia queda auditado como aflojamiento", async () => {
    await ag.put("/api/erp/combustible/config").send({ ...CONFIG, dias_sin_vigilancia: 7 });
    const r = await ag
      .put("/api/erp/combustible/config")
      .send({ ...CONFIG, dias_sin_vigilancia: 90 });
    expect(r.status).toBe(200);

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'combustible.config_vigilancia_reducida'
          ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    const aflojados = log.rows[0].detalle.aflojados as { control: string }[];
    expect(aflojados.some((c) => c.control.includes("sin vigilancia"))).toBe(true);

    await ag.put("/api/erp/combustible/config").send(CONFIG);
  });
});
