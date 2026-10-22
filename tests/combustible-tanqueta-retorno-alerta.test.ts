/** tests/combustible-tanqueta-retorno-alerta.test.ts
 *
 * Al recibir una tanqueta de vuelta (0143), el saldo que validó el grifero
 * dispara una alerta (0144) si se aparta del calculado más de 5 gal o del 5 %
 * (lo que sea mayor) hacia abajo, o si es MAYOR en cualquier cantidad.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  recibirTanqueta,
} from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

describe("combustible: alerta por la diferencia al recibir una tanqueta (0144)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let principal: number;
  let tanqueId: number;
  let unidad: number;
  let nVale = 1;
  let nAsig = 1;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    principal = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    unidad = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("VQ"),
        tipo: "VOLQUETE",
        tipo_medidor: "horometro",
        grifo_interno_id: principal,
      })
    ).body.id;
    tanqueId = (
      await admin.post("/api/erp/combustible").send({
        codigo: idUnico("TQ"),
        tanque_nombre: "Huamachuco",
        tipo_combustible: "diesel_b5",
        unidad: "gal",
        tipo_punto: "fijo",
        capacidad_total: 10000,
        nivel_actual: 8000,
        requiere_documento: false,
        grifo_interno_id: principal,
      })
    ).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Una tanqueta con `cantidad` gal, asignada a la unidad. Devuelve id y código. */
  const tanquetaAsignada = async (cantidad: number) => {
    const t = await admin
      .post("/api/erp/combustible/tanquetas")
      .send({ grifo_interno_id: principal });
    const id = Number(t.body.id);
    const v = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanqueId,
      tipo_combustible: "diesel_b5",
      tipo_destino: "reserva_cubeta",
      tanqueta_destino_id: id,
      serie_talonario: "RET",
      n_vale: nVale++,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const a = await admin
      .put(`/api/erp/combustible/tanquetas/${id}/asignar`)
      .send({ equipo_id: unidad, serie_talonario: "RAS", n_vale: nAsig++ });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return { id, codigo: t.body.codigo as string };
  };

  const alertasDe = async (codigo: string) => {
    const r = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
    expect(r.status).toBe(200);
    return (r.body.data as { tipo: string; detalle: Record<string, unknown> }[]).filter(
      (a) => a.tipo === "tanqueta_retorno_diferencia" && a.detalle.tanqueta === codigo
    );
  };

  const recibir = async (cantidad: number, validado: number) => {
    const t = await tanquetaAsignada(cantidad);
    const r = await recibirTanqueta(admin, t.id, { validado, motivo: "prueba" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return t;
  };

  it("el saldo igual al calculado no alerta", async () => {
    const t = await recibir(100, 100);
    expect(await alertasDe(t.codigo)).toHaveLength(0);
  });

  it("una merma dentro del margen (5 gal) no alerta", async () => {
    const t = await recibir(100, 95);
    expect(await alertasDe(t.codigo)).toHaveLength(0);
  });

  it("el margen crece con el saldo: 8 gal de 200 no alertan, 11 sí", async () => {
    const poca = await recibir(200, 192);
    expect(await alertasDe(poca.codigo)).toHaveLength(0);
    const mucha = await recibir(200, 189);
    expect(await alertasDe(mucha.codigo)).toHaveLength(1);
  });

  it("una merma que pasa del margen alerta, con quién, cuánto y por qué", async () => {
    const t = await tanquetaAsignada(100);
    const r = await recibirTanqueta(admin, t.id, { validado: 90, motivo: "se derramó" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const alertas = await alertasDe(t.codigo);
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle).toMatchObject({
      saldoCalculado: 100,
      saldoValidado: 90,
      diferencia: -10,
      motivo: "se derramó",
    });
    expect(alertas[0].detalle.usuarioId).toBeTruthy();
  });

  it("declarar que volvió MÁS de lo calculado alerta, aunque sea poco", async () => {
    const t = await tanquetaAsignada(100);
    const r = await recibirTanqueta(admin, t.id, { validado: 101, motivo: "estaba mal medida" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const alertas = await alertasDe(t.codigo);
    expect(alertas).toHaveLength(1);
    expect(alertas[0].detalle.diferencia).toBe(1);
  });

  it("la alerta lleva el grifo de la tanqueta y, pasada la ventana, se congela como anomalía", async () => {
    const t = await tanquetaAsignada(100);
    expect(
      (await recibirTanqueta(admin, t.id, { validado: 80, motivo: "evaporación" })).status
    ).toBe(201);
    await withTenant(tenantId, async (client) => {
      const q = await client.query(
        `SELECT id, grifo_interno_id FROM combustible_alertas
          WHERE tenant_id = $1 AND tipo = 'tanqueta_retorno_diferencia'
            AND detalle->>'tanqueta' = $2`,
        [tenantId, t.codigo]
      );
      expect(q.rows).toHaveLength(1);
      expect(Number(q.rows[0].grifo_interno_id)).toBe(principal);
      await client.query(
        `UPDATE combustible_alertas SET creado_en = now() - interval '100 hours' WHERE id = $1`,
        [q.rows[0].id]
      );
    });
    await correrConciliacion(tenantId);
    const congeladas = await withTenant(
      tenantId,
      async (client) =>
        (
          await client.query(
            `SELECT tanqueta_retorno_id FROM combustible_anomalias
            WHERE tenant_id = $1 AND tipo = 'tanqueta_retorno_diferencia'
              AND detalle->>'tanqueta' = $2`,
            [tenantId, t.codigo]
          )
        ).rows
    );
    expect(congeladas).toHaveLength(1);
    expect(congeladas[0].tanqueta_retorno_id).toBeTruthy();
  });
});
