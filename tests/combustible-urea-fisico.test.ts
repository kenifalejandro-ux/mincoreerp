/** tests/combustible-urea-fisico.test.ts
 *
 * El almacén de urea EN FÍSICO: las unidades de cada envase son bultos que
 * entraron menos bultos que salieron, y los litros la suma de lo registrado.
 * Nunca una división (408 L ÷ 4 = "102 bolsas" eran bolsas que nadie compró).
 *
 * Es la auditoría adversaria de la entrega: cada caso intenta que el número
 * mienta.
 *   1. Un vale anulado no cuenta; anularlo devuelve las unidades.
 *   2. La compra en ruta nunca entró al depósito: no toca el stock.
 *   3. El total del almacén es la suma de los envases, siempre.
 *   4. Dos envases del mismo producto no se mezclan entre sí.
 *   5. Un motivo en blanco no vale para lo que lo exige.
 *   6. Otra empresa no ve ni toca el stock de esta.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { pluralEnvase } from "../src/modules/combustible/combustible.service";

interface EnvaseEstado {
  codigo: string;
  unidades: number;
  litros: number;
  entraronMes: number;
  salieronMes: number;
  litrosRegistradosDistintos: number[];
}

const serie = `F${Math.floor(Math.random() * 1e8).toString(36)}`;

describe("combustible: el almacén de urea en físico", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoUrea: number;
  let grifoRuta: number;
  let nVale = 1;

  const estado = async () => {
    const res = await agente.get("/api/erp/combustible/urea/estado");
    expect(res.status).toBe(200);
    const envases = new Map<string, EnvaseEstado>(
      (res.body.stock.envases as EnvaseEstado[]).map((e) => [e.codigo, e])
    );
    return { stockL: res.body.stock.stockL as number, envases, crudo: res.body.stock };
  };

  const entrada = (presentacion: string, bultos: number) =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      presentacion,
      cantidad_bultos: bultos,
      costo_unitario: 20,
      recibido_en: new Date().toISOString(),
    });

  const vale = (presentacion: string, bultos: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "almacen",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      presentacion,
      cantidad_bultos: bultos,
      despachado_en: new Date().toISOString(),
    });

  /** La compra de urgencia en ruta: se identifica con la boleta del
   *  proveedor (no con un vale de la empresa) y trae el precio POR CAJA que
   *  dice el papel. Nunca entra al depósito. */
  const compraEnRuta = (presentacion: string, bultos: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoRuta,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      presentacion,
      cantidad_bultos: bultos,
      costo_unitario: 50,
      despachado_en: new Date().toISOString(),
    });

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VF"), tipo: "VOLQUETE" });
    equipoId = equipo.body.id;
    const grifo = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("UREAFIS"),
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
      abastece_urea_ruta: true,
    });
    grifoUrea = grifo.body.id;
    // Quien vende urea EN RUTA: la compra de urgencia sin pasar por el almacén.
    const ruta = await agente.post("/api/erp/combustible/grifos").send({
      nombre: idUnico("UREARUTA"),
      abastece_ruta: true,
      abastece_tanque: false,
      abastece_urea: true,
      abastece_urea_ruta: true,
    });
    grifoRuta = ruta.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("las unidades salen de sumar bultos: 5 cajas entran, 1 sale, quedan 4 y su litraje", async () => {
    expect((await entrada("caja", 5)).status).toBe(201);
    expect((await entrada("bolsa", 10)).status).toBe(201);
    expect((await vale("caja", 1)).status).toBe(201);
    expect((await vale("bolsa", 2)).status).toBe(201);

    const { envases, stockL } = await estado();
    expect(envases.get("caja")).toMatchObject({
      unidades: 4,
      litros: 64,
      entraronMes: 5,
      salieronMes: 1,
    });
    expect(envases.get("bolsa")).toMatchObject({
      unidades: 8,
      litros: 32,
      entraronMes: 10,
      salieronMes: 2,
    });
    // 64 + 32: el total es la SUMA, no un número aparte.
    expect(stockL).toBe(96);
    expect([...envases.values()].reduce((a, e) => a + e.litros, 0)).toBe(stockL);
  });

  it("un envase sin movimientos aparece en 0: la pantalla lo dibuja vacío, no lo esconde", async () => {
    const { envases } = await estado();
    expect(envases.get("balde")).toMatchObject({ unidades: 0, litros: 0 });
  });

  it("un vale anulado no cuenta, y anularlo devuelve las unidades", async () => {
    const creado = await vale("caja", 2);
    expect(creado.status).toBe(201);
    expect((await estado()).envases.get("caja")!.unidades).toBe(2);

    const anulado = await agente
      .patch(`/api/erp/combustible/despachos/${creado.body.id}/anular`)
      .send({ motivo: "vale mal tipeado" });
    expect(anulado.status).toBe(200);
    expect((await estado()).envases.get("caja")!.unidades).toBe(4);
  });

  it("la compra en ruta NO toca el almacén: nunca entró al depósito", async () => {
    const antes = await estado();
    const ruta = await compraEnRuta("caja", 3);
    expect(ruta.status, JSON.stringify(ruta.body)).toBe(201);
    const despues = await estado();
    expect(despues.envases.get("caja")!.unidades).toBe(antes.envases.get("caja")!.unidades);
    expect(despues.stockL).toBe(antes.stockL);
  });

  it("dos envases del mismo producto no se mezclan: sacar bolsas no baja las cajas", async () => {
    const antes = await estado();
    expect((await vale("bolsa", 1)).status).toBe(201);
    const despues = await estado();
    expect(despues.envases.get("bolsa")!.unidades).toBe(antes.envases.get("bolsa")!.unidades - 1);
    expect(despues.envases.get("caja")!.unidades).toBe(antes.envases.get("caja")!.unidades);
  });

  it("un envase del que salió más de lo que entró queda NEGATIVO, con signo", async () => {
    const antes = (await estado()).envases.get("balde")!.unidades;
    expect((await vale("balde", 3)).status).toBe(201);
    const balde = (await estado()).envases.get("balde")!;
    expect(balde.unidades).toBe(antes - 3);
    expect(balde.litros).toBe((antes - 3) * 20);
  });

  it("el estado ya no trae equivalencias: ni `referencia` ni bultos inventados", async () => {
    const { crudo } = await estado();
    expect(crudo.referencia).toBeUndefined();
    expect(JSON.stringify(crudo)).not.toMatch(/equivalen/i);
  });

  it("un envase del catálogo con un nombre con litros ('Caja 20 L') se cuenta sin romper el plural", async () => {
    const alta = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "caja20", nombre: "Caja 20 L", litros: 20, es_referencia: false });
    expect(alta.status).toBe(201);
    expect((await entrada("caja20", 2)).status).toBe(201);
    const { envases } = await estado();
    expect(envases.get("caja20")).toMatchObject({ unidades: 2, litros: 40 });
    // La caja vieja de 16 L sigue siendo otro envase, con su propio saldo.
    expect(envases.get("caja")!.unidades).toBeGreaterThan(0);
  });

  it("el plural del correo ('17 cajas y 34 bolsas') pluraliza la palabra, no los litros del nombre", () => {
    expect(pluralEnvase("Caja", 17)).toBe("cajas");
    expect(pluralEnvase("Caja", 1)).toBe("caja");
    expect(pluralEnvase("Bidón", 3)).toBe("bidones");
    expect(pluralEnvase("Balde", 8)).toBe("baldes");
    // Un envase dado de alta como "Caja 20 L": solo la primera palabra cambia.
    expect(pluralEnvase("Caja 20 L", 2)).toBe("cajas 20 l");
    expect(pluralEnvase("Caja 20 L", 1)).toBe("caja 20 l");
    // Con signo: un saldo negativo se nombra en plural, no se esconde.
    expect(pluralEnvase("Balde", -12)).toBe("baldes");
  });

  it("un motivo en blanco no vale para desactivar ni para cambiar litros", async () => {
    const nuevo = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "lata", nombre: "Lata", litros: 3, es_referencia: false });
    expect(nuevo.status).toBe(201);
    const id = nuevo.body.id as number;

    const enBlanco = await agente
      .put(`/api/erp/combustible/urea/presentaciones/${id}`)
      .send({ nombre: "Lata", litros: 4, es_referencia: false, activa: true, motivo: "     " });
    expect(enBlanco.status).toBe(400);
    expect(enBlanco.body.error).toMatch(/motivo/i);

    const baja = await agente
      .put(`/api/erp/combustible/urea/presentaciones/${id}`)
      .send({ nombre: "Lata", litros: 3, es_referencia: false, activa: false });
    expect(baja.status).toBe(400);
    expect(baja.body.error).toMatch(/motivo/i);
  });

  it("un envase con saldo NEGATIVO se puede desactivar: no deja nada atrapado, y el saldo se sigue viendo", async () => {
    const balde = (await agente.get("/api/erp/combustible/urea/presentaciones")).body.find(
      (p: { codigo: string }) => p.codigo === "balde"
    );
    const baja = await agente.put(`/api/erp/combustible/urea/presentaciones/${balde.id}`).send({
      nombre: balde.nombre,
      litros: Number(balde.litros),
      es_referencia: balde.es_referencia,
      activa: false,
      motivo: "ya no se compra",
    });
    expect(baja.status).toBe(200);
    // Inactivo pero con saldo: sigue en el estado, un saldo nunca se esconde.
    expect((await estado()).envases.get("balde")!.unidades).toBeLessThan(0);
  });

  it("otra empresa no ve el stock de esta ni lo puede mover", async () => {
    const otro = await crearTenantDePrueba(password);
    const agenteOtro = request.agent(app);
    await agenteOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    try {
      const suyo = await agenteOtro.get("/api/erp/combustible/urea/estado");
      expect(suyo.status).toBe(200);
      expect(suyo.body.stock.stockL).toBe(0);
      expect(
        (suyo.body.stock.envases as EnvaseEstado[]).every((e) => e.unidades === 0 && e.litros === 0)
      ).toBe(true);
      // Y su catálogo no lleva los envases que esta empresa creó.
      const codigos = (suyo.body.stock.envases as EnvaseEstado[]).map((e) => e.codigo);
      expect(codigos).not.toContain("caja20");
      expect(codigos).not.toContain("lata");
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("el listado de envases cuenta sus movimientos para que la pantalla no ofrezca lo imposible", async () => {
    const filas = (await agente.get("/api/erp/combustible/urea/presentaciones")).body as {
      codigo: string;
      movimientos: number;
    }[];
    const por = new Map(filas.map((f) => [f.codigo, f.movimientos]));
    expect(por.get("caja")).toBeGreaterThan(0);
    // La compra en ruta de arriba usa renglones: también cuentan.
    expect(por.get("lata")).toBe(0);
    // Y se leen de la base, no de un contador aparte.
    const real = await withTenant(tenantId, (c) =>
      c.query<{ n: string }>(
        `SELECT (SELECT COUNT(*) FROM combustible_despachos WHERE tenant_id = $1 AND presentacion = 'caja')
              + (SELECT COUNT(*) FROM combustible_recepciones WHERE tenant_id = $1 AND presentacion = 'caja')
              + (SELECT COUNT(*) FROM combustible_despacho_urea_lineas WHERE tenant_id = $1 AND presentacion = 'caja')
              + (SELECT COUNT(*) FROM combustible_recepcion_urea_lineas WHERE tenant_id = $1 AND presentacion = 'caja')
              + (SELECT COUNT(*) FROM combustible_conteo_urea_lineas WHERE tenant_id = $1 AND presentacion = 'caja') AS n`,
        [tenantId]
      )
    );
    expect(por.get("caja")).toBe(Number(real.rows[0].n));
  });
});
