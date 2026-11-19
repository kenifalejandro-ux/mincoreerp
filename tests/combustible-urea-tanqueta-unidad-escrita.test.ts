/** tests/combustible-urea-tanqueta-unidad-escrita.test.ts
 *
 * La unidad escrita a mano (`unidad_sin_alta` + la placa, migración 0176) ya valía para el vale del
 * tanque propio. La migración 0192 se la abre a dos vales más, para que Combustible trabaje sin
 * Flota o con una unidad que la oficina aún no registró:
 *
 *   1. UREA, del almacén y de la compra en ruta.
 *   2. CARGA DESDE TANQUETA EN PLANTA (con vale). La carga en ruta sigue exigiendo unidad
 *      registrada: va por la unidad del conductor, que es dato de Flota.
 *
 * Lo que se fija:
 *   - El vale se guarda sin unidad, con su placa, y baja el stock / el saldo igual que uno con unidad.
 *   - Los controles que son DE LA UNIDAD (urea no habilitada, ratio, tope) no aplican: no hay unidad.
 *   - Sin Flota en la empresa: elegir una unidad registrada es un 400 claro, la placa escrita
 *     funciona y la tanqueta no se asigna a una unidad.
 *   - Lo que no se abrió sigue cerrado: la carga en ruta y el excedente piden unidad registrada.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/combustible";
const DIA = 86400000;
const hace = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("urea y carga desde tanqueta a una unidad escrita a mano", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let equipoId: number;
  const placa = idUnico("UE").toUpperCase();
  let grifoUrea: number;
  let sede: number;
  let tanqueId: number;
  let tanquetaId: number;
  let nVale = 1;
  const serie = `U${Math.floor(Math.random() * 1e8).toString(36)}`.toUpperCase();

  const flota = (estado: "habilitado" | "deshabilitado") =>
    pool.query(`UPDATE tenant_modulos SET estado = $2 WHERE tenant_id = $1 AND modulo = 'flota'`, [
      tenantId,
      estado,
    ]);

  const stockUrea = async () => Number((await admin.get(`${BASE}/urea/estado`)).body.stock.stockL);

  const valeUrea = (extra: Record<string, unknown> = {}) =>
    admin.post(`${BASE}/despachos`).send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "almacen",
      grifo_id: grifoUrea,
      tipo_destino: "unidad_sin_alta",
      placa_sin_alta: placa,
      serie_talonario: serie,
      n_vale: nVale++,
      lineas: [{ presentacion: "caja", cantidad_bultos: 1 }],
      despachado_en: hace(DIA),
      ...extra,
    });

  const compraUrea = (extra: Record<string, unknown> = {}) =>
    admin.post(`${BASE}/despachos`).send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoRuta,
      tipo_destino: "unidad_sin_alta",
      placa_sin_alta: placa,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      lineas: [{ presentacion: "caja", cantidad_bultos: 2, costo_unitario: 50 }],
      despachado_en: new Date().toISOString(),
      ...extra,
    });
  let grifoRuta: number;

  const cargaDeTanqueta = (extra: Record<string, unknown> = {}) =>
    admin.post(`${BASE}/despachos`).send({
      origen: "tanqueta",
      tanqueta_origen_id: tanquetaId,
      tanqueta_lugar: "planta",
      tipo_combustible: "diesel_b5",
      tipo_destino: "unidad_sin_alta",
      placa_sin_alta: placa,
      serie_talonario: serie,
      n_vale: nVale++,
      cantidad: 10,
      ...extra,
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password: PASSWORD });
    sede = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;

    equipoId = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: placa,
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: sede,
      })
    ).body.id;
    grifoUrea = (
      await admin.post(`${BASE}/grifos`).send({
        nombre: idUnico("UREAINT"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;
    grifoRuta = (
      await admin.post(`${BASE}/grifos`).send({
        nombre: idUnico("UREARUTA"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
    // Entrada de urea al almacén: sin stock el vale del almacén no se puede registrar.
    const ent = await admin.post(`${BASE}/recepciones`).send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoUrea,
      tipo_documento: "factura",
      numero_documento: `F-${Math.floor(Math.random() * 1e8)}`,
      lineas: [{ presentacion: "caja", cantidad_bultos: 20, costo_unitario: 95 }],
      recibido_en: hace(3 * DIA),
    });
    expect(ent.status, JSON.stringify(ent.body)).toBe(201);

    // Una tanqueta con saldo (llenada desde un tanque en galones).
    tanqueId = (
      await admin.post(`${BASE}`).send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Tanque UE",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 10000,
        nivel_actual: 8000,
        requiere_documento: false,
        grifo_interno_id: sede,
      })
    ).body.id;
    tanquetaId = Number(
      (await admin.post(`${BASE}/tanquetas`).send({ grifo_interno_id: sede })).body.id
    );
    const lleno = await admin.post(`${BASE}/despachos`).send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: tanquetaId,
      serie_talonario: serie,
      n_vale: nVale++,
      cantidad: 200,
      lectura_contometro: 200,
      costo_unitario: 16,
    });
    expect(lleno.status, JSON.stringify(lleno.body)).toBe(201);
  });

  afterAll(async () => {
    await flota("habilitado");
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  // ── 1. Urea ─────────────────────────────────────────────────────────────

  it("un vale de urea del almacén a una unidad escrita a mano se guarda con su placa y baja el stock", async () => {
    // Con Flota, la placa escrita de una unidad que SÍ existe se engancha a ella (regla de 0176).
    const antes = await stockUrea();
    const aRegistrada = await valeUrea();
    expect(aRegistrada.status, JSON.stringify(aRegistrada.body)).toBe(201);
    expect(aRegistrada.body.tipo_destino).toBe("equipo");
    expect(aRegistrada.body.equipo_id).toBe(equipoId);

    // Una placa que no existe en la flota se queda escrita.
    const otra = `ZZ${Math.floor(Math.random() * 1e5)}`;
    const escrita = await valeUrea({ placa_sin_alta: otra });
    expect(escrita.status, JSON.stringify(escrita.body)).toBe(201);
    expect(escrita.body.tipo_destino).toBe("unidad_sin_alta");
    expect(escrita.body.equipo_id).toBeNull();
    expect(escrita.body.placa_sin_alta).toBe(otra);
    expect(await stockUrea()).toBe(antes - 32);
  });

  it("la placa escrita de urea sigue las mismas reglas: obligatoria, y nunca junto a una unidad", async () => {
    const sinPlaca = await valeUrea({ placa_sin_alta: undefined });
    expect(sinPlaca.status).toBe(400);
    expect(JSON.stringify(sinPlaca.body)).toMatch(/placa/i);

    const conAmbas = await valeUrea({ equipo_id: equipoId });
    expect(conAmbas.status).toBe(400);

    const placaConUnidad = await valeUrea({
      tipo_destino: "equipo",
      equipo_id: equipoId,
      placa_sin_alta: "ABC123",
    });
    expect(placaConUnidad.status).toBe(400);
  });

  it("una compra en ruta de urea a una unidad escrita se guarda, y no dispara los controles de la unidad", async () => {
    const otra = `ZY${Math.floor(Math.random() * 1e5)}`;
    const r = await compraUrea({ placa_sin_alta: otra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.tipo_destino).toBe("unidad_sin_alta");
    expect(r.body.equipo_id).toBeNull();
    // Sin unidad no hay «urea_equipo_no_habilitado» ni ratio que calcular.
    const alertas = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM combustible_alertas
          WHERE tenant_id = $1 AND despacho_id = $2
            AND tipo IN ('urea_equipo_no_habilitado', 'urea_ratio_excedido', 'tope_diario_excedido')`,
        [tenantId, r.body.id]
      )
    );
    expect(alertas.rowCount).toBe(0);
  });

  // ── 2. Carga desde tanqueta ─────────────────────────────────────────────

  it("una carga desde tanqueta EN PLANTA a una unidad escrita se guarda y baja el saldo", async () => {
    const otra = `ZX${Math.floor(Math.random() * 1e5)}`;
    const saldo = async () =>
      Number(
        ((await admin.get(`${BASE}/tanquetas`)).body as { id: number; saldo: string }[]).find(
          (t) => Number(t.id) === tanquetaId
        )?.saldo
      );
    const antes = await saldo();
    const r = await cargaDeTanqueta({ placa_sin_alta: otra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.tipo_destino).toBe("unidad_sin_alta");
    expect(r.body.equipo_id).toBeNull();
    expect(r.body.placa_sin_alta).toBe(otra);
    expect(await saldo()).toBe(antes - 10);

    // En el historial de la tanqueta la salida muestra la placa escrita.
    const historial = await admin.get(`${BASE}/tanquetas/${tanquetaId}/historial`);
    expect(historial.status, JSON.stringify(historial.body)).toBe(200);
    expect(JSON.stringify(historial.body)).toContain(otra);
  });

  it("la carga desde tanqueta EN RUTA sigue pidiendo una unidad registrada", async () => {
    const r = await cargaDeTanqueta({
      tanqueta_lugar: "ruta",
      serie_talonario: undefined,
      n_vale: undefined,
      lectura_horometro: 100,
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/unidad/i);
  });

  // ── 3. Sin Flota en la empresa ──────────────────────────────────────────

  it("SIN Flota: urea y tanqueta aceptan la placa escrita, rechazan elegir una unidad y no se asigna la tanqueta", async () => {
    await flota("deshabilitado");
    try {
      const otra = `ZW${Math.floor(Math.random() * 1e5)}`;
      // La placa de una unidad vieja NO se engancha a ella: sin Flota no se lee `equipos`.
      const urea = await valeUrea({ placa_sin_alta: placa });
      expect(urea.status, JSON.stringify(urea.body)).toBe(201);
      expect(urea.body.tipo_destino).toBe("unidad_sin_alta");
      expect(urea.body.equipo_id).toBeNull();
      const carga = await cargaDeTanqueta({ placa_sin_alta: otra });
      expect(carga.status, JSON.stringify(carga.body)).toBe(201);

      const eligeUrea = await valeUrea({
        tipo_destino: "equipo",
        equipo_id: equipoId,
        placa_sin_alta: undefined,
      });
      expect(eligeUrea.status, JSON.stringify(eligeUrea.body)).toBe(400);
      expect(JSON.stringify(eligeUrea.body)).toMatch(/no tiene el módulo Flota/);

      const asigna = await admin
        .put(`${BASE}/tanquetas/${tanquetaId}/asignar`)
        .send({ equipo_id: equipoId, serie_talonario: serie, n_vale: nVale++ });
      expect(asigna.status, JSON.stringify(asigna.body)).toBe(400);
      expect(JSON.stringify(asigna.body)).toMatch(/Flota/);
    } finally {
      await flota("habilitado");
    }
  });
});
