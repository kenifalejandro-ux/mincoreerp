/** tests/combustible-urea-conteo-envase.test.ts
 *
 * El conteo físico por envase (migración 0132).
 *
 * Lo que defienden:
 *   1. Un envase con stock que el conteo deja vacío se contó en CERO: no
 *      anotar las bolsas no puede esconder que faltan.
 *   2. El suelto (la caja abierta) suma a lo contado, en litros.
 *   3. Cada envase dice qué dio su último conteo contra lo esperado.
 *   4. Un vale o una entrada con fecha anterior a un conteo ya hecho cambia
 *      su resultado a la vista: la alerta pasa a decir el número de hoy (el
 *      de ese día queda guardado), y queda un hallazgo `urea_conteo_alterado`.
 *   5. Si el movimiento tardío lo explica, la alerta se cierra sola, con el
 *      porqué. Y re-evaluar sin cambios no repite el hallazgo.
 *   6. Lo que no toca el pasado de un conteo no deja nada.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { CombustibleService } from "../src/modules/combustible/combustible.service";

const DIA = 86400000;
const hace = (ms: number) => new Date(Date.now() - ms).toISOString();
const service = new CombustibleService();

interface Alerta {
  id: string;
  tipo: string;
  resuelta_en: Date | null;
  detalle: Record<string, unknown>;
}

describe("combustible: conteo de urea por envase", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoUrea: number;
  let nVale = 1;
  const serie = `C${Math.floor(Math.random() * 1e8).toString(36)}`;
  let conteo: number;
  let valeTardio: number;

  const vale = (lineas: object[], despachadoEn: string) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "almacen",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      lineas,
      despachado_en: despachadoEn,
    });

  const alertasDelConteo = () =>
    withTenant(tenantId, async (c) => {
      const r = await c.query<Alerta>(
        `SELECT id, tipo, resuelta_en, detalle FROM combustible_alertas
          WHERE tenant_id = $1 AND urea_conteo_id = $2 ORDER BY id`,
        [tenantId, conteo]
      );
      return {
        descuadre: r.rows.filter((a) => a.tipo === "urea_descuadre_conteo"),
        alterado: r.rows.filter((a) => a.tipo === "urea_conteo_alterado"),
      };
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    equipoId = (
      await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("CE"), tipo: "VOLQUETE" })
    ).body.id;
    grifoUrea = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREACNT"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;

    // Hace 10 días entraron 5 cajas (16 L) y 10 bolsas (4 L): 120 L.
    const e = await agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      tipo_documento: "factura",
      numero_documento: `F-${Math.floor(Math.random() * 1e8)}`,
      lineas: [
        { presentacion: "caja", cantidad_bultos: 5, costo_unitario: 90 },
        { presentacion: "bolsa", cantidad_bultos: 10, costo_unitario: 25 },
      ],
      recibido_en: hace(10 * DIA),
    });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1 y 2. Lo vacío es cero; el suelto suma ──────────────────────────

  it("rechaza el suelto con más de dos decimales", async () => {
    const r = await agente.post("/api/erp/combustible/urea/conteos").send({
      cliente_uuid: crypto.randomUUID(),
      lineas: [{ presentacion: "caja", cantidad_bultos: 5 }],
      suelto_litros: 1.234,
      contado_en: hace(5 * DIA),
    });
    expect(r.status).toBe(400);
  });

  it("anotar solo las cajas cuenta las bolsas en cero: faltan las 10", async () => {
    // Contaron 4 cajas enteras y una abierta con 16 L: las 5 cajas están,
    // en litros. Las bolsas no las anotaron.
    const r = await agente.post("/api/erp/combustible/urea/conteos").send({
      cliente_uuid: crypto.randomUUID(),
      lineas: [{ presentacion: "caja", cantidad_bultos: 4 }],
      suelto_litros: 16,
      contado_en: hace(5 * DIA),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    conteo = Number(r.body.id);
    expect(Number(r.body.cantidad_litros)).toBe(80);
    expect(Number(r.body.suelto_litros)).toBe(16);

    const { descuadre } = await alertasDelConteo();
    expect(descuadre).toHaveLength(1);
    expect(descuadre[0].detalle).toMatchObject({ contadoL: 80, esperadoL: 120, descuadreL: -40 });
    const porEnvase = descuadre[0].detalle.porEnvase as {
      presentacion: string;
      contadas: number;
      esperadas: number;
    }[];
    expect(porEnvase).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ presentacion: "caja", contadas: 4, esperadas: 5 }),
        expect.objectContaining({ presentacion: "bolsa", contadas: 0, esperadas: 10 }),
      ])
    );
  });

  // ── 3. Cada envase con su último conteo ──────────────────────────────

  it("el estado dice qué dio el último conteo de cada envase, y el suelto", async () => {
    const r = await agente.get("/api/erp/combustible/urea/estado");
    expect(r.status).toBe(200);
    const envases = r.body.stock.envases as {
      codigo: string;
      ultimoConteo: { contadas: number; esperadas: number; diferencia: number } | null;
    }[];
    const de = (codigo: string) => envases.find((e) => e.codigo === codigo)!.ultimoConteo;
    expect(de("bolsa")).toMatchObject({ contadas: 0, esperadas: 10, diferencia: -10 });
    // La caja que falta está abierta en el suelto: la pantalla lo dice al lado.
    expect(de("caja")).toMatchObject({ contadas: 4, esperadas: 5, diferencia: -1, sueltoL: 16 });
    expect(r.body.stock.ultimoConteo).toMatchObject({
      contadoL: 80,
      diferenciaL: -40,
      sueltoL: 16,
    });
  });

  it("el kardex muestra la diferencia del conteo con las bolsas en cero", async () => {
    const r = await agente
      .get("/api/erp/combustible/urea/kardex")
      .query({ desde: hace(30 * DIA), hasta: new Date(Date.now() + DIA).toISOString() });
    expect(r.status).toBe(200);
    const filas = r.body.filas as {
      tipo: string;
      referencia_id: number;
      diferencia: number | null;
    }[];
    const fila = filas.find((f) => f.tipo === "conteo" && f.referencia_id === conteo);
    expect(fila).toBeDefined();
    expect(Number(fila!.diferencia)).toBe(-40);
  });

  // ── 4. Un vale tardío cambia el pasado del conteo ────────────────────

  it("un vale con fecha anterior al conteo actualiza la alerta y deja hallazgo", async () => {
    const r = await vale([{ presentacion: "bolsa", cantidad_bultos: 2 }], hace(7 * DIA));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    valeTardio = Number(r.body.id);

    const { descuadre, alterado } = await alertasDelConteo();
    expect(descuadre).toHaveLength(1);
    expect(descuadre[0].resuelta_en).toBeNull();
    // Hoy: esperaba 112 L, contó 80. Ese día decía -40: queda guardado.
    expect(descuadre[0].detalle).toMatchObject({ esperadoL: 112, descuadreL: -32 });
    expect((descuadre[0].detalle.original as { descuadreL: number }).descuadreL).toBe(-40);
    expect(descuadre[0].detalle.recalculado_por).toMatchObject({ tipo: "vale", id: valeTardio });

    expect(alterado).toHaveLength(1);
    expect(alterado[0].detalle).toMatchObject({ antesL: -40, despuesL: -32 });
  });

  it("anularlo lo devuelve, el original sigue siendo el de ese día", async () => {
    const r = await agente
      .patch(`/api/erp/combustible/despachos/${valeTardio}/anular`)
      .send({ motivo: "se cargó dos veces" });
    expect(r.status).toBe(200);

    const { descuadre, alterado } = await alertasDelConteo();
    expect(descuadre[0].detalle).toMatchObject({ descuadreL: -40 });
    expect((descuadre[0].detalle.original as { descuadreL: number }).descuadreL).toBe(-40);
    expect(alterado).toHaveLength(2);
    expect(alterado[1].detalle).toMatchObject({
      antesL: -32,
      despuesL: -40,
      causa: expect.objectContaining({ tipo: "vale_anulado" }),
    });
  });

  // ── 5. Si lo explica, se cierra sola ─────────────────────────────────

  it("un vale tardío que explica el faltante cierra la alerta con el porqué", async () => {
    // Las 10 bolsas salieron hace 7 días y el vale llegó tarde. Las cajas ya
    // cuadraban en litros: 4 enteras + la abierta del suelto son las 5.
    const r = await vale([{ presentacion: "bolsa", cantidad_bultos: 10 }], hace(7 * DIA));
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const { descuadre, alterado } = await alertasDelConteo();
    expect(descuadre).toHaveLength(1);
    expect(descuadre[0].resuelta_en).not.toBeNull();
    expect(descuadre[0].detalle).toMatchObject({ descuadreL: 0, cerrada_por_sistema: true });
    expect(String(descuadre[0].detalle.motivo_revision)).toMatch(/cuadra desde que se registró/);
    expect(alterado).toHaveLength(3);
    expect(alterado[2].detalle).toMatchObject({ antesL: -40, despuesL: 0 });
  });

  it("re-evaluar sin cambios no repite el hallazgo", async () => {
    const r = await withTenant(tenantId, (c) =>
      service.reevaluarConteosUrea(c, tenantId, "1900-01-01T00:00:00Z", {
        tipo: "prueba",
        id: 0,
        fecha: new Date().toISOString(),
        descripcion: "nada",
      })
    );
    expect(r.alterados).toHaveLength(0);
    expect(r.creadas).toHaveLength(0);
    expect((await alertasDelConteo()).alterado).toHaveLength(3);
  });

  // ── 6. Lo que no toca el pasado del conteo ───────────────────────────

  it("un vale de hoy no toca un conteo de hace 5 días", async () => {
    const r = await vale([{ presentacion: "caja", cantidad_bultos: 1 }], new Date().toISOString());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const { descuadre, alterado } = await alertasDelConteo();
    expect(descuadre).toHaveLength(1);
    expect(alterado).toHaveLength(3);
  });

  it("una entrada tardía que vuelve a descuadrar abre una alerta nueva", async () => {
    const r = await agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      tipo_documento: "factura",
      numero_documento: `F-${Math.floor(Math.random() * 1e8)}`,
      lineas: [{ presentacion: "bolsa", cantidad_bultos: 3, costo_unitario: 25 }],
      recibido_en: hace(6 * DIA),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const { descuadre, alterado } = await alertasDelConteo();
    expect(descuadre).toHaveLength(2);
    expect(descuadre[1].resuelta_en).toBeNull();
    // Ahora los papeles dicen que tenía que haber 3 bolsas más: faltan 12 L.
    expect(descuadre[1].detalle).toMatchObject({ descuadreL: -12 });
    expect(descuadre[1].detalle.aparecio_por).toMatchObject({ tipo: "entrada" });
    expect(alterado).toHaveLength(4);
  });
});
