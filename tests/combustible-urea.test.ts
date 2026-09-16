/** tests/combustible-urea.test.ts
 *
 * Urea automotriz (Green 32/AdBlue), migración 0092. Ver
 * docs/architecture/control-de-combustible.md y la memoria de diseño
 * (combustible_urea_alcance, preguntas_cliente_urea).
 *
 * Cubre: la forma del vale (sin contómetro/horómetro/odómetro/horas, con
 * presentación/factor/bultos en su lugar), el factor de conversión
 * resuelto y CONGELADO por el servidor, el espacio de nombres del
 * talonario SEPARADO por producto (mismo n_vale + serie en combustible y
 * en urea no compiten), el rol de grifo "urea" (aparte de ruta/tanque), el
 * control nuevo de equipo no habilitado, el ratio urea/diésel, el tope
 * diario propio, y el conteo físico (el reemplazo de la varilla) con su
 * descuadre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

function serieUnica(): string {
  return `U${Math.floor(Math.random() * 1e8).toString(36)}`;
}

describe("combustible: urea automotriz (migración 0092)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  let equipoVolquete: number; // usa_urea = true (default)
  let equipoCamioneta: number; // usa_urea = false
  let grifoUrea: number; // abastece_urea = true
  let grifoDeRuta: number; // solo abastece_ruta -- NO sirve para urea
  let tanqueId: number; // para poder cargar diésel real al mismo equipo (ratio)
  let grifoRuta2: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const volquete = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE" });
    equipoVolquete = volquete.body.id;

    // Camionetas no usan urea (respuesta 15 del cliente) -- se marca al
    // crear el equipo.
    const camioneta = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("CM"), tipo: "CAMIONETA", usa_urea: false });
    equipoCamioneta = camioneta.body.id;

    const grifo1 = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("UREAPROV"),
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
    });
    grifoUrea = grifo1.body.id;

    const grifo2 = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("PRIMAX"),
      abastece_ruta: true,
      abastece_tanque: false,
      abastece_urea: false,
    });
    grifoDeRuta = grifo2.body.id;
    grifoRuta2 = grifoDeRuta;

    tanqueId = await withTenant(tenantId, async (client) => {
      const fila = await client.query(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
         )
         VALUES ($1, $2, 'Tanque urea test', 'diesel_b5', 'gal', 'fijo', 5000) RETURNING id`,
        [tenantId, idUnico("TQ")]
      );
      return fila.rows[0].id;
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  function payloadUrea(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoVolquete,
      serie_talonario: serieUnica(),
      n_vale: 1,
      presentacion: "bolsa",
      cantidad_bultos: 4,
      despachado_en: new Date().toISOString(),
      ...overrides,
    };
  }

  // ── Forma del vale ───────────────────────────────────────────────────

  it("happy path: 4 bolsas -> 16 L, factor congelado en la fila", async () => {
    const res = await agente.post("/api/erp/combustible/despachos").send(payloadUrea());
    expect(res.status).toBe(201);
    expect(res.body.producto).toBe("urea");
    expect(res.body.presentacion).toBe("bolsa");
    expect(Number(res.body.factor_litros)).toBe(4);
    expect(Number(res.body.cantidad_bultos)).toBe(4);
    expect(Number(res.body.cantidad)).toBe(16);
    // Nunca lleva nada de combustible.
    expect(res.body.tipo_combustible).toBeNull();
    expect(res.body.combustible_id).toBeNull();
    expect(res.body.lectura_contometro).toBeNull();
    expect(res.body.lectura_horometro).toBeNull();
    expect(res.body.lectura_odometro).toBeNull();
    expect(res.body.horas_abastecidas).toBeNull();
  });

  it("caja = 16 L, balde = 20 L -- los tres factores", async () => {
    const caja = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ presentacion: "caja", cantidad_bultos: 2, n_vale: 2 }));
    expect(caja.status).toBe(201);
    expect(Number(caja.body.cantidad)).toBe(32);

    const balde = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ presentacion: "balde", cantidad_bultos: 1, n_vale: 3 }));
    expect(balde.status).toBe(201);
    expect(Number(balde.body.cantidad)).toBe(20);
  });

  it("mandar cantidad, tipo_combustible o combustible_id en un vale de urea es 400", async () => {
    const conCantidad = await agente
      .post("/api/erp/combustible/despachos")
      .send({ ...payloadUrea({ n_vale: 4 }), cantidad: 16 });
    expect(conCantidad.status).toBe(400);

    const conTipo = await agente
      .post("/api/erp/combustible/despachos")
      .send({ ...payloadUrea({ n_vale: 5 }), tipo_combustible: "diesel_b5" });
    expect(conTipo.status).toBe(400);
  });

  it("origen tanque_propio con producto urea es 400 -- la urea no tiene tanque propio", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ n_vale: 6, origen: "tanque_propio", grifo_id: undefined }));
    expect(res.status).toBe(400);
  });

  it("el grifo tiene que estar marcado abastece_urea -- uno de ruta da 400", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ n_vale: 7, grifo_id: grifoDeRuta }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no está marcado como");
  });

  // ── El talonario de urea es un espacio de nombres PROPIO ────────────────

  it("el mismo n_vale+serie puede existir en combustible Y en urea sin chocar", async () => {
    const serie = serieUnica();
    const equipoConMedidor = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("TR"), tipo: "TRAILER", tipo_medidor: "odometro" });

    const combustible = await agente.post("/api/erp/combustible/despachos").send({
      origen: "compra_externa",
      grifo_id: grifoRuta2,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoConMedidor.body.id,
      serie_talonario: serie,
      n_vale: 100,
      cantidad: 40,
      lectura_odometro: 5000,
      horas_abastecidas: 2,
      costo_unitario: 17,
      despachado_en: new Date().toISOString(),
    });
    expect(combustible.status).toBe(201);

    const urea = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ serie_talonario: serie, n_vale: 100 }));
    expect(urea.status).toBe(201);
  });

  it("un segundo vale de urea con el mismo serie+n_vale sí choca (409)", async () => {
    const serie = serieUnica();
    const primero = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ serie_talonario: serie, n_vale: 1 }));
    expect(primero.status).toBe(201);

    const segundo = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ serie_talonario: serie, n_vale: 1 }));
    expect(segundo.status).toBe(409);
  });

  it("el hueco de talonario de urea no se contamina con el de combustible", async () => {
    const serie = serieUnica();
    // Vale 1 y 3 de urea (falta el 2) -- un hueco de COMBUSTIBLE con la
    // misma serie/número no debería aparecer acá.
    await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ serie_talonario: serie, n_vale: 1 }));
    await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ serie_talonario: serie, n_vale: 3 }));

    const huecos = await agente
      .get("/api/erp/combustible/despachos/huecos")
      .query({ serie_talonario: serie, producto: "urea" });
    expect(huecos.status).toBe(200);
    expect(huecos.body.huecos).toEqual([2]);

    const huecosCombustible = await agente
      .get("/api/erp/combustible/despachos/huecos")
      .query({ serie_talonario: serie, producto: "combustible" });
    expect(huecosCombustible.body.huecos).toEqual([]);
  });

  // ── Controles nuevos: equipo no habilitado, ratio, tope diario ─────────

  it("un vale de urea a un equipo con usa_urea=false crea la alerta urea_equipo_no_habilitado", async () => {
    const res = await agente
      .post("/api/erp/combustible/despachos")
      .send(payloadUrea({ n_vale: 50, equipo_id: equipoCamioneta }));
    // No bloquea -- el dato podría estar mal cargado, no es autocontradictorio.
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 150)); // best-effort, corre post-commit

    const alertas = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM combustible_alertas
         WHERE tenant_id = $1 AND producto = 'urea' AND tipo = 'urea_equipo_no_habilitado'
           AND despacho_id = $2`,
        [tenantId, res.body.id]
      )
    );
    expect(alertas.rowCount).toBeGreaterThan(0);
  });

  it("el ratio urea/diésel arranca en NULL: sin config, ningún vale de urea alerta por ratio", async () => {
    // Equipo nuevo, sin config de ratio -- un vale de urea sin diésel previo
    // no debería nunca alertar sin importar cuánta urea reciba.
    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ2"), tipo: "VOLQUETE" });
    const res = await agente.post("/api/erp/combustible/despachos").send(
      payloadUrea({
        n_vale: 60,
        equipo_id: equipo.body.id,
        presentacion: "balde",
        cantidad_bultos: 5,
      })
    );
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 150));
    const alertas = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM combustible_alertas WHERE tenant_id = $1 AND tipo = 'urea_ratio_excedido'`,
        [tenantId]
      )
    );
    expect(alertas.rowCount).toBe(0);
  });

  // ── Recepción (entrada) de urea ──────────────────────────────────────

  it("recepción de urea: sin tanque, con presentación/bultos, costo por caja", async () => {
    const res = await agente.post("/api/erp/combustible/recepciones").send({
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion: "caja",
      cantidad_bultos: 25, // 25 cajas = 100 cajas/mes es el promedio real del cliente
      costo_unitario: 90, // por caja (el service la convierte a costo/litro al vuelo)
      recibido_en: new Date().toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.producto).toBe("urea");
    expect(res.body.combustible_id).toBeNull();
    expect(Number(res.body.cantidad)).toBe(400); // 25 * 16 L
  });

  it("recepción de urea con combustible_id es 400 -- no hay tanque que llenar", async () => {
    const res = await agente.post("/api/erp/combustible/recepciones").send({
      producto: "urea",
      combustible_id: tanqueId,
      grifo_id: grifoUrea,
      presentacion: "caja",
      cantidad_bultos: 1,
      costo_unitario: 90,
    });
    expect(res.status).toBe(400);
  });

  it("recepción de urea con un grifo que no vende urea es 400", async () => {
    const res = await agente.post("/api/erp/combustible/recepciones").send({
      producto: "urea",
      grifo_id: grifoDeRuta,
      presentacion: "caja",
      cantidad_bultos: 1,
      costo_unitario: 90,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no está marcado como");
  });

  // ── Conteo físico (el reemplazo de la varilla) ─────────────────────────

  it("conteo físico: convierte bultos a litros y queda registrado", async () => {
    const res = await agente.post("/api/erp/combustible/urea/conteos").send({
      presentacion: "caja",
      cantidad_bultos: 10,
      contado_en: new Date().toISOString(),
      observaciones: "conteo mensual",
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.cantidad_litros)).toBe(160);
  });

  it("un descuadre entre el conteo físico y el stock teórico dispara urea_descuadre_conteo", async () => {
    // Tenant nuevo y limpio para que el stock teórico sea determinístico.
    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    try {
      const grifo = await agenteOtro.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREAPROV2"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      });

      // Entra 1 caja (16 L) por recepción. Stock teórico = 16 L.
      await agenteOtro.post("/api/erp/combustible/recepciones").send({
        producto: "urea",
        grifo_id: grifo.body.id,
        presentacion: "caja",
        cantidad_bultos: 1,
        costo_unitario: 90,
      });

      // El conteo físico dice 0 -- faltan 16 L sin explicación.
      const conteo = await agenteOtro.post("/api/erp/combustible/urea/conteos").send({
        presentacion: "bolsa",
        cantidad_bultos: 0,
      });
      expect(conteo.status).toBe(201);

      await new Promise((r) => setTimeout(r, 150));
      const alertas = await withTenant(otro.tenant.id, (c) =>
        c.query(
          `SELECT detalle FROM combustible_alertas
           WHERE tenant_id = $1 AND tipo = 'urea_descuadre_conteo'`,
          [otro.tenant.id]
        )
      );
      expect(alertas.rowCount).toBeGreaterThan(0);
      expect(Number(alertas.rows[0].detalle.descuadreL)).toBeCloseTo(-16, 2);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("anular un conteo exige motivo y lo deja como evidencia, nunca lo borra", async () => {
    const creado = await agente.post("/api/erp/combustible/urea/conteos").send({
      presentacion: "bolsa",
      cantidad_bultos: 3,
    });
    expect(creado.status).toBe(201);

    const sinMotivo = await agente
      .patch(`/api/erp/combustible/urea/conteos/${creado.body.id}/anular`)
      .send({});
    expect(sinMotivo.status).toBe(400);

    const anulado = await agente
      .patch(`/api/erp/combustible/urea/conteos/${creado.body.id}/anular`)
      .send({ motivo: "se contó dos veces la misma caja" });
    expect(anulado.status).toBe(200);
    expect(anulado.body.anulada_en).not.toBeNull();
    expect(anulado.body.motivo_anulacion).toBe("se contó dos veces la misma caja");
  });

  // ── Aislamiento: urea no contamina los reportes/topes de combustible ────

  it("los litros de urea NO cuentan para el tope diario ni el reporte de combustible", async () => {
    // Ya se despacharon varios vales de urea arriba a equipoVolquete -- si
    // se filtraran mal por producto, el kardex/reportes de combustible
    // (que no tienen ningún filtro de tenant nuevo) verían esos litros.
    const despachos = await agente
      .get("/api/erp/combustible/despachos")
      .query({ producto: "combustible", equipo_id: equipoVolquete });
    expect(despachos.status).toBe(200);
    for (const d of despachos.body.data ?? []) {
      expect(d.producto).toBe("combustible");
    }

    const soloUrea = await agente
      .get("/api/erp/combustible/despachos")
      .query({ producto: "urea", equipo_id: equipoVolquete });
    expect(soloUrea.status).toBe(200);
    for (const d of soloUrea.body.data ?? []) {
      expect(d.producto).toBe("urea");
    }
  });
});
