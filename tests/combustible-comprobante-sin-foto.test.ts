/** tests/combustible-comprobante-sin-foto.test.ts
 *
 * Una compra externa (boleta o factura) cuya foto sigue sin subirse pasadas
 * 24 horas (migración 0129). La foto se sube DESPUÉS de registrar, así que
 * alertar al registrar saldría siempre y siempre falsa: la alerta nace en el
 * worker, y es un ESTADO -- se cierra sola cuando llega la foto.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

const password = "ClaveDePrueba123";

describe("combustible: comprobante sin foto (0129)", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let proveedor: number;
  let equipo: number;
  let seq = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    equipo = (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EXC"), tipo: "EXCAVADORA", tipo_medidor: "horometro" })
    ).body.id;
    proveedor = (await admin.post("/api/erp/combustible/grifos").send({ nombre: idUnico("PX") }))
      .body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const compra = () =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "compra_externa",
      grifo_id: proveedor,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Date.now().toString().slice(-6)}${seq++}`,
      cantidad: 40,
      lectura_horometro: 1000 + seq * 20,
      horas_abastecidas: 10,
      costo_unitario: 17.5,
      despachado_en: new Date().toISOString(),
    });

  const alertaAbierta = (despachoId: number) =>
    withTenant(tenantId, async (c) => {
      const r = await c.query(
        `SELECT resuelta_en FROM combustible_alertas
          WHERE tenant_id = $1 AND despacho_id = $2 AND tipo = 'comprobante_sin_foto'`,
        [tenantId, despachoId]
      );
      return r.rows;
    });

  const envejecer = (despachoId: number) =>
    withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_despachos SET creado_en = now() - interval '2 days'
          WHERE id = $1 AND tenant_id = $2`,
        [despachoId, tenantId]
      )
    );

  it("recién registrada no alerta; pasadas 24 h sin foto, sí; con la foto, se cierra sola", async () => {
    const c = await compra();
    expect(c.status, JSON.stringify(c.body)).toBe(201);

    await correrConciliacion(tenantId);
    expect(await alertaAbierta(c.body.id)).toHaveLength(0);

    await envejecer(c.body.id);
    await correrConciliacion(tenantId);
    const abierta = await alertaAbierta(c.body.id);
    expect(abierta).toHaveLength(1);
    expect(abierta[0].resuelta_en).toBeNull();

    // Otra corrida no duplica la alerta.
    await correrConciliacion(tenantId);
    expect(await alertaAbierta(c.body.id)).toHaveLength(1);

    // Llega la foto: la alerta se resuelve sola.
    await withTenant(tenantId, (cl) =>
      cl.query(
        `UPDATE combustible_despachos
            SET comprobante_key = 'k', comprobante_driver = 'local', comprobante_mime = 'image/jpeg',
                comprobante_bytes = 10, comprobante_nombre = 'f.jpg',
                comprobante_sha256 = repeat('a', 64), comprobante_subido_en = now()
          WHERE id = $1 AND tenant_id = $2`,
        [c.body.id, tenantId]
      )
    );
    await correrConciliacion(tenantId);
    const cerrada = await alertaAbierta(c.body.id);
    expect(cerrada).toHaveLength(1);
    expect(cerrada[0].resuelta_en).not.toBeNull();
  });

  it("una compra con foto desde el inicio nunca alerta", async () => {
    const c = await compra();
    await withTenant(tenantId, (cl) =>
      cl.query(
        `UPDATE combustible_despachos
            SET comprobante_key = 'k', comprobante_driver = 'local', comprobante_mime = 'image/jpeg',
                comprobante_bytes = 10, comprobante_nombre = 'f.jpg',
                comprobante_sha256 = repeat('a', 64), comprobante_subido_en = now()
          WHERE id = $1 AND tenant_id = $2`,
        [c.body.id, tenantId]
      )
    );
    await envejecer(c.body.id);
    await correrConciliacion(tenantId);
    expect(await alertaAbierta(c.body.id)).toHaveLength(0);
  });
});
