/** tests/combustible-urea-renglones.test.ts
 *
 * El vale del almacén y la entrada de urea con renglones (migración 0131):
 * "1 caja + 2 bolsas" en un vale, "20 cajas + 40 bolsas" en una factura.
 *
 * Lo que defienden:
 *   1. Un vale es un papel: un número de talonario, varios envases, y cada
 *      envase baja su propio stock.
 *   2. Una factura es una entrada: su costo por litro es el del total, y cada
 *      renglón guarda el precio por bulto tal como figura en la factura.
 *   3. Todo o nada: un renglón inválido deshace el vale entero.
 *   4. La cola offline de la app vieja sigue entrando.
 *   5. El kardex muestra una fila por papel con sus renglones.
 *   6. La corrección de litros recalcula los papeles con varios envases.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const DIA = 86400000;
const hace = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Renglon {
  presentacion: string;
  cantidad_bultos: number;
  factor_litros: string;
  litros: string;
  costo_por_bulto: string | null;
}

describe("combustible: renglones en el vale del almacén y en la entrada de urea", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let grifoUrea: number;
  let nVale = 1;
  const serie = `R${Math.floor(Math.random() * 1e8).toString(36)}`;

  const unidades = async () => {
    const r = await agente.get("/api/erp/combustible/urea/estado");
    expect(r.status).toBe(200);
    return {
      stockL: r.body.stock.stockL as number,
      por: new Map(
        (r.body.stock.envases as { codigo: string; unidades: number; litros: number }[]).map(
          (e) => [e.codigo, e]
        )
      ),
    };
  };

  const vale = (lineas: object[], extra: Record<string, unknown> = {}) =>
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
      despachado_en: hace(DIA),
      ...extra,
    });

  const entrada = (lineas: object[]) =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      tipo_documento: "factura",
      numero_documento: `F-${Math.floor(Math.random() * 1e8)}`,
      lineas,
      recibido_en: hace(2 * DIA),
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    equipoId = (
      await agente.post("/api/erp/equipos").send({ placa_codigo: idUnico("VR"), tipo: "VOLQUETE" })
    ).body.id;
    grifoUrea = (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREAREN"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 2. La factura con dos envases ────────────────────────────────────

  let laFactura: number;

  it("una factura con 20 cajas y 40 bolsas es UNA entrada, con el costo por litro del total", async () => {
    const r = await entrada([
      { presentacion: "caja", cantidad_bultos: 20, costo_unitario: 95 },
      { presentacion: "bolsa", cantidad_bultos: 40, costo_unitario: 26 },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    laFactura = Number(r.body.id);
    // 20 × 16 + 40 × 4 = 480 L; S/ 1 900 + S/ 1 040 = S/ 2 940.
    expect(Number(r.body.cantidad)).toBe(480);
    expect(Number(r.body.costo_unitario)).toBe(Number((2940 / 480).toFixed(4)));
    const renglones = r.body.renglones as Renglon[];
    expect(
      renglones.map((x) => [x.presentacion, x.cantidad_bultos, Number(x.costo_por_bulto)])
    ).toEqual([
      ["bolsa", 40, 26],
      ["caja", 20, 95],
    ]);

    const { por, stockL } = await unidades();
    expect(por.get("caja")).toMatchObject({ unidades: 20, litros: 320 });
    expect(por.get("bolsa")).toMatchObject({ unidades: 40, litros: 160 });
    expect(stockL).toBe(480);

    const listado = await agente
      .get("/api/erp/combustible/recepciones")
      .query({ producto: "urea", pageSize: "50" });
    const fila = listado.body.data.find((x: { id: number }) => Number(x.id) === laFactura);
    expect(fila.renglones).toHaveLength(2);
  });

  it("en la entrada, cada renglón trae su precio por bulto", async () => {
    const r = await entrada([{ presentacion: "caja", cantidad_bultos: 1 }]);
    expect(r.status).toBe(400);
  });

  // ── 1. El vale con dos envases ───────────────────────────────────────

  it("1 caja + 2 bolsas es UN vale: un número, y cada envase baja el suyo", async () => {
    const r = await vale([
      { presentacion: "caja", cantidad_bultos: 1 },
      { presentacion: "bolsa", cantidad_bultos: 2 },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number(r.body.cantidad)).toBe(24);
    expect(r.body.costo_origen).toBe("promedio");

    const { por, stockL } = await unidades();
    expect(por.get("caja")).toMatchObject({ unidades: 19, litros: 304 });
    expect(por.get("bolsa")).toMatchObject({ unidades: 38, litros: 152 });
    expect(stockL).toBe(456);

    const listado = await agente
      .get("/api/erp/combustible/despachos")
      .query({ producto: "urea", pageSize: "50" });
    const fila = listado.body.data.find((x: { id: number }) => x.id === r.body.id);
    expect(fila.renglones.map((x: Renglon) => x.presentacion)).toEqual(["bolsa", "caja"]);
  });

  it("un vale declarado con varios envases cuesta lo que suman sus precios por bulto", async () => {
    const r = await vale([
      { presentacion: "caja", cantidad_bultos: 1, costo_unitario: 100 },
      { presentacion: "bolsa", cantidad_bultos: 1, costo_unitario: 30 },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.costo_origen).toBe("declarado");
    // S/ 130 sobre 20 L.
    expect(Number(r.body.costo_unitario)).toBe(6.5);
  });

  // ── 3. Todo o nada ───────────────────────────────────────────────────

  it("el mismo envase en dos renglones es 400", async () => {
    const r = await vale([
      { presentacion: "caja", cantidad_bultos: 1 },
      { presentacion: "caja", cantidad_bultos: 2 },
    ]);
    expect(r.status).toBe(400);
  });

  it("un renglón con un envase desactivado deshace el vale entero", async () => {
    await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "lata", nombre: "Lata", litros: 3, es_referencia: false });
    const lata = (await agente.get("/api/erp/combustible/urea/presentaciones")).body.find(
      (p: { codigo: string }) => p.codigo === "lata"
    );
    await agente.put(`/api/erp/combustible/urea/presentaciones/${lata.id}`).send({
      nombre: "Lata",
      litros: 3,
      es_referencia: false,
      activa: false,
      motivo: "prueba",
    });
    const antes = await unidades();
    const contar = () =>
      withTenant(tenantId, (c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM combustible_despachos WHERE tenant_id = $1`,
          [tenantId]
        )
      );
    const filasAntes = (await contar()).rows[0].n;

    const r = await vale([
      { presentacion: "caja", cantidad_bultos: 1 },
      { presentacion: "lata", cantidad_bultos: 1 },
    ]);
    expect(r.status).toBe(400);
    expect((await contar()).rows[0].n).toBe(filasAntes);
    expect((await unidades()).stockL).toBe(antes.stockL);
    nVale--; // el número no se usó
  });

  // ── 4. La cola offline de la app vieja ───────────────────────────────

  it("un vale viejo de la cola offline (un envase, 'compra_externa' sin comprobante) entra como un renglón", async () => {
    const r = await agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      presentacion: "bolsa",
      cantidad_bultos: 1,
      despachado_en: hace(DIA),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.origen).toBe("almacen");
    expect(r.body.renglones).toEqual([
      expect.objectContaining({ presentacion: "bolsa", cantidad_bultos: 1 }),
    ]);
  });

  it("reintentar el mismo vale (mismo cliente_uuid) devuelve el mismo, con sus renglones", async () => {
    const uuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: uuid,
      producto: "urea",
      origen: "almacen",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      lineas: [{ presentacion: "bolsa", cantidad_bultos: 1 }],
      despachado_en: hace(DIA),
    };
    const primero = await agente.post("/api/erp/combustible/despachos").send(cuerpo);
    expect(primero.status).toBe(201);
    const segundo = await agente.post("/api/erp/combustible/despachos").send(cuerpo);
    expect(segundo.body.id).toBe(primero.body.id);
    expect(segundo.body.renglones).toHaveLength(1);
  });

  it("un envase usado SOLO en un conteo también tiene los litros fijos", async () => {
    const alta = await agente
      .post("/api/erp/combustible/urea/presentaciones")
      .send({ codigo: "bidon", nombre: "Bidón", litros: 10, es_referencia: false });
    expect(alta.status).toBe(201);
    const conteo = await agente.post("/api/erp/combustible/urea/conteos").send({
      cliente_uuid: crypto.randomUUID(),
      lineas: [{ presentacion: "bidon", cantidad_bultos: 3 }],
    });
    expect(conteo.status, JSON.stringify(conteo.body)).toBe(201);
    const cambio = await agente
      .put(`/api/erp/combustible/urea/presentaciones/${alta.body.id}`)
      .send({
        nombre: "Bidón",
        litros: 20,
        es_referencia: false,
        activa: true,
        motivo: "prueba",
      });
    // Ese conteo guardó 3 × 10 L: cambiar a 20 dejaría el envase mezclado.
    expect(cambio.status).toBe(409);
  });

  // ── 5. El kardex ─────────────────────────────────────────────────────

  it("el kardex muestra una fila por papel, con sus renglones", async () => {
    const hasta = new Date().toISOString();
    const desde = new Date(Date.now() - 10 * DIA).toISOString();
    const r = await agente.get("/api/erp/combustible/urea/kardex").query({ desde, hasta });
    expect(r.status).toBe(200);
    const factura = r.body.filas.find(
      (f: { tipo: string; referencia_id: number }) =>
        f.tipo === "entrada" && f.referencia_id === laFactura
    );
    expect(factura.entrada).toBe(480);
    expect(factura.renglones.map((x: { presentacion: string }) => x.presentacion)).toEqual([
      "bolsa",
      "caja",
    ]);
  });

  // ── 6. La corrección de litros sobre papeles con varios envases ──────

  it("corregir la caja a 20 L recalcula la factura y el vale mixtos, sin tocar las bolsas", async () => {
    // El admin se habilita a otro usuario: el check nace apagado (0130).
    const email = `enc-${idUnico("u")}@test.local`;
    const alta = await agente
      .post("/api/erp/usuarios")
      .send({ nombre: "Encargada", email, password, rol: "operador" });
    const actuales = await agente.get(`/api/erp/usuarios/${alta.body.id}/permisos`);
    const permisos = {
      modulos: actuales.body.modulos.map(
        (m: { modulo: string; asignado: boolean; nivel: string }) => ({
          modulo: m.modulo,
          asignado: m.asignado,
          nivel: m.nivel,
        })
      ),
      pestanas: [{ modulo: "combustible", pestana: "urea:corregir_litros", permitido: true }],
      motivo: "encargada",
    };
    expect(
      (await agente.put(`/api/erp/usuarios/${alta.body.id}/permisos`).send(permisos)).status
    ).toBe(200);
    const encargada = request.agent(app);
    await encargada.post("/api/auth/login").send({ tenantSlug: slug, email, password });

    const cajaId = (await agente.get("/api/erp/combustible/urea/presentaciones")).body.find(
      (p: { codigo: string }) => p.codigo === "caja"
    ).id;
    const r = await encargada
      .post(`/api/erp/combustible/urea/presentaciones/${cajaId}/correccion`)
      .send({ litros: 20, motivo: "las cajas son de 20 L" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    // La factura: 20 × 20 + 40 × 4 = 560 L, mismo S/ 2 940.
    const f = await withTenant(tenantId, (c) =>
      c.query<{ cantidad: string; costo_unitario: string }>(
        `SELECT cantidad, costo_unitario FROM combustible_recepciones WHERE id = $1`,
        [laFactura]
      )
    );
    expect(Number(f.rows[0].cantidad)).toBe(560);
    expect(Number(f.rows[0].costo_unitario)).toBe(Number((2940 / 560).toFixed(4)));

    const { por } = await unidades();
    // Las cajas: mismas unidades, a 20 L. Las bolsas: intactas.
    expect(por.get("caja")).toMatchObject({ unidades: 18, litros: 360 });
    expect(por.get("bolsa")!.litros).toBe(por.get("bolsa")!.unidades * 4);
  });

  it("el vale declarado mixto conserva sus precios por bulto tras la corrección", async () => {
    const r = await withTenant(tenantId, (c) =>
      c.query<{ cantidad: string; costo_unitario: string }>(
        `SELECT cantidad, costo_unitario FROM combustible_despachos
          WHERE tenant_id = $1 AND costo_origen = 'declarado'`,
        [tenantId]
      )
    );
    expect(r.rowCount).toBe(1);
    // 1 caja (ahora 20 L) + 1 bolsa (4 L) = 24 L; S/ 100 + S/ 30 = S/ 130.
    expect(Number(r.rows[0].cantidad)).toBe(24);
    expect(Number(r.rows[0].costo_unitario)).toBe(Number((130 / 24).toFixed(4)));
  });
});
