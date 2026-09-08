/** tests/combustible-tope-diario.test.ts
 *
 * Hallazgos 1 y 2 de la simulación adversaria, convertidos en regresión.
 *
 * 1. EL ROBO REPARTIDO. `evaluarSobredespacho` compara UN vale contra la
 *    capacidad del equipo. Alcanzó con partirlo: tres vales de 400 L a un
 *    volquete de tanque 500. Ninguno excede solo. Se fueron 1.200 L sin una
 *    alerta.
 *
 * 2. EL DESTINO SIN TECHO. `planta` y `reserva_cubeta` no tienen equipo, así
 *    que no tenían NINGÚN límite. Un vale a "planta" por 8.000 L pasaba
 *    igual que uno por 80.
 *
 * Y la puerta de atrás que abre el control mismo: los dos topes se cargan en
 * una pantalla de configuración, así que subirlos es la forma más cómoda de
 * robar que queda. Tiene que quedar auditado como aflojamiento.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serieUnica = () => `S${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

describe("combustible: tope diario por actor (migración 0079)", () => {
  let tenantId: string;
  let tanqueId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });

    const t = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de la simulación",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 50000,
      nivel_minimo: 2000,
      modo_vigilancia: "sin_vigilar",
    });
    expect(t.status).toBe(201);
    tanqueId = t.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Un equipo con capacidad de tanque cargada -- hoy en la operación real
   *  están todas en NULL, y por eso el techo por equipo queda dormido hasta
   *  que alguien las cargue. Acá se carga para probar que funciona. */
  async function equipoCon(capacidad: number | null) {
    const r = await ag.post("/api/erp/equipos").send({
      placa_codigo: idUnico("EQ"),
      tipo: "Volquete",
      ...(capacidad === null ? {} : { capacidad_tanque: capacidad, capacidad_tanque_unidad: "L" }),
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const config = (extra: Record<string, unknown>) =>
    ag.put("/api/erp/combustible/config").send({
      ventana_gracia_horas: 72,
      dias_sin_medir: 3,
      llenados_por_dia_max: null,
      tope_diario_sin_capacidad_l: null,
      ...extra,
    });

  const serie = serieUnica();
  let valeSeq = 0;

  const despachar = (
    cantidad: number,
    destino: { equipo_id: number } | { tipo_destino: "planta" | "reserva_cubeta" },
    cuando?: string
  ) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      serie_talonario: serie,
      n_vale: ++valeSeq,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      ...(cuando ? { despachado_en: cuando } : {}),
      ...("equipo_id" in destino
        ? { tipo_destino: "equipo", equipo_id: destino.equipo_id }
        : { tipo_destino: destino.tipo_destino }),
    });

  const topesDe = async (filtro: (d: Record<string, unknown>) => boolean) => {
    const r = await ag.get("/api/erp/combustible/alertas").query({ pageSize: 300 });
    return r.body.data.filter(
      (a: { tipo: string; detalle: Record<string, unknown> }) =>
        a.tipo === "tope_diario_excedido" && filtro(a.detalle)
    );
  };

  const haceHoras = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  // ── Sin configurar no vigila ──────────────────────────────────────────

  it("con los dos topes en NULL no alerta nada: sin configurar es sin vigilar", async () => {
    await config({});
    const eq = await equipoCon(500);
    for (let i = 0; i < 5; i++) expect((await despachar(400, { equipo_id: eq })).status).toBe(201);

    expect(await topesDe((d) => d.equipoId === eq)).toHaveLength(0);
  });

  // ── 1. El robo repartido ──────────────────────────────────────────────

  it("tres vales chicos al mismo equipo suman y cruzan el techo", async () => {
    // Exactamente la simulación: tanque de 500 L, tope de 2 llenados = 1.000 L.
    // Ningún vale de 400 excede por sí solo -- eso es lo que miraba el
    // control viejo, y por eso pasaban los tres.
    await config({ llenados_por_dia_max: 2 });
    const eq = await equipoCon(500);

    expect((await despachar(400, { equipo_id: eq })).status).toBe(201);
    expect(await topesDe((d) => d.equipoId === eq)).toHaveLength(0);

    expect((await despachar(400, { equipo_id: eq })).status).toBe(201);
    expect(await topesDe((d) => d.equipoId === eq)).toHaveLength(0); // 800 <= 1000

    expect((await despachar(400, { equipo_id: eq })).status).toBe(201); // 1200 > 1000

    const al = await topesDe((d) => d.equipoId === eq);
    expect(al).toHaveLength(1);
    expect(Number(al[0].detalle.acumuladoL)).toBe(1200);
    expect(Number(al[0].detalle.topeL)).toBe(1000);
    expect(Number(al[0].detalle.valesEnLaVentana)).toBe(3);
  });

  it("alerta solo el vale que CRUZA, no cada vale posterior", async () => {
    // Un aviso repetido por la misma situación es el ruido que hace que
    // nadie mire las alertas -- la lección de "marcar todas leídas".
    await config({ llenados_por_dia_max: 1 });
    const eq = await equipoCon(1000);

    await despachar(900, { equipo_id: eq });
    await despachar(300, { equipo_id: eq }); // cruza: 1200 > 1000
    await despachar(300, { equipo_id: eq }); // sigue pasado, pero no es nuevo
    await despachar(300, { equipo_id: eq });

    expect(await topesDe((d) => d.equipoId === eq)).toHaveLength(1);
  });

  it("no bloquea el vale: un despacho que cruza el techo igual se registra", async () => {
    // Bloquearlo haría que el operador deje de registrarlo, y un despacho
    // sin registrar es peor que uno marcado.
    await config({ llenados_por_dia_max: 1 });
    const eq = await equipoCon(500);
    const res = await despachar(5000, { equipo_id: eq });
    expect(res.status).toBe(201);
    expect(await topesDe((d) => d.equipoId === eq)).toHaveLength(1);
  });

  it("la ventana es móvil de 24 h: lo de anteayer ya no suma", async () => {
    await config({ llenados_por_dia_max: 2 });
    const eq = await equipoCon(500);

    await despachar(900, { equipo_id: eq }, haceHoras(48));
    await despachar(900, { equipo_id: eq });

    // 900 + 900 pasaría el techo de 1.000 si la ventana fuera infinita; con
    // 24 h el primero quedó afuera.
    expect(await topesDe((d) => d.equipoId === eq)).toHaveLength(0);
  });

  it("un equipo SIN capacidad cargada cae al tope absoluto", async () => {
    // Hoy todas las capacidades están en NULL: si el equipo sin capacidad no
    // cayera a ningún techo, el control entero sería decorativo.
    await config({ llenados_por_dia_max: 2, tope_diario_sin_capacidad_l: 1000 });
    const eq = await equipoCon(null);

    await despachar(600, { equipo_id: eq });
    await despachar(600, { equipo_id: eq });

    const al = await topesDe((d) => d.equipoId === eq);
    expect(al).toHaveLength(1);
    expect(Number(al[0].detalle.topeL)).toBe(1000);
  });

  // ── 2. El destino sin equipo ──────────────────────────────────────────

  it("planta tenía cero techo y ahora lo tiene", async () => {
    await config({ tope_diario_sin_capacidad_l: 2000 });

    await despachar(1500, { tipo_destino: "planta" });
    expect(await topesDe((d) => d.tipoDestino === "planta")).toHaveLength(0);

    await despachar(800, { tipo_destino: "planta" });

    const al = await topesDe((d) => d.tipoDestino === "planta");
    expect(al).toHaveLength(1);
    expect(Number(al[0].detalle.acumuladoL)).toBe(2300);
  });

  it("planta y reserva se cuentan por separado: son actores distintos", async () => {
    await config({ tope_diario_sin_capacidad_l: 3000 });

    await despachar(2500, { tipo_destino: "planta" });
    await despachar(2500, { tipo_destino: "reserva_cubeta" });

    // 5.000 L entre los dos, pero ninguno pasó su propio techo de 3.000.
    expect(await topesDe((d) => d.tipoDestino === "reserva_cubeta")).toHaveLength(0);
  });

  // ── 3. La puerta de atrás: aflojar el control ─────────────────────────

  it("subir un tope queda auditado como reducción de vigilancia", async () => {
    await config({ tope_diario_sin_capacidad_l: 1000 });
    const res = await config({ tope_diario_sin_capacidad_l: 90000 });
    expect(res.status).toBe(200);

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle FROM platform_audit_log
         WHERE tenant_id = $1 AND accion = 'combustible.config_vigilancia_reducida'
         ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    const aflojados = log.rows[0].detalle.aflojados as { control: string; a: string }[];
    expect(aflojados.some((c) => c.control.includes("Tope diario"))).toBe(true);
  });

  it("apagar un tope (ponerlo en NULL) también es aflojar", async () => {
    await config({ llenados_por_dia_max: 2 });
    await config({ llenados_por_dia_max: null });

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle FROM platform_audit_log
         WHERE tenant_id = $1 AND accion = 'combustible.config_vigilancia_reducida'
         ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    const aflojados = log.rows[0].detalle.aflojados as { control: string; a: string }[];
    expect(aflojados.some((c) => c.a.includes("sin configurar"))).toBe(true);
  });

  it("ENDURECER no dispara el aviso: encender un control nunca es aflojar", async () => {
    await config({ tope_diario_sin_capacidad_l: null });
    const antes = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM platform_audit_log
         WHERE tenant_id = $1 AND accion = 'combustible.config_vigilancia_reducida'`,
        [tenantId]
      )
    );

    await config({ tope_diario_sin_capacidad_l: 500 });

    const despues = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM platform_audit_log
         WHERE tenant_id = $1 AND accion = 'combustible.config_vigilancia_reducida'`,
        [tenantId]
      )
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it("el tope se guarda y vuelve en el GET de config", async () => {
    await config({ llenados_por_dia_max: 2.5, tope_diario_sin_capacidad_l: 4000 });
    const res = await ag.get("/api/erp/combustible/config");
    expect(Number(res.body.llenados_por_dia_max)).toBe(2.5);
    expect(Number(res.body.tope_diario_sin_capacidad_l)).toBe(4000);
  });

  it("un tope en cero se rechaza: cero no es 'estricto', es 'nadie puede recibir nada'", async () => {
    expect((await config({ llenados_por_dia_max: 0 })).status).toBe(400);
    expect((await config({ tope_diario_sin_capacidad_l: 0 })).status).toBe(400);
  });
});
