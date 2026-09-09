/** tests/combustible-kardex-csv.test.ts
 *
 * El kardex descargable. Kenif: *"los clientes trabajan con Excel... como
 * primera opción dejarlo el CSV"*.
 *
 * Lo que se fija acá, en orden de importancia:
 *
 * 1. INYECCIÓN DE FÓRMULAS. Es lo único de este PR que es un problema de
 *    seguridad de verdad. Excel EJECUTA cualquier celda que arranque con
 *    = + - @, y las celdas de este reporte salen de texto que tipea el
 *    usuario: motivo de anulación, nombre del grifo, placa del equipo. Un
 *    motivo con `=cmd|...` se vuelve ejecución de comandos en la máquina del
 *    auditor que abre el archivo.
 * 2. El BOM. Sin él Excel en Windows muestra "Recepci?n" y el reporte llega
 *    ilegible a la única persona que lo va a leer.
 * 3. Que el archivo y la pantalla salgan del MISMO cálculo. Si difirieran,
 *    nadie sabría cuál creer.
 * 4. Que exportar quede auditado: llevarse el movimiento del tanque es una
 *    acción de auditoría, no una consulta más.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

let seq = 0;
const serieUnica = () => `S${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;

describe("combustible: kardex exportable a CSV", () => {
  let tenantId: string;
  let equipoId: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  const leer = (tq: number, nivel: number, cuando: string) =>
    ag.post("/api/erp/combustible/lecturas").send({ combustible_id: tq, nivel, leido_en: cuando });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const eq = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "Volquete" });
    equipoId = eq.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(nivelInicial = 20000) {
    const r = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque exportable",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: nivelInicial,
      nivel_minimo: 2000,
      modo_vigilancia: "sin_vigilar",
    });
    expect(r.status).toBe(201);
    const tq = r.body.id as number;
    expect((await leer(tq, nivelInicial, hace(50))).status).toBe(201);
    return tq;
  }

  const despachar = (tq: number, cantidad: number, cuando: string) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: cuando,
    });

  const exportar = (tq: number) =>
    ag.get(`/api/erp/combustible/${tq}/kardex/csv`).query({ desde: hace(45), hasta: hace(0.2) });

  // ── 1. Inyección de fórmulas ──────────────────────────────────────────

  it("neutraliza una fórmula escondida en el motivo de anulación", async () => {
    const tq = await tanque(10000);
    const d = await despachar(tq, 500, hace(10));
    expect(d.status).toBe(201);

    // El payload clásico: si Excel lo ejecuta, abre una calculadora en la
    // máquina de quien abre el archivo. El motivo es texto libre del usuario.
    const ataque = `=cmd|' /C calc'!A0`;
    const anul = await ag
      .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
      .send({ motivo: ataque });
    expect(anul.status).toBe(200);

    const res = await exportar(tq);
    expect(res.status).toBe(200);

    // El motivo tiene que estar ENTERO (es evidencia, no se recorta)...
    expect(res.text).toContain("cmd|' /C calc'!A0");
    // ...pero nunca como primer carácter de la celda: va escapado con '.
    expect(res.text).not.toMatch(/(^|[,\r\n"])=cmd/);
    expect(res.text).toContain("'=cmd");
  });

  it("neutraliza también los otros arranques peligrosos", async () => {
    for (const prefijo of ["+", "-", "@"]) {
      const tq = await tanque(10000);
      const d = await despachar(tq, 100, hace(10));
      await ag
        .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
        .send({ motivo: `${prefijo}HYPERLINK("http://malo","clic")` });

      const res = await exportar(tq);
      expect(res.text).toContain(`'${prefijo}HYPERLINK`);
    }
  });

  it("un texto normal NO se toca: el escape es solo para lo peligroso", async () => {
    const tq = await tanque(10000);
    const d = await despachar(tq, 100, hace(10));
    await ag
      .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
      .send({ motivo: "se tipeó mal el vale" });

    const res = await exportar(tq);
    expect(res.text).toContain("se tipeó mal el vale");
    expect(res.text).not.toContain("'se tipeó");
  });

  it("una celda con coma o comillas no rompe las columnas", async () => {
    const tq = await tanque(10000);
    const d = await despachar(tq, 100, hace(10));
    await ag
      .patch(`/api/erp/combustible/despachos/${d.body.id}/anular`)
      .send({ motivo: 'error de tipeo, se puso "500" en vez de 800' });

    const res = await exportar(tq);
    // Entrecomillado con las comillas internas duplicadas (RFC 4180).
    expect(res.text).toContain('"error de tipeo, se puso ""500"" en vez de 800"');
  });

  // ── 2. Que Excel lo abra bien ─────────────────────────────────────────

  it("arranca con BOM y se sirve como archivo descargable", async () => {
    const tq = await tanque(10000);
    await despachar(tq, 300, hace(10));

    const res = await exportar(tq);
    expect(res.text.charCodeAt(0)).toBe(0xfeff); // sin esto: "Recepci?n"
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".csv");
  });

  // ── 3. Mismo cálculo que la pantalla ──────────────────────────────────

  it("el archivo dice lo mismo que la pantalla", async () => {
    const tq = await tanque(20000);
    await despachar(tq, 1000, hace(20));
    await leer(tq, 18500, hace(10)); // faltan 500

    const json = await ag
      .get(`/api/erp/combustible/${tq}/kardex`)
      .query({ desde: hace(45), hasta: hace(0.2) });
    const csv = await exportar(tq);

    expect(json.body.resumen.descuadre_final).toBe(-500);
    // El mismo número tiene que aparecer en el archivo.
    expect(csv.text).toContain("-500");
    // Y la misma cantidad de filas de datos (menos encabezado y cierre).
    const lineasDatos = csv.text.trim().split("\r\n").length - 1;
    expect(lineasDatos).toBe(json.body.filas.length);
  });

  // ── 4. Exportar queda auditado ────────────────────────────────────────

  it("llevarse el kardex queda registrado con quién y qué período", async () => {
    const tq = await tanque(10000);
    await despachar(tq, 250, hace(10));
    await exportar(tq);

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT detalle FROM platform_audit_log
         WHERE tenant_id = $1 AND accion = 'combustible.kardex_exportar'
         ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    expect(log.rows[0]).toBeDefined();
    expect(log.rows[0].detalle.combustibleId).toBe(tq);
    expect(log.rows[0].detalle.desde).toBeDefined();
  });

  // ── 5. Contrato ───────────────────────────────────────────────────────

  it("exige el período igual que el kardex en pantalla", async () => {
    const tq = await tanque();
    expect((await ag.get(`/api/erp/combustible/${tq}/kardex/csv`)).status).toBe(400);
  });

  it("no exporta el tanque de otro tenant", async () => {
    const otro = await crearTenantDePrueba(password);
    const agB = request.agent(app);
    await agB
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    try {
      const tq = await tanque();
      const res = await agB
        .get(`/api/erp/combustible/${tq}/kardex/csv`)
        .query({ desde: hace(30), hasta: hace(0.2) });
      expect(res.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
