/** tests/combustible-cisterna-alerta.test.ts
 *
 * La cisterna que sigue con saldo pasado el plazo (migración 0170). Lo que se
 * deja en la cisterna se reparte en unos días y ella vuelve vacía: si pasado el
 * plazo todavía tiene saldo, algo quedó sin repartir. Es un ESTADO (se cierra
 * sola), una alerta por recepción, y va solo al ERP, sin correo.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";
import { canalDeFila } from "../src/modules/combustible/canalesAlertas";
import { TIPOS_ESTADO } from "../src/modules/combustible/combustible.repository";

const TIPO = "cisterna_con_saldo";

describe("combustible: cisterna con saldo sin repartir (0170)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let proveedor: number;
  let principal: number;
  let unidad: number;
  let nVale = 4000;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    proveedor = (
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
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function tanque(opciones: { nivel: number; capacidad: number; flexible?: boolean }) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque de prueba",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: opciones.capacidad,
      nivel_actual: opciones.nivel,
      nivel_minimo: 100,
      modo_vigilancia: "sin_vigilar",
      requiere_documento: false,
      ...(opciones.flexible ? { modo_excedente_recepcion: "flexible" } : {}),
      grifo_interno_id: principal,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  /** Una cisterna con `cantidad` gal en saldo, recibida hace `dias` días. */
  async function cisterna(cantidad: number, dias: number) {
    const lleno = await tanque({ nivel: 2000, capacidad: 2000, flexible: true });
    const rec = await admin.post("/api/erp/combustible/recepciones").send({
      combustible_id: lleno,
      grifo_id: proveedor,
      cantidad,
      costo_unitario: 16.5,
      tipo_documento: "factura",
      numero_documento: idUnico("F"),
      recibido_en: new Date().toISOString(),
      reparto_excedente: [{ destino: "cisterna", cantidad }],
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    await envejecer(rec.body.id, dias);
    const linea = (await admin.get("/api/erp/combustible/despachos/cisternas-con-saldo")).body.find(
      (c: { recepcion_id: string }) => Number(c.recepcion_id) === Number(rec.body.id)
    );
    return { recepcionId: rec.body.id as number, lineaId: Number(linea.id), lleno };
  }

  const envejecer = (recepcionId: number, dias: number) =>
    withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_recepciones SET recibido_en = now() - make_interval(days => $3)
          WHERE id = $1 AND tenant_id = $2`,
        [recepcionId, tenantId, dias]
      )
    );

  const alertas = (recepcionId: number) =>
    withTenant(tenantId, async (c) => {
      const r = await c.query(
        `SELECT resuelta_en, detalle, grifo_interno_id, combustible_id FROM combustible_alertas
          WHERE tenant_id = $1 AND recepcion_id = $2 AND tipo = $3`,
        [tenantId, recepcionId, TIPO]
      );
      return r.rows;
    });

  const salida = (lineaId: number, cantidad: number) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "excedente_recepcion",
      excedente_linea_id: lineaId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: unidad,
      serie_talonario: "AL",
      n_vale: nVale++,
      cantidad,
      lectura_horometro: 100,
      costo_unitario: 1,
    });

  const config = async () => (await admin.get("/api/erp/combustible/config")).body;
  const guardar = async (cambios: Record<string, unknown>) => {
    const actual = await config();
    return admin.put("/api/erp/combustible/config").send({ ...actual, ...cambios });
  };
  const sinPlazo = async () => {
    const actual = await config();
    delete actual.dias_cisterna_con_saldo;
    return actual;
  };

  it("recién recibida no alerta; pasado el plazo sí, una sola vez y con su sede", async () => {
    const { recepcionId } = await cisterna(500, 2);
    await correrConciliacion(tenantId);
    expect(await alertas(recepcionId)).toHaveLength(0);

    await envejecer(recepcionId, 12);
    await correrConciliacion(tenantId);
    const abierta = await alertas(recepcionId);
    expect(abierta).toHaveLength(1);
    expect(abierta[0].resuelta_en).toBeNull();
    expect(Number(abierta[0].detalle.saldo)).toBe(500);
    expect(abierta[0].detalle.plazoDias).toBe(10);
    expect(abierta[0].grifo_interno_id).toBe(principal);

    // Otra corrida no la duplica.
    await correrConciliacion(tenantId);
    expect(await alertas(recepcionId)).toHaveLength(1);
  });

  it("se cierra sola al repartir todo, no con un reparto parcial", async () => {
    const { recepcionId, lineaId } = await cisterna(500, 12);
    await correrConciliacion(tenantId);
    expect(await alertas(recepcionId)).toHaveLength(1);

    expect((await salida(lineaId, 300)).status).toBe(201);
    await correrConciliacion(tenantId);
    expect((await alertas(recepcionId))[0].resuelta_en).toBeNull();

    expect((await salida(lineaId, 200)).status).toBe(201);
    await correrConciliacion(tenantId);
    expect((await alertas(recepcionId))[0].resuelta_en).not.toBeNull();
  });

  it("pasar lo que queda al tanque también la cierra", async () => {
    const { recepcionId, lineaId } = await cisterna(300, 12);
    const destino = await tanque({ nivel: 1000, capacidad: 10000 });
    await correrConciliacion(tenantId);
    expect(await alertas(recepcionId)).toHaveLength(1);

    const p = await admin.post("/api/erp/combustible/despachos/cisterna-al-tanque").send({
      linea_id: lineaId,
      combustible_id: destino,
      cantidad: 300,
      cliente_uuid: randomUUID(),
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    await correrConciliacion(tenantId);
    expect((await alertas(recepcionId))[0].resuelta_en).not.toBeNull();
  });

  it("anular la recepción la cierra", async () => {
    const { recepcionId } = await cisterna(200, 12);
    await correrConciliacion(tenantId);
    expect(await alertas(recepcionId)).toHaveLength(1);

    const a = await admin
      .patch(`/api/erp/combustible/recepciones/${recepcionId}/anular`)
      .send({ motivo: "error" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    await correrConciliacion(tenantId);
    expect((await alertas(recepcionId))[0].resuelta_en).not.toBeNull();
  });

  it("el plazo es de la empresa: bajarlo alerta una cisterna reciente, subirlo pide motivo", async () => {
    const { recepcionId } = await cisterna(100, 6);
    await correrConciliacion(tenantId);
    expect(await alertas(recepcionId)).toHaveLength(0);

    const baja = await guardar({ dias_cisterna_con_saldo: 5 });
    expect(baja.status, JSON.stringify(baja.body)).toBe(200);
    expect((await config()).dias_cisterna_con_saldo).toBe(5);
    await correrConciliacion(tenantId);
    const abierta = await alertas(recepcionId);
    expect(abierta).toHaveLength(1);
    expect(abierta[0].detalle.plazoDias).toBe(5);

    // Subirlo deja a las cisternas olvidadas más tiempo: pide motivo.
    const sube = await guardar({ dias_cisterna_con_saldo: 30 });
    expect(sube.status).toBe(400);
    expect(sube.body.requiere_motivo).toBe(true);
    expect(JSON.stringify(sube.body.aflojados)).toContain("cisterna");
    expect((await config()).dias_cisterna_con_saldo).toBe(5);
    const conMotivo = await guardar({
      dias_cisterna_con_saldo: 10,
      motivo_ajuste: "La cisterna se queda una semana",
    });
    expect(conMotivo.status, JSON.stringify(conMotivo.body)).toBe(200);
    expect((await config()).dias_cisterna_con_saldo).toBe(10);
  });

  it("un valor fuera de rango es 400, y un PUT sin el campo no falla y lo deja en el default", async () => {
    expect((await guardar({ dias_cisterna_con_saldo: 0 })).status).toBe(400);
    expect((await guardar({ dias_cisterna_con_saldo: 91 })).status).toBe(400);
    expect((await guardar({ dias_cisterna_con_saldo: 2.5 })).status).toBe(400);

    // Una pantalla anterior a este cambio no manda el campo.
    const cuerpo = await sinPlazo();
    const viejo = await admin.put("/api/erp/combustible/config").send(cuerpo);
    expect(viejo.status, JSON.stringify(viejo.body)).toBe(200);
    expect((await config()).dias_cisterna_con_saldo).toBe(10);
  });

  it("va solo al ERP: sin correo", () => {
    expect(canalDeFila(TIPO)).toBe("solo_erp");
  });

  it("es un estado: no se congela ni se cierra a mano, lo resuelve el hecho", () => {
    expect(TIPOS_ESTADO as readonly string[]).toContain(TIPO);
  });
});
