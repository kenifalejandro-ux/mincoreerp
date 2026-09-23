/** tests/combustible-quinta-auditoria.test.ts
 *
 * Los diez ataques de la 5ª auditoría (red team técnico, 2026-09-14), cada uno
 * convertido en test. Todos se verificaron ANTES contra la API y pasaron sin
 * una sola alerta; acá están del otro lado.
 *
 * El método, de las rondas anteriores: cada ataque con su GEMELO de control.
 * Si el gemelo no alerta, el "no alertó" del ataque no prueba nada -- así se
 * cayeron dos hallazgos falsos en auditorías previas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant, pool } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";
import { TIPOS_ALERTA, TIPOS_CONGELABLES } from "../src/modules/combustible/combustible.repository";

/** Minutos desde ahora. El margen del schema es de 1 h, así que todo esto
 *  entra: fechar en hora futura más allá de eso se rechaza y el ataque
 *  "no alerta" por el motivo equivocado (trampa vivida en la 4ª ronda). */
const en = (minutos: number) => new Date(Date.now() + minutos * 60_000).toISOString();
const serieUnica = () => `S${Math.floor(Math.random() * 1e8).toString(36)}`;

describe("combustible: los diez huecos de la 5ª auditoría", () => {
  let tenantId: string;
  let slug: string;
  let grifoId: number;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const operador = request.agent(app);
  const grifero = request.agent(app);
  let seq = 0;

  async function altaYLogin(agente: ReturnType<typeof request.agent>, rol: string) {
    const dni = String(84100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    const entro = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entro.status).toBe(200);
    return alta.body.id as string;
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

  async function tanque(over: Record<string, unknown> = {}) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque auditado",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "personalizado",
      umbral_diferencia_pct: 1,
      umbral_descuadre_pct: 1,
      umbral_descuadre_ciclo_pct: 1,
      umbral_descuadre_ventana_pct: 2,
      ...over,
    });
    expect(r.status).toBe(201);
    return r.body as { id: number; codigo: string };
  }

  const leer = (ag: ReturnType<typeof request.agent>, tq: number, nivel: number, cuando: string) =>
    ag.post("/api/erp/combustible/lecturas").send({ combustible_id: tq, nivel, leido_en: cuando });

  const recibir = (
    ag: ReturnType<typeof request.agent>,
    tq: number,
    cantidad: number,
    cuando: string
  ) =>
    ag.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: grifoId,
      cantidad,
      costo_unitario: 16.8,
      recibido_en: cuando,
    });

  const vale = (
    ag: ReturnType<typeof request.agent>,
    tq: number,
    over: Record<string, unknown> = {}
  ) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "planta",
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16.8,
      despachado_en: new Date().toISOString(),
      ...over,
    });

  async function alertasDe(tq: number) {
    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    return (
      r.body.data as {
        tipo: string;
        combustible_id: number | null;
        id: number;
        detalle: Record<string, unknown>;
      }[]
    ).filter((a) => a.combustible_id === tq);
  }
  const tipos = (as: { tipo: string }[]) => [...new Set(as.map((a) => a.tipo))].sort();

  // ── C1: la lista de tipos no puede volver a desincronizarse ────────────

  it("los CHECK de la base aceptan EXACTAMENTE los tipos que el código declara", async () => {
    // El peor hallazgo de la ronda no fue un robo: el CHECK de anomalías se
    // quedó en 0076 con seis tipos mientras el worker congelaba nueve. Una
    // alerta sin revisar hacía fallar el INSERT y se caía la conciliación
    // ENTERA del tenant -- incluida la alerta de "tanque sin medir".
    const leerCheck = async (constraint: string) => {
      const r = await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
        [constraint]
      );
      expect(r.rows[0], `falta el constraint ${constraint}`).toBeDefined();
      return new Set([...r.rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };

    expect(await leerCheck("combustible_alertas_tipo_check")).toEqual(new Set(TIPOS_ALERTA));
    expect(await leerCheck("combustible_anomalias_tipo_check")).toEqual(new Set(TIPOS_CONGELABLES));
  });

  it("una alerta de ventana vencida se congela y NO tumba el resto de la corrida", async () => {
    const tq = await tanque({ umbral_descuadre_pct: 50, umbral_descuadre_ciclo_pct: null });
    await leer(admin, tq.id, 9500, en(1));
    await leer(admin, tq.id, 9500, en(2));
    expect(tipos(await alertasDe(tq.id))).toContain("descuadre_ventana");

    // Otro tanque del mismo tenant que lleva días sin medir: es lo que la
    // corrida tiene que seguir detectando aunque la de arriba falle.
    const ciego = await tanque();
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_lecturas SET leido_en = now() - interval '30 days'
          WHERE tenant_id = $1 AND combustible_id = $2`,
        [tenantId, ciego.id]
      )
    );
    // La alerta de ventana ya pasó su ventana de gracia.
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_alertas SET creado_en = now() - interval '5 days'
          WHERE tenant_id = $1 AND combustible_id = $2`,
        [tenantId, tq.id]
      )
    );

    await correrConciliacion(tenantId);

    const anomalias = await admin.get("/api/erp/combustible/anomalias").query({ pageSize: 200 });
    expect(
      (anomalias.body.data as { tipo: string; combustible_id: number }[]).some(
        (a) => a.tipo === "descuadre_ventana" && a.combustible_id === tq.id
      )
    ).toBe(true);
    // Y lo que antes se perdía con el ROLLBACK:
    expect(tipos(await alertasDe(ciego.id))).toContain("tanque_sin_medir");
  });

  // ── A1: el salto de talonario ──────────────────────────────────────────

  it("un vale que salta miles de números se rechaza; uno que salta pocos entra", async () => {
    const tq = await tanque();
    const serie = serieUnica();
    expect((await vale(operador, tq.id, { serie_talonario: serie, n_vale: 1 })).status).toBe(201);

    const salto = await vale(operador, tq.id, { serie_talonario: serie, n_vale: 5001 });
    expect(salto.status).toBe(400);
    expect(salto.body.error).toMatch(/salta/i);

    // El hueco legítimo (dos talonarios de la misma serie en paralelo) sigue
    // entrando, y genera sus alertas de hueco como siempre.
    const normal = await vale(operador, tq.id, { serie_talonario: serie, n_vale: 41 });
    expect(normal.status).toBe(201);
    const huecos = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    const delSerie = (
      huecos.body.data as { tipo: string; serie_talonario: string | null }[]
    ).filter((a) => a.serie_talonario === serie && a.tipo === "hueco_detectado");
    expect(delSerie.length).toBe(39);
  });

  // ── M1: una alerta abierta por tanque, no una por varilla ──────────────

  it("el acumulado repetido actualiza la MISMA alerta en vez de crear cinco", async () => {
    const tq = await tanque({ umbral_descuadre_pct: 50, umbral_descuadre_ciclo_pct: null });
    for (let i = 1; i <= 5; i++) await leer(admin, tq.id, 9500, en(i));

    const ventana = (await alertasDe(tq.id)).filter((a) => a.tipo === "descuadre_ventana");
    expect(ventana).toHaveLength(1);
    // Y dice cuántas veces se repitió, que es el dato que se perdía.
    expect(Number(ventana[0].detalle.repeticiones)).toBeGreaterThan(1);
  });

  // ── C4: la recepción sub-declarada ─────────────────────────────────────

  it("la recepción nace pendiente de validación y validarla con otra cantidad alerta", async () => {
    const tq = await tanque();
    await leer(grifero, tq.id, 10000, en(1));
    // El grifero registra 9.000 de una entrega de 10.000...
    const rec = await recibir(grifero, tq.id, 9000, en(2));
    expect(rec.status).toBe(201);
    expect(rec.body.requiere_validacion).toBe(true);
    // ...y se lleva la diferencia antes de medir: el tanque cuadra.
    await leer(grifero, tq.id, 19000, en(3));
    await correrConciliacion(tenantId);
    expect(tipos(await alertasDe(tq.id))).not.toContain("descuadre_inventario");

    // Administración escribe lo que dice la guía. Ahí aparece.
    const validada = await admin
      .patch(`/api/erp/combustible/recepciones/${rec.body.id}/validar`)
      .send({ cantidad_documento: 10000 });
    expect(validada.status).toBe(200);
    expect(validada.body.discrepancia.diferencia).toBe(1000);
    expect(validada.body.discrepancia.sentido).toBe("registrada_de_menos");
    expect(tipos(await alertasDe(tq.id))).toContain("recepcion_discrepante");

    // Y no se puede validar dos veces (no se pisa quién validó y con qué).
    const repetida = await admin
      .patch(`/api/erp/combustible/recepciones/${rec.body.id}/validar`)
      .send({ cantidad_documento: 9000 });
    expect(repetida.status).toBe(409);
  });

  it("validar con la cantidad correcta no genera ninguna alerta", async () => {
    const tq = await tanque();
    await leer(grifero, tq.id, 10000, en(1));
    const rec = await recibir(grifero, tq.id, 5000, en(2));
    const validada = await admin
      .patch(`/api/erp/combustible/recepciones/${rec.body.id}/validar`)
      .send({ cantidad_documento: 5000 });
    expect(validada.status).toBe(200);
    expect(validada.body.discrepancia).toBeNull();
    expect(tipos(await alertasDe(tq.id))).not.toContain("recepcion_discrepante");
  });

  it("el grifero no puede validar lo que él mismo registró (403)", async () => {
    const tq = await tanque();
    await leer(grifero, tq.id, 10000, en(1));
    const rec = await recibir(grifero, tq.id, 1000, en(2));
    const intento = await grifero
      .patch(`/api/erp/combustible/recepciones/${rec.body.id}/validar`)
      .send({ cantidad_documento: 1000 });
    expect(intento.status).toBe(403);
  });

  it("la recepción sin validar alerta pasado el plazo, y validarla cierra la alerta", async () => {
    const tq = await tanque();
    await leer(grifero, tq.id, 10000, en(1));
    const rec = await recibir(grifero, tq.id, 2000, en(2));
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_recepciones SET creado_en = now() - interval '10 days'
          WHERE id = $1 AND tenant_id = $2`,
        [rec.body.id, tenantId]
      )
    );

    await correrConciliacion(tenantId);
    expect(tipos(await alertasDe(tq.id))).toContain("recepcion_sin_validar");

    await admin
      .patch(`/api/erp/combustible/recepciones/${rec.body.id}/validar`)
      .send({ cantidad_documento: 2000 });

    // La alerta NO desaparece de la lista (es evidencia de que hubo demora),
    // pero queda resuelta: la validación es el hecho que la cierra, sin que
    // nadie tenga que apretar un botón.
    const detalle = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    const sinValidar = (
      detalle.body.data as {
        tipo: string;
        recepcion_id: number | null;
        resuelta_en: string | null;
      }[]
    ).find(
      (a) => a.tipo === "recepcion_sin_validar" && Number(a.recepcion_id) === Number(rec.body.id)
    );
    expect(sinValidar).toBeDefined();
    expect(sinValidar!.resuelta_en).not.toBeNull();
  });

  // ── M2/M3: fecha futura, anulación ─────────────────────────────────────

  it("una recepción con fecha futura se rechaza", async () => {
    const tq = await tanque();
    const r = await recibir(admin, tq.id, 100, new Date(Date.now() + 400 * 864e5).toISOString());
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/futura/i);
  });

  it("una recepción fechada hace 10 días, detrás de movimientos ya existentes, alerta", async () => {
    // El default de días de carga retroactiva es 3. Mismo criterio EXACTO que
    // el vale retro-fechado: no importa que sea vieja, importa que haya algo
    // MÁS RECIENTE detrás de lo cual esconderla. La recepción retro necesita
    // una lectura vigente ANTERIOR a su fecha para poder registrarse (0064):
    // por eso la varilla más vieja queda 20 días atrás y la retro, 10.
    const tq = await tanque();
    await leer(admin, tq.id, 10000, new Date(Date.now() - 20 * 864e5).toISOString());
    await leer(admin, tq.id, 10500, en(1));
    await recibir(admin, tq.id, 3000, en(2)); // movimiento reciente ya existente
    const atras = await recibir(
      admin,
      tq.id,
      1000,
      new Date(Date.now() - 10 * 864e5).toISOString()
    );
    expect(atras.status).toBe(201);
    expect(tipos(await alertasDe(tq.id))).toContain("recepcion_retroactiva");
  });

  it("cargar el historial hacia atrás en un tanque SIN movimiento previo no alerta", async () => {
    // El gemelo de control: sin nada detrás de qué esconderse, no hay nada
    // sospechoso -- es la carga inicial legítima de cualquier cliente nuevo.
    const tq = await tanque();
    await leer(admin, tq.id, 10000, new Date(Date.now() - 20 * 864e5).toISOString());
    const atras = await recibir(
      admin,
      tq.id,
      1000,
      new Date(Date.now() - 10 * 864e5).toISOString()
    );
    expect(atras.status).toBe(201);
    expect(tipos(await alertasDe(tq.id))).not.toContain("recepcion_retroactiva");
  });

  it("anular una recepción genera alerta", async () => {
    const tq = await tanque();
    await leer(admin, tq.id, 10000, en(1));
    const rec = await recibir(admin, tq.id, 3000, en(2));
    const anulada = await admin
      .patch(`/api/erp/combustible/recepciones/${rec.body.id}/anular`)
      .send({ motivo: "se cargó dos veces" });
    expect(anulada.status).toBe(200);
    expect(tipos(await alertasDe(tq.id))).toContain("recepcion_anulada");
  });

  // ── A2: las micro-recepciones ya no apagan el ciclo ────────────────────

  it("dos recepciones de 1 L no reinician el ciclo ni borran la diferencia", async () => {
    const tq = await tanque({ umbral_descuadre_pct: 2, umbral_descuadre_ciclo_pct: 1 });
    let nivel = 10000;
    await leer(grifero, tq.id, nivel, en(1));
    let minuto = 2;
    for (let k = 1; k <= 4; k++) {
      if (k % 2 === 0) {
        await recibir(grifero, tq.id, 1, en(minuto++));
        await recibir(grifero, tq.id, 1, en(minuto++));
        nivel += 2;
      }
      nivel -= 150;
      await leer(grifero, tq.id, nivel, en(minuto++));
    }
    // 600 L de faltante repartidos en tramos de 150: ningún tramo cruza el
    // 2 % (400 L), y antes las micro-recepciones borraban el acumulado.
    expect(tipos(await alertasDe(tq.id))).toContain("descuadre_ciclo");
  });

  // ── A3: el tope diario y la fecha hacia atrás ──────────────────────────

  it("tres vales fechados hacia atrás suman en la misma ventana de 24 h", async () => {
    const cfg = await admin.get("/api/erp/combustible/config");
    const guardar = await admin
      .put("/api/erp/combustible/config")
      .send({ ...cfg.body, tope_diario_sin_capacidad_l: 500 });
    expect(guardar.status).toBe(200);

    const tq = await tanque({
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    const ahora = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const comun = { tipo_destino: "reserva_cubeta", cantidad: 400, lectura_contometro: 400 };
    expect((await vale(operador, tq.id, { ...comun, despachado_en: iso(ahora) })).status).toBe(201);
    // El vale de atrás: antes quedaba solo en su propia ventana y no sumaba.
    expect(
      (await vale(operador, tq.id, { ...comun, despachado_en: iso(ahora - 3600e3) })).status
    ).toBe(201);

    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    const topes = (r.body.data as { tipo: string; detalle: Record<string, unknown> }[]).filter(
      (a) => a.tipo === "tope_diario_excedido" && a.detalle.tipoDestino === "reserva_cubeta"
    );
    expect(topes.length).toBeGreaterThan(0);
    expect(Number(topes[0].detalle.acumuladoL)).toBe(800);
  });

  // ── A4: la autorrevisión de la varilla propia ──────────────────────────

  it("cerrar la alerta de descuadre de la varilla propia cuenta como autorrevisión", async () => {
    const tq = await tanque();
    await leer(admin, tq.id, 10000, en(1));
    await leer(admin, tq.id, 9000, en(2));
    const alerta = (await alertasDe(tq.id)).find((a) => a.tipo === "descuadre_inventario");
    expect(alerta).toBeDefined();

    const resuelta = await admin
      .patch(`/api/erp/combustible/alertas/${alerta!.id}/resolver`)
      .send({ motivo: "error de varilla" });
    expect(resuelta.status).toBe(200);
    expect(resuelta.body.autorevision).toBe(true);
  });

  // ── V2: la varilla que copia el teórico ────────────────────────────────

  it("varillas que cuadran al litro cuatro veces seguidas alertan", async () => {
    const tq = await tanque({
      umbral_descuadre_pct: 50,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    let nivel = 10000;
    let minuto = 1;
    await leer(grifero, tq.id, nivel, en(minuto++));
    for (let k = 0; k < 5; k++) {
      const serie = serieUnica();
      await vale(grifero, tq.id, {
        serie_talonario: serie,
        n_vale: 1,
        cantidad: 120,
        lectura_contometro: 120,
        despachado_en: en(minuto),
      });
      nivel -= 120; // la varilla dice EXACTAMENTE lo que el sistema espera
      await leer(grifero, tq.id, nivel, en(minuto + 1));
      minuto += 2;
    }
    expect(tipos(await alertasDe(tq.id))).toContain("varilla_exacta");
  });

  it("una varilla con el ruido normal de medición NO dispara esa alerta", async () => {
    const tq = await tanque({
      umbral_descuadre_pct: 50,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    let nivel = 10000;
    let minuto = 1;
    await leer(grifero, tq.id, nivel, en(minuto++));
    const ruido = [12, -9, 15, -7, 11];
    for (let k = 0; k < 5; k++) {
      const serie = serieUnica();
      await vale(grifero, tq.id, {
        serie_talonario: serie,
        n_vale: 1,
        cantidad: 120,
        lectura_contometro: 120,
        despachado_en: en(minuto),
      });
      nivel -= 120 - ruido[k];
      await leer(grifero, tq.id, nivel, en(minuto + 1));
      minuto += 2;
    }
    expect(tipos(await alertasDe(tq.id))).not.toContain("varilla_exacta");
  });

  it("el tanque medido solo por griferos alerta, y una varilla del operador la cierra", async () => {
    const tq = await tanque({
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    await vale(grifero, tq.id, { cantidad: 50, lectura_contometro: 50 });
    await leer(grifero, tq.id, 9950, en(1));

    await correrConciliacion(tenantId);
    expect(tipos(await alertasDe(tq.id))).toContain("varilla_sin_control");

    await leer(operador, tq.id, 9950, en(2));
    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    const abierta = (
      r.body.data as { tipo: string; combustible_id: number | null; resuelta_en: string | null }[]
    ).find(
      (a) =>
        a.tipo === "varilla_sin_control" && a.combustible_id === tq.id && a.resuelta_en === null
    );
    expect(abierta).toBeUndefined();
  });

  // ── V6/A5: el consumo por hora de motor ────────────────────────────────

  it("el vale del tanque propio acepta horómetro y alerta el consumo excedido", async () => {
    const equipo = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      tipo_medidor: "horometro",
      consumo_maximo_l: 20,
    });
    expect(equipo.status).toBe(201);
    const tq = await tanque({
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });

    // Dos cargas normales: 200 L en 10 horas de motor = 20 L/h.
    const carga = async (horometro: number, cantidad: number, minuto: number) =>
      vale(operador, tq.id, {
        tipo_destino: "equipo",
        equipo_id: equipo.body.id,
        serie_talonario: serieUnica(),
        n_vale: 1,
        cantidad,
        lectura_contometro: cantidad,
        lectura_horometro: horometro,
        despachado_en: en(minuto),
      });
    expect((await carga(1000, 200, 1)).status).toBe(201);
    expect((await carga(1010, 200, 2)).status).toBe(201);

    // Tercera: 600 L para 5 horas más. El tanque cuadra perfecto -- lo que no
    // cuadra es el trabajo que ese combustible tendría que haber hecho.
    expect((await carga(1015, 600, 3)).status).toBe(201);

    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 500 });
    const consumo = (r.body.data as { tipo: string; detalle: Record<string, unknown> }[]).filter(
      (a) => a.tipo === "consumo_excedido"
    );
    expect(consumo.length).toBeGreaterThan(0);
    expect(Number(consumo[0].detalle.consumoMaximo)).toBe(20);
  });

  it("la sugerencia de consumo no inventa un número sin muestra suficiente", async () => {
    const equipo = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("EX"), tipo: "Excavadora", tipo_medidor: "horometro" });
    const r = await admin.get(`/api/erp/combustible/equipos/${equipo.body.id}/sugerencia-consumo`);
    expect(r.status).toBe(200);
    expect(r.body.muestraSuficiente).toBe(false);
    expect(r.body.sugerido).toBeUndefined();
  });

  // ── M5/M6: config con motivo, costo del vale ───────────────────────────

  it("aflojar la configuración sin motivo se rechaza, con motivo se guarda y se audita", async () => {
    const cfg = await admin.get("/api/erp/combustible/config");
    const sinMotivo = await admin
      .put("/api/erp/combustible/config")
      .send({ ...cfg.body, recepcion_requiere_validacion: false });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.requiere_motivo).toBe(true);

    const conMotivo = await admin.put("/api/erp/combustible/config").send({
      ...cfg.body,
      recepcion_requiere_validacion: false,
      motivo_ajuste: "la encargada está de vacaciones dos semanas",
    });
    expect(conMotivo.status).toBe(200);

    const bitacora = await admin.get("/api/erp/combustible/bitacora").query({ pageSize: 50 });
    expect(
      (bitacora.body.data as { accion: string }[]).some(
        (e) => e.accion === "combustible.config_vigilancia_reducida"
      )
    ).toBe(true);

    // Se deja como estaba para no contaminar los tests que siguen.
    await admin
      .put("/api/erp/combustible/config")
      .send({ ...cfg.body, recepcion_requiere_validacion: true });
  });

  // ── Los tres que faltaban del informe ──────────────────────────────────

  it("la calibración avisa de las mediciones fuera de escala y ofrece el número sin ellas", async () => {
    // El punto ciego: la muestra con la que se calibra puede tener adentro el
    // robo que se quiere detectar. Diez tramos de ruido normal y dos enormes
    // -- que es exactamente lo que pasó en el tenant de pruebas, donde la
    // sugerencia saltó de 1,8 % a 14,5 %.
    const tq = await tanque({
      umbral_descuadre_pct: 50,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    let nivel = 18000;
    let minuto = 1;
    await leer(admin, tq.id, nivel, en(minuto++));
    const ruido = [15, -12, 18, -9, 14, -16, 11, -13, 17, -10, 2500, 2200];
    for (const r of ruido) {
      nivel -= r;
      await leer(admin, tq.id, nivel, en(minuto++));
    }

    const sug = await admin.get(`/api/erp/combustible/${tq.id}/sugerencia-umbral`);
    expect(sug.status).toBe(200);
    const balance = sug.body.balance;
    expect(balance.muestraSuficiente).toBe(true);
    expect(balance.atipicos).not.toBeNull();
    expect(balance.atipicos.cantidad).toBeGreaterThanOrEqual(2);
    // Y el par limpio es bastante más chico que el contaminado: si no, el
    // aviso no serviría para decidir nada.
    //
    // Desde 0101 los atípicos se buscan en los RESIDUOS y no en el descuadre
    // crudo: lo que delata a una medición no es su tamaño sino cuánto se
    // aparta de lo que el resto del tanque hace. Una diferencia grande en un
    // tramo que movió mucho puede ser perfectamente normal.
    expect(balance.atipicos.sinEllos.piso).toBeLessThan(balance.piso);
  });

  it("los topes diarios se sugieren desde el historial, sin aplicarse solos", async () => {
    const tq = await tanque({
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    // Doce días con consumo a planta: el mínimo de muestra son 10.
    for (let d = 12; d >= 1; d--) {
      await vale(operador, tq.id, {
        tipo_destino: "planta",
        cantidad: 300 + d,
        lectura_contometro: 300 + d,
        despachado_en: new Date(Date.now() - d * 864e5).toISOString(),
      });
    }

    const r = await admin.get("/api/erp/combustible/config/sugerencia-topes");
    expect(r.status).toBe(200);
    expect(r.body.topeSinCapacidad.muestraSuficiente).toBe(true);
    expect(r.body.topeSinCapacidad.actorQueLoDefine).toBe("planta");
    expect(r.body.topeSinCapacidad.sugeridoL).toBeGreaterThan(300);

    // Sugerir NO guarda: el tope sigue como estaba hasta que alguien decida.
    const cfg = await admin.get("/api/erp/combustible/config");
    expect(cfg.body.tope_diario_sin_capacidad_l).not.toBe(r.body.topeSinCapacidad.sugeridoL);
  });

  it("una línea base APROBADA no se puede borrar", async () => {
    const lb = await admin.post("/api/erp/iperc/lineas-base").send({
      proceso_actividad: "Carguío y acarreo",
      area_frente: idUnico("Frente"),
      items: [
        {
          etapa_actividad: "Carguío",
          peligro: "Material inestable",
          riesgo: "Deslizamiento",
          probabilidad: 4,
          severidad: 3,
          medidas_control: "Inspección de talud",
        },
      ],
    });
    expect(lb.status).toBe(201);

    const aprobada = await admin
      .patch(`/api/erp/iperc/lineas-base/${lb.body.id}/estado`)
      .send({ estado: "aprobado" });
    expect(aprobada.status).toBe(200);

    const borrar = await admin.delete(`/api/erp/iperc/lineas-base/${lb.body.id}`);
    expect(borrar.status).toBe(409);

    // Y la que sigue en borrador sí se borra, con su contenido en la auditoría.
    const borrador = await admin.post("/api/erp/iperc/lineas-base").send({
      proceso_actividad: "Perforación",
      area_frente: idUnico("Frente"),
      items: [
        {
          etapa_actividad: "Perforación de taladros",
          peligro: "Ruido",
          riesgo: "Hipoacusia",
          probabilidad: 3,
          severidad: 2,
          medidas_control: "Protección auditiva",
        },
      ],
    });
    expect(borrador.status).toBe(201);
    expect((await admin.delete(`/api/erp/iperc/lineas-base/${borrador.body.id}`)).status).toBe(200);
  });

  it("el costo del vale del tanque propio lo pone el servidor, no el body", async () => {
    const tq = await tanque({
      umbral_descuadre_pct: null,
      umbral_descuadre_ciclo_pct: null,
      umbral_descuadre_ventana_pct: null,
    });
    await leer(admin, tq.id, 10000, en(1));
    // Una compra a S/ 16 fija el costo promedio del tanque.
    await recibir(admin, tq.id, 5000, en(2));

    const despacho = await vale(operador, tq.id, {
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 0.01,
    });
    expect(despacho.status).toBe(201);
    expect(Number(despacho.body.costo_unitario)).toBeCloseTo(16.8, 2);
  });
});
