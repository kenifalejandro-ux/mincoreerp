/** tests/combustible-despacho-sin-medidor.test.ts
 *
 * Pedir (o no) el horómetro/odómetro en el vale del tanque (migración 0113).
 * Por defecto NO se pide (decisión de Kenif): el vale entra sin medidor y sin
 * la alerta "sin lectura", porque el medidor se toma en las cargas en ruta.
 * Prenderlo endurece; volver a apagarlo es un aflojamiento: pide motivo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: horómetro opcional en el despacho del tanque (0113)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tanqueId: number;
  let equipoId: number;
  let nVale = 1;

  const configBase = {
    ventana_gracia_horas: 72,
    dias_sin_medir: 3,
    dias_ventana_descuadre: 30,
    dias_carga_retroactiva: 3,
    dias_sin_vigilancia: 7,
    llenados_por_dia_max: null,
    tope_diario_sin_capacidad_l: null,
  };

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    const t = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Huamachuco",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 8000,
      requiere_documento: false,
    });
    expect(t.status).toBe(201);
    tanqueId = t.body.id;
    const e = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE", tipo_medidor: "horometro" });
    expect(e.status).toBe(201);
    equipoId = e.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const valeSinMedidor = () =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: "HMC",
      n_vale: nVale++,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
    });

  const alertaSinLectura = async (despachoId: number) => {
    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 100 });
    return r.body.data.find(
      (a: { tipo: string; despacho_id: number; detalle: { motivo?: string } }) =>
        a.tipo === "medidor_inconsistente" &&
        Number(a.despacho_id) === Number(despachoId) &&
        a.detalle?.motivo === "sin_lectura"
    );
  };

  it("por defecto NO se pide: el vale sin horómetro entra sin alerta 'sin lectura'", async () => {
    const formulario = await admin.get("/api/erp/combustible/config/formulario-despacho");
    expect(formulario.body.despacho_pide_medidor).toBe(false);
    const v = await valeSinMedidor();
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(await alertaSinLectura(v.body.id)).toBeUndefined();
  });

  it("prenderlo endurece (sin motivo) y el vale sin horómetro vuelve a alertar", async () => {
    const r = await admin
      .put("/api/erp/combustible/config")
      .send({ ...configBase, despacho_pide_medidor: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.despacho_pide_medidor).toBe(true);
    const v = await valeSinMedidor();
    expect(v.status).toBe(201);
    expect(await alertaSinLectura(v.body.id)).toBeDefined();
  });

  it("volver a apagarlo es un aflojamiento: sin motivo da 400, con motivo pasa", async () => {
    const sinMotivo = await admin
      .put("/api/erp/combustible/config")
      .send({ ...configBase, despacho_pide_medidor: false });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.requiere_motivo).toBe(true);

    const r = await admin.put("/api/erp/combustible/config").send({
      ...configBase,
      despacho_pide_medidor: false,
      motivo_ajuste: "El horómetro se toma en las cargas en ruta",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.despacho_pide_medidor).toBe(false);
    const v = await valeSinMedidor();
    expect(v.status).toBe(201);
    expect(await alertaSinLectura(v.body.id)).toBeUndefined();
  });

  it("el grifero lee la opción por su endpoint, no la config completa", async () => {
    const grifero = request.agent(app);
    const dni = String(89100000 + Math.floor(Math.random() * 800000));
    expect(
      (
        await admin
          .post("/api/erp/usuarios")
          .send({ nombre: "Grifero", dni, password, rol: "grifero" })
      ).status
    ).toBe(201);
    await grifero.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    const f = await grifero.get("/api/erp/combustible/config/formulario-despacho");
    expect(f.status).toBe(200);
    expect(f.body.despacho_pide_medidor).toBe(false);
    expect((await grifero.get("/api/erp/combustible/config")).status).toBe(403);
  });
});
