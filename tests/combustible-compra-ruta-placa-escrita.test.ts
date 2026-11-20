/** tests/combustible-compra-ruta-placa-escrita.test.ts
 *
 * La compra en ruta del conductor a una unidad ESCRITA A MANO (migración 0196). Una empresa sin
 * Flota, o con una unidad que la oficina aún no registró, escribe la placa. La cabecera de la boleta
 * y los vales de cada producto llevan la misma unidad: la registrada o la placa. Lo que se fija:
 *
 * 1. Con Flota, una placa que es de una unidad registrada la toma (una sola regla): la cabecera y
 *    los vales dicen lo mismo.
 * 2. Una placa que no es de ninguna unidad queda escrita en la cabecera y en los dos vales, sin
 *    medidor (no hay unidad de la que leerlo), con combustible, urea o los dos.
 * 3. La unidad es una de las dos (el esquema lo exige).
 * 4. El reintento con el mismo `cliente_uuid` no duplica nada.
 * 5. Sin Flota en la EMPRESA: elegir una unidad registrada da un 400 claro, la placa escrita
 *    funciona y no se toma la unidad vieja.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";
const RUTA = "/api/erp/combustible/compras-ruta";

describe("compra en ruta a una unidad escrita a mano (0196)", () => {
  let tenantId: string;
  const admin = request.agent(app);
  let equipoId: number;
  let grifo: number;
  const placaRegistrada = idUnico("CR").toUpperCase();

  const flota = (estado: "habilitado" | "deshabilitado") =>
    pool.query(`UPDATE tenant_modulos SET estado = $2 WHERE tenant_id = $1 AND modulo = 'flota'`, [
      tenantId,
      estado,
    ]);
  const nuevaPlaca = () => `ZR${Math.floor(Math.random() * 1e6)}`;
  const numero = () => `B001-${Math.floor(Math.random() * 1e8)}`;

  /** 40 gal × S/ 17.50 = 700.00; 2 cajas × S/ 50 = 100.00. Sin medidor ni horas. */
  const cuerpo = (over: Record<string, unknown> = {}) => ({
    cliente_uuid: crypto.randomUUID(),
    grifo_id: grifo,
    comprobante_tipo: "boleta",
    comprobante_numero: numero(),
    despachado_en: new Date().toISOString(),
    combustible: { tipo_combustible: "diesel_b5", cantidad: 40, costo_unitario: 17.5 },
    urea: { lineas: [{ presentacion: "caja", cantidad_bultos: 2, costo_unitario: 50 }] },
    ...over,
  });

  const cabecera = async (comprobante: string) =>
    (
      await withTenant(tenantId, (c) =>
        c.query(
          `SELECT unidad_equipo_id, placa_sin_alta FROM combustible_compras_ruta
            WHERE tenant_id = $1 AND comprobante_numero = $2`,
          [tenantId, comprobante]
        )
      )
    ).rows;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password: PASSWORD });
    equipoId = Number(
      (
        await admin.post("/api/erp/equipos").send({
          placa_codigo: placaRegistrada,
          tipo: "VOLQUETE",
          tipo_medidor: "horometro",
        })
      ).body.id
    );
    grifo = (
      await admin.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("PRIMAX"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
  });

  afterAll(async () => {
    await flota("habilitado");
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("CON Flota: la placa escrita de una unidad registrada la toma, y la cabecera y los vales coinciden", async () => {
    const body = cuerpo({
      placa_sin_alta: `${placaRegistrada.slice(0, 2)}-${placaRegistrada.slice(2).toLowerCase()}`,
    });
    const r = await admin.post(RUTA).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.despacho_combustible.equipo_id).toBe(equipoId);
    expect(r.body.despacho_urea.equipo_id).toBe(equipoId);
    const [fila] = await cabecera(body.comprobante_numero);
    expect(Number(fila.unidad_equipo_id)).toBe(equipoId);
    expect(fila.placa_sin_alta).toBeNull();
  });

  it("una placa que no es de ninguna unidad queda escrita en la cabecera y en los dos vales, sin medidor", async () => {
    const placa = nuevaPlaca();
    const body = cuerpo({ placa_sin_alta: placa.toLowerCase() });
    const r = await admin.post(RUTA).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    for (const v of [r.body.despacho_combustible, r.body.despacho_urea]) {
      expect(v.tipo_destino).toBe("unidad_sin_alta");
      expect(v.equipo_id).toBeNull();
      expect(v.placa_sin_alta).toBe(placa);
    }
    expect(r.body.despacho_combustible.lectura_horometro).toBeNull();
    expect(r.body.despacho_combustible.lectura_odometro).toBeNull();
    const [fila] = await cabecera(body.comprobante_numero);
    expect(fila.unidad_equipo_id).toBeNull();
    expect(fila.placa_sin_alta).toBe(placa);
  });

  it("también con solo combustible o solo urea", async () => {
    const soloCombustible = await admin
      .post(RUTA)
      .send(cuerpo({ placa_sin_alta: nuevaPlaca(), urea: undefined }));
    expect(soloCombustible.status, JSON.stringify(soloCombustible.body)).toBe(201);
    expect(soloCombustible.body.despacho_urea).toBeNull();
    const soloUrea = await admin
      .post(RUTA)
      .send(cuerpo({ placa_sin_alta: nuevaPlaca(), combustible: undefined }));
    expect(soloUrea.status, JSON.stringify(soloUrea.body)).toBe(201);
    expect(soloUrea.body.despacho_combustible).toBeNull();
  });

  it("la unidad es una de las dos", async () => {
    const ambas = await admin
      .post(RUTA)
      .send(cuerpo({ equipo_id: equipoId, placa_sin_alta: nuevaPlaca() }));
    expect(ambas.status).toBe(400);
    const ninguna = await admin.post(RUTA).send(cuerpo());
    expect(ninguna.status).toBe(400);
  });

  it("el reintento con el mismo cliente_uuid no duplica la compra ni los vales", async () => {
    const body = cuerpo({ placa_sin_alta: nuevaPlaca() });
    const primera = await admin.post(RUTA).send(body);
    const segunda = await admin.post(RUTA).send(body);
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);
    expect([200, 201]).toContain(segunda.status);
    expect(await cabecera(body.comprobante_numero)).toHaveLength(1);
    const vales = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM combustible_despachos WHERE tenant_id = $1 AND comprobante_numero = $2`,
        [tenantId, body.comprobante_numero]
      )
    );
    expect(vales.rowCount).toBe(2);
  });

  it("el historial de compras en ruta muestra la compra con su placa escrita", async () => {
    const placa = nuevaPlaca();
    const body = cuerpo({ placa_sin_alta: placa });
    expect((await admin.post(RUTA).send(body)).status).toBe(201);
    const lista = await admin.get(RUTA);
    expect(lista.status, JSON.stringify(lista.body).slice(0, 300)).toBe(200);
    const texto = JSON.stringify(lista.body);
    expect(texto).toContain(body.comprobante_numero);
    expect(texto).toContain(placa);
  });

  it("SIN Flota: elegir una unidad registrada da 400, la placa escrita funciona y no se toma la unidad vieja", async () => {
    await flota("deshabilitado");
    try {
      const elige = await admin.post(RUTA).send(cuerpo({ equipo_id: equipoId }));
      expect(elige.status, JSON.stringify(elige.body)).toBe(400);
      expect(JSON.stringify(elige.body)).toMatch(/no tiene el módulo Flota/);

      const body = cuerpo({ placa_sin_alta: placaRegistrada });
      const r = await admin.post(RUTA).send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.despacho_combustible.equipo_id).toBeNull();
      const [fila] = await cabecera(body.comprobante_numero);
      expect(fila.unidad_equipo_id).toBeNull();
      expect(fila.placa_sin_alta).toBe(placaRegistrada.replace(/[^A-Z0-9]/g, ""));
    } finally {
      await flota("habilitado");
    }
  });
});
