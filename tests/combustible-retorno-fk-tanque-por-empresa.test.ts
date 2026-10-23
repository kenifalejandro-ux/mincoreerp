/** tests/combustible-retorno-fk-tanque-por-empresa.test.ts
 *
 * Un retorno al pozo no puede apuntar al tanque de OTRA empresa: la base lo
 * rechaza aunque algún día una consulta se olvide de filtrar por tenant
 * (auditoría de #316-#321, hallazgo 10; migración 0147).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("combustible: el tanque de un retorno es de la misma empresa (0147)", () => {
  const password = "ClaveDePrueba123";
  const agenteA = request.agent(app);
  const agenteB = request.agent(app);
  let tenantA: string;
  let tenantB: string;
  let tanqueA: number;
  let tanqueDeB: number;
  let tanquetaA: number;
  let equipoA: number;

  async function montar(
    agente: ReturnType<typeof request.agent>,
    tenantSlug: string,
    email: string
  ) {
    await agente.post("/api/auth/login").send({ tenantSlug, email, password });
    const grifo = (await agente.get("/api/erp/sedes")).body.sedes[0].grifos[0].id as number;
    const tanque = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 5000,
      nivel_minimo: 100,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: grifo,
    });
    expect(tanque.status, JSON.stringify(tanque.body)).toBe(201);
    return { grifo, tanqueId: tanque.body.id as number };
  }

  beforeAll(async () => {
    const a = await crearTenantDePrueba(password);
    const b = await crearTenantDePrueba(password);
    tenantA = a.tenant.id;
    tenantB = b.tenant.id;
    const mA = await montar(agenteA, a.tenant.slug, a.usuario.email);
    const mB = await montar(agenteB, b.tenant.slug, b.usuario.email);
    tanqueA = mA.tanqueId;
    tanqueDeB = mB.tanqueId;
    tanquetaA = Number(
      (await agenteA.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: mA.grifo }))
        .body.id
    );
    equipoA = (
      await agenteA.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: mA.grifo,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantA);
    await borrarTenantDePrueba(tenantB);
    await closeDatabase();
  });

  /** Un retorno al pozo escrito directo en la base de la empresa A. */
  const retornoAlPozo = (tanqueId: number) =>
    withTenant(tenantA, (client) =>
      client.query(
        `INSERT INTO combustible_tanqueta_retornos
           (tenant_id, tanqueta_id, equipo_id, saldo_calculado, saldo_validado, destino,
            combustible_id, cantidad_pozo, costo_unitario_pozo)
         VALUES ($1, $2, $3, 10, 10, 'pozo', $4, 10, 16)`,
        [tenantA, tanquetaA, equipoA, tanqueId]
      )
    );

  it("la base rechaza un retorno de la empresa A que apunta al tanque de la empresa B", async () => {
    await expect(retornoAlPozo(tanqueDeB)).rejects.toThrow(/foreign key|llave foránea|23503/i);
  });

  it("y acepta uno que apunta a un tanque de su propia empresa", async () => {
    await expect(retornoAlPozo(tanqueA)).resolves.toBeTruthy();
  });
});
