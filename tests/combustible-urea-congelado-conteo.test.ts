/** tests/combustible-urea-congelado-conteo.test.ts
 *
 * Un hallazgo de urea anclado SOLO a un conteo físico (urea_descuadre_conteo,
 * urea_conteo_recargado) tiene que poder congelarse como anomalía. El
 * INSERT del congelado no copiaba `urea_conteo_id`: la fila quedaba sin
 * ninguna ancla, el CHECK de anclas la rechazaba y el worker la salteaba en
 * silencio (un SAVEPOINT por alerta). El hallazgo nunca quedaba como
 * evidencia permanente.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

describe("combustible: el descuadre de un conteo de urea se congela con su ancla", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    const grifo = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("UREACONG"),
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
      abastece_urea_ruta: true,
    });
    const entrada = await agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifo.body.id,
      presentacion: "caja",
      cantidad_bultos: 10,
      costo_unitario: 20,
      recibido_en: new Date(Date.now() - 5 * 86400000).toISOString(),
    });
    expect(entrada.status).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("un conteo que no cuadra, vencida su ventana, queda congelado con urea_conteo_id", async () => {
    const conteo = await agente.post("/api/erp/combustible/urea/conteos").send({
      cliente_uuid: crypto.randomUUID(),
      presentacion: "caja",
      cantidad_bultos: 7,
      contado_en: new Date().toISOString(),
    });
    expect(conteo.status).toBe(201);

    const alerta = await withTenant(tenantId, (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM combustible_alertas
          WHERE tenant_id = $1 AND tipo = 'urea_descuadre_conteo' AND urea_conteo_id = $2`,
        [tenantId, conteo.body.id]
      )
    );
    expect(alerta.rowCount).toBe(1);

    // Vencida: muy por encima de la ventana de gracia por default (72 h).
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_alertas SET creado_en = now() - interval '10 days' WHERE id = $1`,
        [alerta.rows[0].id]
      )
    );
    await correrConciliacion(tenantId);

    const anomalia = await withTenant(tenantId, (c) =>
      c.query<{ urea_conteo_id: string | null }>(
        `SELECT urea_conteo_id FROM combustible_anomalias WHERE tenant_id = $1 AND alerta_id = $2`,
        [tenantId, alerta.rows[0].id]
      )
    );
    expect(anomalia.rowCount).toBe(1);
    expect(Number(anomalia.rows[0].urea_conteo_id)).toBe(Number(conteo.body.id));
  });
});
