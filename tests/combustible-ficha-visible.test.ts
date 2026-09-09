/** tests/combustible-ficha-visible.test.ts
 *
 * Los tres huecos MENORES de la 3ª auditoría adversaria, y el cambio de
 * enfoque que evita el cuarto.
 *
 * Los tres compartían una causa: `evaluarAflojamiento` mantiene A MANO la
 * lista de qué campo es un control, y un campo sin clasificar se editaba
 * dejando `{ combustibleId }` en la auditoría -- ni qué cambió, ni de cuánto
 * a cuánto. El problema no era la lista, era el DEFECTO: nacer invisible.
 *
 * Ahora: **la visibilidad es automática, la escalada es declarada.** Todo
 * campo que cambia queda con sus valores; los que además exigen motivo y
 * mandan correo siguen siendo una lista explícita, porque frenar un
 * formulario y despertar a gerencia no puede ser automático.
 *
 * 1. DESACTIVAR POR PUT. El DELETE exige motivo desde el PR de las fechas y
 *    la baja; `activo` también es campo del PUT y por ahí no pedía nada.
 * 2. TOLERANCIA DE CAPACIDAD al alza. Es el techo real para aceptar una
 *    recepción: con 90% se declaran 38.000 L entrando a un tanque de 20.000.
 * 3. TIPO DE COMBUSTIBLE con historial. No mueve ningún número --el despacho
 *    guarda su propio tipo-- pero deja vales de diésel colgando de un tanque
 *    que ahora dice gasolina.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serie = () => `S${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

describe("combustible: todo cambio de ficha queda visible", () => {
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

  async function tanque() {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
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

  const despachar = (tq: number) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie(),
      n_vale: 1,
      cantidad: 100,
      lectura_contometro: 100,
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

  // ── 1. Desactivar por PUT ─────────────────────────────────────────────

  it("desactivar por PUT ahora exige motivo, igual que el DELETE", async () => {
    const tq = await tanque();
    const sinMotivo = await editar(tq, { activo: false });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.requiere_motivo).toBe(true);
    expect(sinMotivo.body.error).toContain("Tanque activo");
    // Y no se aplicó.
    expect((await ag.get(`/api/erp/combustible/${tq}`)).body.activo).toBe(true);
  });

  it("con motivo se aplica y entra como vigilancia reducida", async () => {
    const tq = await tanque();
    const res = await editar(tq, { activo: false, motivo_ajuste: "Tanque fuera de servicio" });
    expect(res.status).toBe(200);

    const log = await ultima("combustible.tanque_vigilancia_reducida");
    const aflojados = log.rows[0].detalle.aflojados as { control: string }[];
    expect(aflojados.some((c) => c.control.includes("Tanque activo"))).toBe(true);
  });

  it("REACTIVAR no pide nada: vuelve a vigilarse", async () => {
    const tq = await tanque();
    await editar(tq, { activo: false, motivo_ajuste: "baja" });
    expect((await editar(tq, { activo: true })).status).toBe(200);
  });

  // ── 2. Tolerancia de capacidad ────────────────────────────────────────

  it("subir la tolerancia de capacidad exige motivo", async () => {
    const tq = await tanque();
    const res = await editar(tq, { tolerancia_capacidad_pct: 90 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Tolerancia de capacidad");
  });

  it("bajarla no: estrecha el techo de las recepciones", async () => {
    const tq = await tanque();
    await editar(tq, { tolerancia_capacidad_pct: 10, motivo_ajuste: "x" });
    expect((await editar(tq, { tolerancia_capacidad_pct: 5 })).status).toBe(200);
  });

  // ── 3. Tipo de combustible ────────────────────────────────────────────

  it("cambiar el tipo de combustible CON historial exige motivo", async () => {
    const tq = await tanque();
    expect((await despachar(tq)).status).toBe(201);

    const res = await editar(tq, { tipo_combustible: "gasolina_90" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Tipo de combustible");
  });

  it("sin historial NO pide nada: es terminar de dar de alta el tanque", async () => {
    const tq = await tanque();
    expect((await editar(tq, { tipo_combustible: "gasolina_90" })).status).toBe(200);
  });

  // ── 4. Lo de fondo: todo cambio queda con sus valores ─────────────────

  it("una edición COMÚN ya no deja solo el id: deja qué cambió y a cuánto", async () => {
    // Renombrar no afloja nada y no pide motivo. Pero antes la auditoría
    // guardaba `{ combustibleId }` a secas, y ahí es donde se escondieron
    // los tres huecos de esta ronda.
    const tq = await tanque();
    const res = await editar(tq, { tanque_nombre: "Tanque Norte", ubicacion: "Cancha 2" });
    expect(res.status).toBe(200);

    const log = await ultima("combustible.tanque_actualizar");
    const cambios = log.rows[0].detalle.cambios as { campo: string; de: string; a: string }[];
    const nombre = cambios.find((c) => c.campo === "tanque_nombre");
    expect(nombre).toBeDefined();
    expect(nombre!.a).toBe("Tanque Norte");
    expect(cambios.some((c) => c.campo === "ubicacion")).toBe(true);
  });

  it("un PUT que no cambia nada no inventa cambios", async () => {
    // El NUMERIC vuelve de Postgres como string ("20000.00"); comparar crudo
    // marcaría como modificado lo que nadie tocó.
    const tq = await tanque();
    const res = await editar(tq, {});
    expect(res.status).toBe(200);
    const log = await ultima("combustible.tanque_actualizar");
    expect(log.rows[0].detalle.cambios).toEqual([]);
  });

  it("cuando afloja, la auditoría lleva las DOS cosas: todo lo que cambió y qué aflojó", async () => {
    const tq = await tanque();
    const res = await editar(tq, {
      tanque_nombre: "Renombrado",
      umbral_descuadre_pct: 50,
      motivo_ajuste: "Varilla sin calibrar",
    });
    expect(res.status).toBe(200);

    const log = await ultima("combustible.tanque_vigilancia_reducida");
    const d = log.rows[0].detalle;
    // El aflojamiento, para gerencia.
    expect((d.aflojados as unknown[]).length).toBeGreaterThan(0);
    // Y el cambio completo, incluido el que NO afloja, para el auditor.
    expect((d.cambios as { campo: string }[]).some((c) => c.campo === "tanque_nombre")).toBe(true);
    expect(d.motivo).toContain("Varilla");
  });
});
