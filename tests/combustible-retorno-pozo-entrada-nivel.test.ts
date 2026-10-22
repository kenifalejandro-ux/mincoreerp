/** tests/combustible-retorno-pozo-entrada-nivel.test.ts
 *
 * El saldo que una tanqueta devuelve al pozo (0145) entra al tanque como una
 * ENTRADA. Todavía nada lo escribe desde la app (llega en la entrega
 * siguiente), así que cada prueba inserta la fila directo y comprueba que cada
 * cuenta del módulo la ve: nivel teórico, kardex, diferencia de la recepción,
 * descuadre por tramo, saldo del ciclo y costo promedio.
 *
 * Lo que cuesta caro si falla: un retorno que entra al nivel pero no a la
 * diferencia de la recepción se ve como un SOBRANTE de esa recepción, y una
 * alerta de robo en sentido contrario.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { CombustibleRepository } from "../src/modules/combustible/combustible.repository";

describe("combustible: el retorno al pozo es una entrada del tanque (0145)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  const repo = new CombustibleRepository();
  let tenantId: string;
  let grifoProveedor: number;
  let principal: number;
  let unidad: number;
  let tanqueta: number;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    grifoProveedor = (
      await admin
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("Prov"), abastece_tanque: true })
    ).body.id;
    unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    tanqueta = Number(
      (await admin.post("/api/erp/combustible/tanquetas").send({ grifo_interno_id: principal }))
        .body.id
    );
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

  /** Un tanque en galones con su varilla de base de hace 50 días. */
  async function tanque(nivel = 1000) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Pozo de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: nivel,
      nivel_minimo: 100,
      modo_vigilancia: "sin_vigilar",
    });
    expect(r.status).toBe(201);
    const id = r.body.id as number;
    const base = await admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: id, nivel, leido_en: hace(50) });
    expect(base.status).toBe(201);
    return id;
  }

  const leer = async (tq: number, nivel: number, cuando: string) => {
    const r = await admin
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tq, nivel, leido_en: cuando });
    expect(r.status).toBe(201);
    return Number(r.body.lectura.id);
  };

  const recibir = (tq: number, cantidad: number, costo: number, cuando: string) =>
    admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: tq,
      grifo_id: grifoProveedor,
      cantidad,
      costo_unitario: costo,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: cuando,
    });

  /** La fila del retorno al pozo, como la dejará la entrega siguiente. */
  const retornoAlPozo = (tq: number, cantidad: number, costo: number, cuando: string) =>
    withTenant(tenantId, (client) =>
      client.query(
        `INSERT INTO combustible_tanqueta_retornos
           (tenant_id, tanqueta_id, equipo_id, saldo_calculado, saldo_validado, destino,
            combustible_id, cantidad_pozo, costo_unitario_pozo, creado_en)
         VALUES ($1, $2, $3, $4::numeric, $4::numeric, 'pozo', $5, $4::numeric, $6::numeric, $7::timestamptz)`,
        [tenantId, tanqueta, unidad, cantidad, tq, costo, cuando]
      )
    );

  it("la base rechaza un retorno al pozo incompleto y uno a reserva con datos de pozo", async () => {
    const tq = await tanque();
    await expect(
      withTenant(tenantId, (client) =>
        client.query(
          `INSERT INTO combustible_tanqueta_retornos
             (tenant_id, tanqueta_id, equipo_id, saldo_calculado, saldo_validado, destino, combustible_id)
           VALUES ($1, $2, $3, 10, 10, 'pozo', $4)`,
          [tenantId, tanqueta, unidad, tq]
        )
      )
    ).rejects.toThrow();
    await expect(
      withTenant(tenantId, (client) =>
        client.query(
          `INSERT INTO combustible_tanqueta_retornos
             (tenant_id, tanqueta_id, equipo_id, saldo_calculado, saldo_validado, destino,
              combustible_id, cantidad_pozo, costo_unitario_pozo)
           VALUES ($1, $2, $3, 10, 10, 'reserva', $4, 10, 16)`,
          [tenantId, tanqueta, unidad, tq]
        )
      )
    ).rejects.toThrow();
  });

  it("el nivel teórico del tanque suma lo que volvió al pozo", async () => {
    const tq = await tanque(1000);
    await retornoAlPozo(tq, 50, 16, hace(5));
    // La varilla del alta se estampa con NOW(): se mira antes de ella, contra la de base.
    const nivel = await withTenant(tenantId, (client) =>
      repo.findNivelTeoricoVigenteA(client, tenantId, tq, hace(2))
    );
    expect(nivel).toBe(1050);
  });

  it("el kardex muestra el retorno como una entrada y lo suma al saldo", async () => {
    const tq = await tanque(1000);
    await retornoAlPozo(tq, 50, 16, hace(5));
    const res = await admin
      .get(`/api/erp/combustible/${tq}/kardex`)
      .query({ desde: hace(45), hasta: hace(0.2) });
    expect(res.status).toBe(200);
    const fila = res.body.filas.find((f: { tipo: string }) => f.tipo === "retorno_tanqueta");
    expect(fila).toBeTruthy();
    expect(fila.entrada).toBe(50);
    expect(fila.saldo_teorico).toBe(1050);
    expect(fila.anulada).toBe(false);
  });

  it("la diferencia de una recepción no se ensucia con lo que volvió al pozo", async () => {
    const tq = await tanque(1000);
    expect((await recibir(tq, 200, 10, hace(10))).status).toBe(201);
    await retornoAlPozo(tq, 50, 16, hace(9));
    // 1.000 + 200 recibidos + 50 devueltos: la varilla cierra exacto.
    await leer(tq, 1250, hace(8));
    const lista = await admin.get("/api/erp/combustible/recepciones").query({ combustible_id: tq });
    expect(lista.status).toBe(200);
    const filas = lista.body.data;
    expect(filas).toHaveLength(1);
    expect(Number(filas[0].diferencia_litros)).toBe(0);
  });

  it("el descuadre por tramo cuenta el retorno como entrada", async () => {
    const tq = await tanque(1000);
    await retornoAlPozo(tq, 50, 16, hace(9));
    const cuando = hace(8);
    const lectura = await leer(tq, 1050, cuando);
    const d = await withTenant(tenantId, (client) =>
      repo.findDatosDescuadre(client, tenantId, tq, lectura, cuando)
    );
    expect(Number(d!.recepciones)).toBe(50);
  });

  it("el saldo del ciclo suma el retorno pero no lo toma como recepción que abre ciclo", async () => {
    const tq = await tanque(1000);
    expect((await recibir(tq, 500, 10, hace(20))).status).toBe(201);
    await leer(tq, 1500, hace(19));
    // 300 gal es más del 1 % de la capacidad: si abriera ciclo, el inicio se mudaría.
    await retornoAlPozo(tq, 300, 16, hace(10));
    const cuando = hace(5);
    const lectura = await leer(tq, 1800, cuando);
    const c = await withTenant(tenantId, (client) =>
      repo.findSaldoCiclo(client, tenantId, tq, lectura, cuando)
    );
    expect(Number(c!.nivel_inicio)).toBe(1500);
    expect(Number(c!.recepciones)).toBe(300);
    expect(new Date(c!.inicio_en).getTime()).toBeCloseTo(new Date(hace(19)).getTime(), -4);
  });

  it("el costo promedio pondera el retorno con el costo con que volvió", async () => {
    const tq = await tanque(1000);
    expect((await recibir(tq, 200, 10, hace(10))).status).toBe(201); // la primera fija 10
    await retornoAlPozo(tq, 100, 16, hace(5));
    const promedio = await withTenant(tenantId, (client) =>
      repo.recalcularCostoPromedio(client, tenantId, tq)
    );
    // (1.000 que había × 10 + 100 × 16) / 1.100
    expect(promedio).toBeCloseTo(10.5455, 3);
  });

  it("un tanque con retornos al pozo cuenta como tanque con movimientos", async () => {
    const nuevo = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Pozo sin movimientos",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 1000,
      nivel_minimo: 100,
      modo_vigilancia: "sin_vigilar",
    });
    expect(nuevo.status).toBe(201);
    const tq = nuevo.body.id as number;
    const antes = await withTenant(tenantId, (client) =>
      repo.tieneMovimientos(client, tenantId, tq)
    );
    expect(antes).toBe(false);
    await retornoAlPozo(tq, 50, 16, hace(5));
    const despues = await withTenant(tenantId, (client) =>
      repo.tieneMovimientos(client, tenantId, tq)
    );
    expect(despues).toBe(true);
  });
});
