/** tests/combustible-urea-proveedores-interno-externo.test.ts
 *
 * La urea se divide como el combustible (migración 0133): un proveedor puede
 * vender urea INTERNA (se recibe en la planta, `abastece_urea`) y/o EXTERNA
 * (se compra en ruta, `abastece_urea_ruta`).
 *
 * Lo que se defiende, y que tiene que vivir en el SERVIDOR (un desplegable
 * filtrado es comodidad, no regla):
 *   1. La entrada al almacén y el vale de almacén exigen un proveedor interno.
 *   2. La compra en ruta exige uno externo.
 *   3. Los precios aceptan cualquiera de los dos.
 *   4. GET /urea/proveedores filtra por ?uso y devuelve los dos flags.
 *   5. El PUT del proveedor exige el campo nuevo (reemplaza la fila entera).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: proveedores de urea interno y externo (migración 0133)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;
  let interno: number; // solo urea interna
  let externo: number; // solo urea externa
  let ambos: number;
  let nVale = 1;
  const serie = `I${Math.floor(Math.random() * 1e6).toString(36)}`;

  const grifo = async (urea: boolean, ureaRuta: boolean) =>
    (
      await agente.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("PRV"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: urea,
        abastece_urea_ruta: ureaRuta,
      })
    ).body.id as number;

  const entrada = (grifoId: number) =>
    agente.post("/api/erp/combustible/recepciones").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      grifo_id: grifoId,
      presentacion: "caja",
      cantidad_bultos: 10,
      costo_unitario: 40,
      recibido_en: new Date().toISOString(),
    });

  const vale = (grifoId: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "almacen",
      grifo_id: grifoId,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie,
      n_vale: nVale++,
      presentacion: "caja",
      cantidad_bultos: 1,
      despachado_en: new Date().toISOString(),
    });

  const compra = (grifoId: number) =>
    agente.post("/api/erp/combustible/despachos").send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoId,
      tipo_destino: "equipo",
      equipo_id: equipoId,
      comprobante_tipo: "boleta",
      comprobante_numero: `B001-${Math.floor(Math.random() * 1e8)}`,
      presentacion: "caja",
      cantidad_bultos: 2,
      costo_unitario: 50,
      despachado_en: new Date().toISOString(),
    });

  const precio = (grifoId: number) =>
    agente.post("/api/erp/combustible/urea/precios").send({
      grifo_id: grifoId,
      presentacion: "caja",
      precio_por_bulto: 50,
      vigente_desde: new Date(Date.now() - 86400000).toISOString(),
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    equipoId = (
      await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" })
    ).body.id;
    interno = await grifo(true, false);
    externo = await grifo(false, true);
    ambos = await grifo(true, true);
    // Stock para los vales.
    expect((await entrada(interno)).status).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("un proveedor nuevo nace sin urea externa (default false)", async () => {
    const r = await agente
      .post("/api/erp/combustible/grifos")
      .send({ nombre: idUnico("SOLO"), abastece_urea: true });
    expect(r.status).toBe(201);
    expect(r.body.abastece_urea).toBe(true);
    expect(r.body.abastece_urea_ruta).toBe(false);
  });

  it("el PUT exige abastece_urea_ruta: reemplaza la fila entera", async () => {
    const base = {
      nombre: idUnico("PUT"),
      activo: true,
      abastece_ruta: false,
      abastece_tanque: false,
      abastece_urea: true,
    };
    const sin = await agente.put(`/api/erp/combustible/grifos/${interno}`).send(base);
    expect(sin.status).toBe(400);
    const con = await agente
      .put(`/api/erp/combustible/grifos/${interno}`)
      .send({ ...base, nombre: "Interno editado", abastece_urea_ruta: false });
    expect(con.status).toBe(200);
    expect(con.body.abastece_urea_ruta).toBe(false);
  });

  it("la entrada al almacén exige proveedor interno; uno solo externo da 400", async () => {
    expect((await entrada(ambos)).status).toBe(201);
    const r = await entrada(externo);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/interno/);
  });

  it("el vale de almacén exige proveedor interno; uno solo externo da 400", async () => {
    expect((await vale(interno)).status).toBe(201);
    const r = await vale(externo);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/interno/);
  });

  it("la compra en ruta exige proveedor externo; uno solo interno da 400", async () => {
    expect((await compra(externo)).status).toBe(201);
    expect((await compra(ambos)).status).toBe(201);
    const r = await compra(interno);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/externo/);
  });

  it("los precios aceptan un proveedor interno o externo", async () => {
    expect((await precio(interno)).status).toBe(201);
    expect((await precio(externo)).status).toBe(201);
  });

  it("GET /urea/proveedores filtra por uso y devuelve los dos flags", async () => {
    const ids = async (query = "") =>
      (await agente.get(`/api/erp/combustible/urea/proveedores${query}`)).body.map(
        (g: { id: number }) => g.id
      );
    const todos = await ids();
    expect(todos).toEqual(expect.arrayContaining([interno, externo, ambos]));

    const internos = await ids("?uso=interno");
    expect(internos).toEqual(expect.arrayContaining([interno, ambos]));
    expect(internos).not.toContain(externo);

    const externos = await ids("?uso=externo");
    expect(externos).toEqual(expect.arrayContaining([externo, ambos]));
    expect(externos).not.toContain(interno);

    const fila = (await agente.get("/api/erp/combustible/urea/proveedores")).body.find(
      (g: { id: number }) => g.id === ambos
    );
    expect(fila.abastece_urea).toBe(true);
    expect(fila.abastece_urea_ruta).toBe(true);
  });
});
