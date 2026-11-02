/** tests/idempotencia-offline-equipos.test.ts
 *
 * Mismo motivo que tests/idempotencia-offline-combustible.test.ts, aplicado
 * a dar de alta un equipo: un POST que se commiteó pero cuya respuesta se
 * perdió no debe convertirse en dos equipos al reintentar. Sin el caso de
 * orden de llegada de Combustible -- acá no hay un valor absoluto (como
 * nivel_actual) que un reintento tardío pueda pisar.
 *
 * Suma los casos de validación Zod que Equipos no tenía hasta ahora
 * (ver equipos.repository.ts, que documentaba "sin schema de validación").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { limpiarIdempotencyKeysVencidas } from "../src/server/services/idempotencyKeysRetention.worker";

describe("idempotencia de escrituras offline (Equipos)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  async function contarEquipos(): Promise<number> {
    const res = await withTenant(tenantId, (client) =>
      client.query(`SELECT COUNT(*)::int AS total FROM equipos WHERE tenant_id = $1`, [tenantId])
    );
    return res.rows[0].total;
  }

  it("el mismo cliente_uuid mandado dos veces crea UN solo equipo y devuelve el mismo id", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      placa_codigo: "V-IDEMP-1",
      tipo: "Camioneta",
    };

    const antes = await contarEquipos();

    const primera = await agente.post("/api/erp/equipos").send(cuerpo);
    expect(primera.status).toBe(201);

    const reintento = await agente.post("/api/erp/equipos").send(cuerpo);
    // 200 y no 201: esta llamada no creó nada, pero sigue siendo 2xx a
    // propósito -- para la cola del dispositivo es un éxito.
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    expect(await contarEquipos()).toBe(antes + 1);
  });

  it("dos envíos SIMULTÁNEOS con el mismo cliente_uuid tampoco duplican", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      placa_codigo: "V-IDEMP-2",
      tipo: "Volquete",
    };

    const antes = await contarEquipos();

    const [a, b] = await Promise.all([
      agente.post("/api/erp/equipos").send(cuerpo),
      agente.post("/api/erp/equipos").send(cuerpo),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await contarEquipos()).toBe(antes + 1);
  });

  it("cliente_uuid distintos SÍ crean equipos distintos", async () => {
    const antes = await contarEquipos();

    const a = await agente
      .post("/api/erp/equipos")
      .send({ cliente_uuid: crypto.randomUUID(), placa_codigo: "V-IDEMP-3A", tipo: "Excavadora" });
    const b = await agente
      .post("/api/erp/equipos")
      .send({ cliente_uuid: crypto.randomUUID(), placa_codigo: "V-IDEMP-3B", tipo: "Excavadora" });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(await contarEquipos()).toBe(antes + 2);
  });

  it("sin cliente_uuid se comporta como siempre: cada POST crea un equipo", async () => {
    // placa_codigo tiene UNIQUE (tenant_id, placa_codigo) -- distinta en
    // cada llamada, a propósito: acá se prueba que CADA POST se procesa
    // (no que el mismo body se pueda repetir, eso ya lo cubre el UNIQUE de
    // la tabla y no es parte de la idempotencia offline).
    const antes = await contarEquipos();

    expect(
      (
        await agente
          .post("/api/erp/equipos")
          .send({ placa_codigo: "V-IDEMP-4A", tipo: "Perforadora" })
      ).status
    ).toBe(201);
    expect(
      (
        await agente
          .post("/api/erp/equipos")
          .send({ placa_codigo: "V-IDEMP-4B", tipo: "Perforadora" })
      ).status
    ).toBe(201);

    expect(await contarEquipos()).toBe(antes + 2);
  });

  it("un cliente_uuid que no es UUID se rechaza con 400, no se guarda como clave basura", async () => {
    const res = await agente.post("/api/erp/equipos").send({
      cliente_uuid: "no-soy-un-uuid",
      placa_codigo: "V-IDEMP-5",
      tipo: "Camioneta",
    });
    expect(res.status).toBe(400);
  });

  it("crear sin placa_codigo da 400, no 500", async () => {
    const res = await agente
      .post("/api/erp/equipos")
      .send({ cliente_uuid: crypto.randomUUID(), tipo: "Camioneta" });
    expect(res.status).toBe(400);
  });

  it("crear sin tipo da 400, no 500", async () => {
    const res = await agente
      .post("/api/erp/equipos")
      .send({ cliente_uuid: crypto.randomUUID(), placa_codigo: "V-IDEMP-6" });
    expect(res.status).toBe(400);
  });

  it("editar sin placa_codigo/tipo da 400, no 500", async () => {
    const creado = await agente
      .post("/api/erp/equipos")
      .send({ cliente_uuid: crypto.randomUUID(), placa_codigo: "V-IDEMP-7", tipo: "Camioneta" });
    expect(creado.status).toBe(201);

    const res = await agente.put(`/api/erp/equipos/${creado.body.id}`).send({ marca: "Toyota" });
    expect(res.status).toBe(400);
  });

  it("el evento de tiempo real NO se repite en el reintento", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = { cliente_uuid: clienteUuid, placa_codigo: "V-IDEMP-8", tipo: "Camioneta" };

    const primera = await agente.post("/api/erp/equipos").send(cuerpo);
    await agente.post("/api/erp/equipos").send(cuerpo);

    const eventos = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM eventos_tiempo_real
         WHERE tipo = 'equipos.creado' AND tenant_id = $1
           AND payload->>'equipoId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(eventos.rows[0].total).toBe(1);
  });

  it("una clave vencida la borra el worker de retención compartido, y las vigentes quedan", async () => {
    const vigente = crypto.randomUUID();
    await agente
      .post("/api/erp/equipos")
      .send({ cliente_uuid: vigente, placa_codigo: "V-IDEMP-9A", tipo: "Camioneta" });

    const vencido = crypto.randomUUID();
    await agente
      .post("/api/erp/equipos")
      .send({ cliente_uuid: vencido, placa_codigo: "V-IDEMP-9B", tipo: "Camioneta" });
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys SET expires_at = now() - interval '1 hour'
         WHERE tenant_id = $1 AND modulo = 'flota' AND cliente_uuid = $2`,
        [tenantId, vencido]
      )
    );

    await limpiarIdempotencyKeysVencidas();

    const restantes = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT cliente_uuid FROM idempotency_keys WHERE tenant_id = $1 AND modulo = 'flota'`,
        [tenantId]
      )
    );
    const uuids = restantes.rows.map((f) => f.cliente_uuid);
    expect(uuids).toContain(vigente);
    expect(uuids).not.toContain(vencido);
  });
});

afterAll(async () => {
  await closeDatabase();
});
