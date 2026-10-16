/** tests/combustible-urea-proveedores-auditoria.test.ts
 *
 * Auditoría adversaria de proveedores interno/externo de urea (migración 0133).
 * Dos casos, uno por hallazgo demostrable:
 *
 *   1. (rol 4, severidad media) La bitácora de PUT /grifos/:id no registra los
 *      roles de urea ni `activo`: cambiar un proveedor de interno a externo, o
 *      desactivarlo, no deja rastro de QUÉ cambió. Este test FALLA hoy a
 *      propósito: es la evidencia del hallazgo, no una regresión.
 *   2. (rol 1) Un vale viejo de la cola offline ('compra_externa' + talonario,
 *      sin comprobante) se normaliza a 'almacen' ANTES de validar el rol, así
 *      que un proveedor solo externo se rechaza como proveedor interno. Fija
 *      el comportamiento actual (pasa hoy) para que no cambie sin aviso.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";

describe("auditoría adversaria: proveedores de urea interno y externo", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  const serie = `A${Math.floor(Math.random() * 1e6).toString(36)}`;

  const grifo = async (urea: boolean, ureaRuta: boolean) =>
    (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("AUD"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: urea,
        abastece_urea_ruta: ureaRuta,
      })
    ).body.id as number;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    equipoId = (
      await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("AQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("HALLAZGO: la bitácora del PUT de proveedor registra los roles de urea y el estado", async () => {
    const id = await grifo(true, false);
    const r = await agente.put(`/api/erp/combustible/grifos/${id}`).send({
      nombre: idUnico("AUD2"),
      activo: false,
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: false,
      abastece_urea_ruta: true,
    });
    expect(r.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'combustible.grifo_actualizar'
        ORDER BY id DESC LIMIT 1`,
      [tenantId]
    );
    expect(rows.length).toBe(1);
    const detalle = JSON.stringify(rows[0].detalle);
    // Pasó de interno a externo y se desactivó: la bitácora tiene que decirlo.
    expect(detalle).toMatch(/abasteceUrea/);
    expect(detalle).toMatch(/activo/);
  });

  it("un vale viejo (compra_externa + talonario) se juzga como almacén: proveedor solo externo da 400", async () => {
    const interno = await grifo(true, false);
    const externo = await grifo(false, true);
    const ambos = await grifo(true, true);
    // Stock para que el 201 de control no dependa de otra cosa.
    const entrada = await agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: interno,
      presentacion: "caja",
      cantidad_bultos: 10,
      costo_unitario: 40,
      recibido_en: new Date().toISOString(),
    });
    expect(entrada.status).toBe(201);

    let n = 1;
    const valeViejo = (grifoId: number) =>
      agente.post("/api/erp/combustible/despachos").send({
        cliente_uuid: crypto.randomUUID(),
        producto: "urea",
        origen: "compra_externa", // forma anterior a 0119, sin comprobante
        grifo_id: grifoId,
        tipo_destino: "equipo",
        equipo_id: equipoId,
        serie_talonario: serie,
        n_vale: n++,
        presentacion: "caja",
        cantidad_bultos: 1,
        despachado_en: new Date().toISOString(),
      });

    const ok = await valeViejo(ambos);
    expect(ok.status).toBe(201);
    expect(ok.body.origen).toBe("almacen");

    const rechazado = await valeViejo(externo);
    expect(rechazado.status).toBe(400);
    expect(JSON.stringify(rechazado.body)).toMatch(/interno/);
  });
});
