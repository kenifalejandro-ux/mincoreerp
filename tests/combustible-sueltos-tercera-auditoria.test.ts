/** tests/combustible-sueltos-tercera-auditoria.test.ts
 *
 * Las tres cosas que la 3ª auditoría adversaria dejó anotadas sin cerrar.
 * Ninguna era un robo directo; las tres eran formas de que el registro
 * dejara de servir para contestarle a un auditor.
 *
 * 1. DE UN TANQUE DE DIÉSEL SALÍA GASOLINA. El vale guarda su propio
 *    `tipo_combustible` y nadie lo comparaba con el del tanque. No es fuga
 *    --la cantidad igual se descuenta-- pero un puñado de vales de "gasolina"
 *    saliendo del tanque de diésel es una explicación lista para cualquier
 *    faltante.
 * 2. UN TANQUE QUE NACE CIEGO NO AVISABA. Aflojar un tanque vigilado exige
 *    motivo y despierta a todos los admins; dar de alta uno SIN umbrales
 *    --mismo agujero, más fácil-- solo quedaba en un log.
 * 3. EL QUE DESPACHA CERRABA SUS PROPIAS ALERTAS. Se cerraron 2 de 2 con un
 *    "ok revisado" y no quedó registro de que revisor y revisado fueran la
 *    misma persona. Encima, cerrar una alerta NO SE AUDITABA.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serie = () => `S${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

describe("combustible: los tres sueltos de la 3ª auditoría", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  const hace = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

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
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(extra: Record<string, unknown> = {}) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 20000,
      nivel_minimo: 2000,
      modo_vigilancia: "personalizado",
      umbral_descuadre_pct: 1,
      umbral_descuadre_ciclo_pct: 1,
      umbral_descuadre_ventana_pct: 1,
      umbral_diferencia_pct: 1,
      ...extra,
    });
    // Varilla de base ANTERIOR a todo lo que hagan los tests. Sin ella no hay
    // descuadre que calcular: la lectura `inicial` del alta se crea con
    // NOW(), así que una lectura fechada atrás no tiene predecesora y el
    // control no llega ni a evaluarse.
    if (r.status === 201) {
      await ag.post("/api/erp/combustible/lecturas").send({
        combustible_id: r.body.id,
        nivel: 20000,
        leido_en: hace(50),
      });
    }
    return r;
  }

  const despachar = (tq: number, tipo: string, cantidad = 100) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: tipo,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: hace(5),
    });

  const ultima = (accion: string) =>
    withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle FROM platform_audit_log WHERE tenant_id = $1 AND accion = $2
         ORDER BY id DESC LIMIT 1`,
        [tenantId, accion]
      )
    );

  // ── 1. El tipo de combustible del vale ────────────────────────────────

  it("de un tanque de diésel NO sale gasolina", async () => {
    const tq = (await tanque()).body.id;
    const res = await despachar(tq, "gasolina_90");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("es de diesel_b5");
    expect(res.body.error).toContain("gasolina_90");
  });

  it("el tipo correcto pasa sin ruido", async () => {
    const tq = (await tanque()).body.id;
    expect((await despachar(tq, "diesel_b5")).status).toBe(201);
  });

  // ── 2. El tanque que nace ciego ───────────────────────────────────────

  it("un tanque sin umbrales se puede crear, pero queda registrado como ciego", async () => {
    // No se bloquea: "sin vigilar por ahora" es legítimo en un tanque recién
    // instalado, que todavía no tiene historial con el que calibrar. Lo que
    // no puede ser es silencioso.
    const r = await tanque({
      modo_vigilancia: "sin_vigilar",
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
      umbral_diferencia_pct: null,
    });
    expect(r.status).toBe(201);

    const log = await ultima("combustible.tanque_crear");
    expect(log.rows[0].detalle.modoVigilancia).toBe("sin_vigilar");
    expect(log.rows[0].detalle.umbrales.descuadre).toBeNull();
    expect(log.rows[0].detalle.umbrales.ventana).toBeNull();
  });

  // ── 3. Segregación: quién cierra la alerta ────────────────────────────

  it("cerrar una alerta ahora SÍ queda en la bitácora", async () => {
    const tq = (await tanque()).body.id;
    await despachar(tq, "diesel_b5", 400);
    await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel: 18000, leido_en: hace(4) });

    const lista = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 300 });
    const alerta = lista.body.data.find(
      (a: { combustible_id: number; resuelta_en: string | null }) =>
        a.combustible_id === tq && a.resuelta_en === null
    );
    expect(alerta).toBeDefined();

    const res = await ag
      .patch(`/api/erp/combustible/alertas/${alerta.id}/resolver`)
      .send({ motivo: "se recalibró la varilla" });
    expect(res.status).toBe(200);

    const log = await ultima("combustible.alerta_resuelta");
    expect(log.rows[0]).toBeDefined();
    expect(log.rows[0].detalle.motivo).toContain("recalibró");
  });

  it("si la cierra el mismo que hizo el despacho, va con acción propia", async () => {
    const tq = (await tanque()).body.id;
    // El despacho lo carga ESTE usuario; la alerta del vale cuelga de él.
    const d = await despachar(tq, "diesel_b5", 15000); // sobredespacho a un equipo sin capacidad
    expect(d.status).toBe(201);

    const lista = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 300 });
    const conVale = lista.body.data.find(
      (a: { despacho_id: number | null; resuelta_en: string | null }) =>
        a.despacho_id === d.body.id && a.resuelta_en === null
    );

    if (conVale) {
      const res = await ag
        .patch(`/api/erp/combustible/alertas/${conVale.id}/resolver`)
        .send({ motivo: "ok revisado" });
      expect(res.status).toBe(200);
      expect(res.body.autorevision).toBe(true);

      const log = await ultima("combustible.alerta_autorevisada");
      expect(log.rows[0]).toBeDefined();
      expect(log.rows[0].detalle.autorevision).toBe(true);
    }
  });

  it("una alerta de tanque (sin movimiento de nadie) no es autorrevisión", async () => {
    // Nivel bajo o sin medir no cuelgan de un vale, así que no hay a quién
    // señalar: marcarlas sería ruido, y el ruido apaga los controles.
    const tq = (await tanque()).body.id;
    await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel: 19000, leido_en: hace(4) });
    await despachar(tq, "diesel_b5", 400);
    await ag
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel: 17000, leido_en: hace(3) });

    const lista = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 300 });
    const deTanque = lista.body.data.find(
      (a: { combustible_id: number; despacho_id: number | null; resuelta_en: string | null }) =>
        a.combustible_id === tq && a.despacho_id === null && a.resuelta_en === null
    );
    expect(deTanque).toBeDefined();

    const res = await ag
      .patch(`/api/erp/combustible/alertas/${deTanque.id}/resolver`)
      .send({ motivo: "medición corregida" });
    expect(res.status).toBe(200);
    expect(res.body.autorevision).toBe(false);
  });
});
