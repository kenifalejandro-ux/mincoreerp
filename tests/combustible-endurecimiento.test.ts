/** tests/combustible-endurecimiento.test.ts
 *
 * Los cuatro hallazgos de AUDITORÍA Y PROCESO de la revisión adversaria
 * (migración 0077). No son agujeros de detección -- el sistema veía el
 * hecho -- sino de qué queda registrado y quién puede cerrar qué.
 *
 * #3 Apagar la vigilancia se auditaba igual que renombrar el tanque: pasar
 *    `umbral_descuadre_pct` de 1% a 90% guardaba con 200 y dejaba
 *    `{ combustibleId }` en el log, sin valores ni motivo.
 * #4 Cuatro tipos de alerta no tenían NINGÚN camino de cierre: se
 *    acumulaban abiertos para siempre, y lo único que los sacaba de la
 *    campanita era "marcar todas leídas", que no es revisar sino tapar.
 * #5 Un vale con fecha futura se aceptaba sin quejas (un mes adelante en la
 *    simulación).
 * #9 Un vale muy por debajo del máximo de su serie entraba en silencio.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serieUnica = () => `S${Date.now().toString(36).slice(-6)}${(seq++).toString(36)}`;

describe("combustible: endurecimiento de auditoría y cierre (migración 0077)", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    const eq = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora" });
    equipoId = eq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function crearTanque(umbral: number | null = 1) {
    const res = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque endurecido",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 20000,
      umbral_descuadre_pct: umbral,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  /** El PUT reemplaza la fila entera, así que hay que mandarla completa. */
  function payloadEdicion(tanque: Record<string, unknown>, cambios: Record<string, unknown> = {}) {
    return {
      codigo: tanque.codigo,
      tanque_nombre: tanque.tanque_nombre,
      tipo_combustible: tanque.tipo_combustible,
      unidad: tanque.unidad,
      tipo_punto: tanque.tipo_punto,
      capacidad_total: Number(tanque.capacidad_total),
      nivel_minimo: Number(tanque.nivel_minimo),
      moneda: tanque.moneda,
      activo: tanque.activo,
      tolerancia_capacidad_pct: Number(tanque.tolerancia_capacidad_pct),
      requiere_documento: tanque.requiere_documento,
      umbral_diferencia_pct:
        tanque.umbral_diferencia_pct === null ? null : Number(tanque.umbral_diferencia_pct),
      umbral_descuadre_pct:
        tanque.umbral_descuadre_pct === null ? null : Number(tanque.umbral_descuadre_pct),
      umbral_descuadre_ciclo_pct:
        tanque.umbral_descuadre_ciclo_pct === null
          ? null
          : Number(tanque.umbral_descuadre_ciclo_pct),
      umbral_descuadre_ventana_pct:
        tanque.umbral_descuadre_ventana_pct === null
          ? null
          : Number(tanque.umbral_descuadre_ventana_pct),
      ...cambios,
    };
  }

  const auditoriaDe = async (accion: string) =>
    withTenant(tenantId, (c) =>
      c.query(
        `SELECT accion, detalle FROM platform_audit_log
         WHERE tenant_id = $1 AND accion = $2 ORDER BY id DESC LIMIT 5`,
        [tenantId, accion]
      )
    );

  // ── #3: apagar la vigilancia deja rastro ──────────────────────────────

  it("subir un umbral SIN motivo se rechaza y dice qué se está aflojando", async () => {
    const tq = await crearTanque(1);
    const res = await agente
      .put(`/api/erp/combustible/${tq.id}`)
      .send(payloadEdicion(tq, { umbral_descuadre_pct: 90 }));

    expect(res.status).toBe(400);
    expect(res.body.requiere_motivo).toBe(true);
    expect(res.body.error).toContain("1%");
    expect(res.body.error).toContain("90%");
  });

  it("apagar un umbral (número → null) también cuenta como aflojar", async () => {
    const tq = await crearTanque(1);
    const res = await agente
      .put(`/api/erp/combustible/${tq.id}`)
      .send(payloadEdicion(tq, { umbral_descuadre_pct: null }));

    expect(res.status).toBe(400);
    expect(res.body.requiere_motivo).toBe(true);
    expect(res.body.error).toContain("no alerta");
  });

  it("con motivo se guarda, y la auditoría registra la acción propia con valores y motivo", async () => {
    const tq = await crearTanque(1);
    const res = await agente.put(`/api/erp/combustible/${tq.id}`).send(
      payloadEdicion(tq, {
        umbral_descuadre_pct: 90,
        motivo_ajuste: "Varilla nueva sin calibrar, se afloja una semana",
      })
    );
    expect(res.status).toBe(200);

    const log = await auditoriaDe("combustible.tanque_vigilancia_reducida");
    expect(log.rows.length).toBeGreaterThan(0);
    const detalle = log.rows[0].detalle;
    expect(detalle.motivo).toContain("Varilla nueva");
    expect(detalle.aflojados[0].de).toBe("1%");
    expect(detalle.aflojados[0].a).toBe("90%");
  });

  it("ENDURECER no pide motivo: bajar el umbral vigila más, no menos", async () => {
    const tq = await crearTanque(5);
    const res = await agente
      .put(`/api/erp/combustible/${tq.id}`)
      .send(payloadEdicion(tq, { umbral_descuadre_pct: 1 }));
    expect(res.status).toBe(200);
  });

  it("encender un umbral apagado (null → número) tampoco pide motivo", async () => {
    // El caso que un `nuevo > viejo` ingenuo leería mal: Number(null) es 0,
    // así que null → 2 parecería un aflojamiento cuando es lo contrario.
    const tq = await crearTanque(null);
    const res = await agente
      .put(`/api/erp/combustible/${tq.id}`)
      .send(payloadEdicion(tq, { umbral_descuadre_pct: 2 }));
    expect(res.status).toBe(200);
  });

  it("renombrar el tanque no pide motivo ni usa la acción de vigilancia", async () => {
    const tq = await crearTanque(1);
    const res = await agente
      .put(`/api/erp/combustible/${tq.id}`)
      .send(payloadEdicion(tq, { tanque_nombre: "Nombre nuevo" }));
    expect(res.status).toBe(200);

    const log = await auditoriaDe("combustible.tanque_actualizar");
    expect(log.rows.length).toBeGreaterThan(0);
    expect(log.rows[0].detalle.aflojados).toBeUndefined();
  });

  it("dejar de exigir documento en las recepciones también afloja", async () => {
    const tq = await crearTanque(1);
    const res = await agente
      .put(`/api/erp/combustible/${tq.id}`)
      .send(payloadEdicion(tq, { requiere_documento: false }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("factura");
  });

  // ── #4: las alertas huérfanas ahora se pueden cerrar ──────────────────

  async function alertaDeDescuadre() {
    const tq = await crearTanque(1);
    const t0 = "2026-07-01T08:00:00.000Z";
    const t1 = "2026-07-01T10:00:00.000Z";
    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq.id, nivel: 20000, leido_en: t0 });
    await agente
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq.id, nivel: 17000, leido_en: t1 });

    const r = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const al = r.body.data.find(
      (a: { tipo: string; combustible_id: number }) =>
        a.tipo === "descuadre_inventario" && a.combustible_id === tq.id
    );
    expect(al).toBeDefined();
    return al;
  }

  it("un descuadre ya se puede dar por revisado (antes no tenía cierre)", async () => {
    const al = await alertaDeDescuadre();
    const res = await agente
      .patch(`/api/erp/combustible/alertas/${al.id}/resolver`)
      .send({ motivo: "Fuga en la manguera, ya reparada por mantenimiento" });

    expect(res.status).toBe(200);
    expect(res.body.resuelta_en).not.toBeNull();
    expect(res.body.resuelta_por).not.toBeNull();
    expect(res.body.detalle.motivo_revision).toContain("Fuga en la manguera");
  });

  it("resolver SIN motivo se rechaza: cerrar sin explicar es tapar", async () => {
    const al = await alertaDeDescuadre();
    const res = await agente.patch(`/api/erp/combustible/alertas/${al.id}/resolver`).send({});
    expect(res.status).toBe(400);
  });

  it("las que se resuelven solas NO se pueden cerrar a mano", async () => {
    // Un hueco lo cierra el vale que llega, no una persona: dejar que
    // alguien lo marque revisado sería darle la posibilidad de callar la
    // alarma sin que aparezca el papel.
    const tq = await crearTanque(1);
    const serie = serieUnica();
    const despachar = (n: number) =>
      agente.post("/api/erp/combustible/despachos").send({
        origen: "tanque_propio",
        combustible_id: tq.id,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipoId,
        serie_talonario: serie,
        n_vale: n,
        cantidad: 100,
        lectura_contometro: 100,
        costo_unitario: 16,
      });
    await despachar(1);
    await despachar(4); // revela los huecos 2 y 3

    const r = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const hueco = r.body.data.find(
      (a: { tipo: string; serie_talonario: string }) =>
        a.tipo === "hueco_detectado" && a.serie_talonario === serie
    );
    expect(hueco).toBeDefined();

    const res = await agente
      .patch(`/api/erp/combustible/alertas/${hueco.id}/resolver`)
      .send({ motivo: "Intento de cerrar a mano algo que se cierra solo" });
    expect(res.status).toBe(404);
  });

  // ── #5: fecha de vale ─────────────────────────────────────────────────

  it("un vale con fecha FUTURA se rechaza", async () => {
    const tq = await crearTanque(1);
    const dentroDeUnMes = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq.id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
      despachado_en: dentroDeUnMes,
    });
    expect(res.status).toBe(400);
  });

  it("un vale de hace un rato entra sin problema", async () => {
    // El margen de 1 hora existe para los relojes corridos de cancha; una
    // fecha pasada nunca se cuestiona.
    const tq = await crearTanque(1);
    const haceDosHoras = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const res = await agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq.id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
      despachado_en: haceDosHoras,
    });
    expect(res.status).toBe(201);
  });

  // ── #9: vale desordenado ──────────────────────────────────────────────

  const despacharEnSerie = (tanqueId: number, serie: string, n: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: n,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
    });

  it("un vale muy por debajo del máximo, que nadie esperaba, alerta", async () => {
    const tq = await crearTanque(1);
    const serie = serieUnica();
    await despacharEnSerie(tq.id, serie, 50); // primero de la serie: sin huecos
    const bajo = await despacharEnSerie(tq.id, serie, 7);
    expect(bajo.status).toBe(201); // no bloquea, marca

    const r = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const al = r.body.data.find(
      (a: { tipo: string; serie_talonario: string; n_vale: number }) =>
        a.tipo === "vale_fuera_de_orden" && a.serie_talonario === serie && a.n_vale === 7
    );
    expect(al).toBeDefined();
    expect(Number(al.detalle.maxAnteriorDeLaSerie)).toBe(50);
  });

  it("el vale tardío que llena un hueco alertado NO se marca como desordenado", async () => {
    // Es el caso legítimo: sincronizó desde la cola offline. Sin esta
    // distinción, cada vale que llega tarde generaría ruido además de
    // resolver su hueco.
    const tq = await crearTanque(1);
    const serie = serieUnica();
    await despacharEnSerie(tq.id, serie, 1);
    await despacharEnSerie(tq.id, serie, 4); // revela huecos 2 y 3
    const tardio = await despacharEnSerie(tq.id, serie, 2);
    expect(tardio.status).toBe(201);

    const r = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const desorden = r.body.data.filter(
      (a: { tipo: string; serie_talonario: string }) =>
        a.tipo === "vale_fuera_de_orden" && a.serie_talonario === serie
    );
    expect(desorden).toHaveLength(0);
  });

  it("cargar en orden no genera nada", async () => {
    const tq = await crearTanque(1);
    const serie = serieUnica();
    await despacharEnSerie(tq.id, serie, 1);
    await despacharEnSerie(tq.id, serie, 2);
    await despacharEnSerie(tq.id, serie, 3);

    const r = await agente.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    const propias = r.body.data.filter(
      (a: { serie_talonario: string }) => a.serie_talonario === serie
    );
    expect(propias).toHaveLength(0);
  });
});
