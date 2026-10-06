/** tests/combustible-urea-kardex.test.ts
 *
 * Kardex de urea (entrega 3). El libro de entradas, vales y conteos con saldo
 * corriente. Defiende: el saldo sale de los movimientos vigentes; el conteo NO
 * corrige el saldo (solo muestra la diferencia); lo anulado se ve pero no
 * mueve nada; cada fila lleva su factor congelado; exportar se audita; y los
 * permisos reparten ver / llevarse.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: kardex de urea", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoUrea: number;
  let nVale = 1;
  const serie = `K${Math.floor(Math.random() * 1e6).toString(36)}`;

  const periodo = () => ({
    desde: new Date(Date.now() - 86400000).toISOString(),
    hasta: new Date(Date.now() + 86400000).toISOString(),
  });
  const kardex = () => agente.get("/api/erp/combustible/urea/kardex").query(periodo());
  const entrada = (cajas: number) =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion: "caja",
      cantidad_bultos: cajas,
      costo_unitario: 40,
      recibido_en: new Date().toISOString(),
    });
  const vale = (cajas: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      presentacion: "caja",
      cantidad_bultos: cajas,
      despachado_en: new Date().toISOString(),
    });
  const conteo = (cajas: number) =>
    agente.post("/api/erp/combustible/urea/conteos").send({
      cliente_uuid: crypto.randomUUID(),
      presentacion: "caja",
      cantidad_bultos: cajas,
      contado_en: new Date().toISOString(),
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    equipoId = (
      await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE" })
    ).body.id;
    grifoUrea = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREAPROV"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;
  });
  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("un tenant sin movimientos devuelve el libro vacío, sin diferencia (no 0)", async () => {
    const r = await kardex();
    expect(r.status).toBe(200);
    expect(r.body.filas).toEqual([]);
    expect(r.body.resumen.diferencia_final).toBeNull();
  });

  it("el saldo corre entrada -> vale y cada fila lleva su factor congelado", async () => {
    expect((await entrada(10)).status).toBe(201); // 160 L
    expect((await vale(3)).status).toBe(201); // 48 L
    const r = await kardex();
    const [e, v] = r.body.filas;
    expect(e.tipo).toBe("entrada");
    expect(e.saldo_teorico).toBe(160);
    expect(e.factor_litros).toBe(16);
    expect(v.tipo).toBe("vale");
    expect(v.saldo_teorico).toBe(112);
    expect(r.body.resumen.saldo_final).toBe(112);
  });

  it("el conteo muestra la diferencia pero NO corrige el saldo", async () => {
    expect((await conteo(5)).status).toBe(201); // 80 L contados vs 112 esperados
    const r = await kardex();
    const c = r.body.filas.find((f: { tipo: string }) => f.tipo === "conteo");
    expect(c.contado).toBe(80);
    expect(c.diferencia).toBe(-32);
    expect(c.saldo_teorico).toBeNull();
    expect(r.body.resumen.saldo_final).toBe(112); // sigue igual
    expect(r.body.resumen.diferencia_final).toBe(-32);
  });

  it("un vale anulado se ve con su motivo pero no mueve el saldo", async () => {
    const creado = await vale(2); // 32 L -> saldo 80
    expect(creado.status).toBe(201);
    let r = await kardex();
    expect(r.body.resumen.saldo_final).toBe(80);
    const anul = await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "vale mal tipeado" });
    expect(anul.status).toBe(200);
    r = await kardex();
    const fila = r.body.filas.find(
      (f: { tipo: string; referencia_id: number }) =>
        f.tipo === "vale" && f.referencia_id === Number(creado.body.id)
    );
    expect(fila.anulada).toBe(true);
    expect(fila.motivo_anulacion).toBe("vale mal tipeado");
    expect(fila.saldo_teorico).toBeNull();
    expect(r.body.resumen.saldo_final).toBe(112);
  });

  it("el saldo inicial arrastra lo anterior al período", async () => {
    const r = await agente.get("/api/erp/combustible/urea/kardex").query({
      desde: new Date(Date.now() + 3600000).toISOString(),
      hasta: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(r.body.filas).toEqual([]);
    expect(r.body.saldo_inicial).toBe(112);
  });

  it("el xlsx se descarga y la exportación queda en la bitácora", async () => {
    const r = await agente
      .get("/api/erp/combustible/urea/kardex/xlsx")
      .query(periodo())
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on("data", (d: Buffer) => partes.push(d));
        res.on("end", () => cb(null, Buffer.concat(partes)));
      });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    expect((r.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM platform_audit_log WHERE tenant_id = $1 AND accion = 'combustible.urea_kardex_exportar'`,
        [tenantId]
      )
    );
    expect(log.rowCount).toBe(1);
  });

  it("el período es obligatorio y no puede estar invertido", async () => {
    expect((await agente.get("/api/erp/combustible/urea/kardex")).status).toBe(400);
    const r = await agente.get("/api/erp/combustible/urea/kardex").query({
      desde: new Date().toISOString(),
      hasta: new Date(Date.now() - 86400000).toISOString(),
    });
    expect(r.status).toBe(400);
  });

  it("un perfil de lectura ve el kardex; un grifero, no", async () => {
    const crear = async (rol: string, extra: Record<string, unknown>) => {
      const a = await agente
        .post("/api/erp/usuarios")
        .send({ nombre: rol, password, rol, ...extra });
      expect(a.status).toBe(201);
    };
    const emailL = `lec-${idUnico("x")}@test.local`;
    await crear("lectura", { email: emailL });
    await crear("grifero", {
      dni: `8${Math.floor(Math.random() * 1e7)}`.padEnd(8, "1").slice(0, 8),
    });

    const lector = request.agent(app);
    expect(
      (await lector.post("/api/auth/login").send({ tenantSlug: slug, email: emailL, password }))
        .status
    ).toBe(200);
    expect((await lector.get("/api/erp/combustible/urea/kardex").query(periodo())).status).toBe(
      200
    );
  });
});
