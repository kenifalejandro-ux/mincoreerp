/** tests/equipos-lecturas.test.ts
 *
 * Las lecturas del medidor de la unidad (migración 0187), de Flota. Lo que se fija:
 *
 * 1. AUTONOMÍA: una empresa con SOLO Flota (sin Combustible ni Viajes) registra, consulta y anula
 *    lecturas completas.
 * 2. NO RETROCEDER: ni menor que la anterior ni mayor que una posterior; el 400 es del servicio,
 *    nunca un 500; y con registros a la vez el historial queda ordenado.
 * 3. IDEMPOTENCIA: el reintento de la cola sin señal no duplica; un uuid reusado con otro dato da 409.
 * 4. LO PASADO NO SE REESCRIBE: anular pide motivo, no se anula dos veces, y la base rechaza
 *    editar una lectura (trigger).
 * 5. QUIÉN Y POR QUÉ: la bitácora guarda al autor, el valor y el motivo.
 * 6. AISLAMIENTO Y PERMISOS: otra empresa no ve ni escribe; Lectura no escribe.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

const haceHoras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe("lecturas del medidor de la unidad (Flota)", () => {
  const empresas: Empresa[] = [];

  const nueva = async (soloFlota = true) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    if (soloFlota) {
      const r = await request(app)
        .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
        .set("Authorization", BEARER)
        .send({
          configuraciones: MODULOS.map((m) => ({
            modulo: m.id,
            estado: m.id === "flota" ? "habilitado" : "deshabilitado",
          })),
        });
      expect(r.status).toBe(200);
    }
    return e;
  };
  const sesion = async (e: Empresa, email = e.usuario.email, password = PASSWORD) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password });
    expect(res.status).toBe(200);
    return agente;
  };
  type Agente = Awaited<ReturnType<typeof sesion>>;

  const unidad = async (
    admin: Agente,
    tipo_medidor: "horometro" | "odometro" | null = "horometro"
  ) => {
    const res = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("EQ"),
      tipo: "Volquete",
      ...(tipo_medidor ? { tipo_medidor } : {}),
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  };
  const usuario = async (admin: Agente, rol: "operador" | "lectura") => {
    const email = `${idUnico(rol)}@test.local`;
    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: `Usuario ${rol}`,
      email,
      password: PASSWORD,
      rol,
      dni: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
    });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    return email;
  };
  const registrar = (a: Agente, id: number, cuerpo: Record<string, unknown>) =>
    a.post(`/api/erp/equipos/${id}/lecturas`).send(cuerpo);

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("una empresa con SOLO Flota registra, consulta la última y ve el historial", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    // De verdad es una empresa solo con Flota: Combustible no está disponible.
    expect((await admin.get("/api/erp/combustible")).status).toBe(403);

    const id = await unidad(admin);
    expect((await admin.get(`/api/erp/equipos/${id}/lecturas/ultima`)).body.lectura).toBeNull();

    const creada = await registrar(admin, id, { valor: 1200.5, leido_en: haceHoras(2) });
    expect(creada.status).toBe(201);
    expect(creada.body).toMatchObject({ tipo: "horometro", valor: 1200.5, origen: "manual" });
    expect(creada.body.registrado_por).toBe("Admin de prueba");

    const ultima = await admin.get(`/api/erp/equipos/${id}/lecturas/ultima`);
    expect(ultima.body.tipo_medidor).toBe("horometro");
    expect(ultima.body.lectura.valor).toBe(1200.5);
    expect((await admin.get(`/api/erp/equipos/${id}/lecturas`)).body.data).toHaveLength(1);
  });

  it("la lista de unidades trae la última lectura vigente de cada una (null si no tiene; la anulada no cuenta)", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    const fila = async () =>
      (await admin.get("/api/erp/equipos")).body.data.find((x: { id: number }) => x.id === id);
    expect((await fila()).ultima_lectura).toBeNull();

    await registrar(admin, id, { valor: 100, leido_en: haceHoras(5) });
    const segunda = await registrar(admin, id, { valor: 150, leido_en: haceHoras(2) });
    expect((await fila()).ultima_lectura).toMatchObject({ valor: 150, tipo: "horometro" });

    await admin
      .post(`/api/erp/equipos/${id}/lecturas/${segunda.body.id}/anular`)
      .send({ motivo: "Me equivoqué al digitar" });
    expect((await fila()).ultima_lectura).toMatchObject({ valor: 100 });
  });

  it("sin leido_en toma la hora del servidor, y una unidad inexistente da 404", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    const r = await registrar(admin, id, { valor: 10 });
    expect(r.status).toBe(201);
    expect(Math.abs(Date.now() - new Date(r.body.leido_en).getTime())).toBeLessThan(60_000);
    expect((await registrar(admin, 999999, { valor: 1 })).status).toBe(404);
    expect((await admin.get("/api/erp/equipos/999999/lecturas")).status).toBe(404);
  });

  it("no retrocede: menor que la anterior o mayor que una posterior da 400; igual se acepta", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    expect((await registrar(admin, id, { valor: 1000, leido_en: haceHoras(5) })).status).toBe(201);
    expect((await registrar(admin, id, { valor: 1100, leido_en: haceHoras(3) })).status).toBe(201);

    const menor = await registrar(admin, id, { valor: 1050, leido_en: haceHoras(1) });
    expect(menor.status).toBe(400);
    expect(menor.body.message).toMatch(/menor que el último registrado \(1100\)/);

    const mayorQuePosterior = await registrar(admin, id, { valor: 1200, leido_en: haceHoras(4) });
    expect(mayorQuePosterior.status).toBe(400);
    expect(mayorQuePosterior.body.message).toMatch(/mayor que una lectura posterior/);

    // Entre las dos, en medio y de la misma altura que la anterior: todo coherente.
    expect((await registrar(admin, id, { valor: 1100, leido_en: haceHoras(1) })).status).toBe(201);
    expect((await registrar(admin, id, { valor: 1050, leido_en: haceHoras(4) })).status).toBe(201);
    // Antes de todo: puede ser menor que todas las demás.
    expect((await registrar(admin, id, { valor: 900, leido_en: haceHoras(6) })).status).toBe(201);
  });

  it("valores y fechas imposibles dan 400, nunca 500", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    for (const cuerpo of [
      { valor: -1 },
      { valor: 1e12 },
      { valor: "mil" },
      {},
      { valor: 10, leido_en: new Date(Date.now() + 3_600_000).toISOString() },
      { valor: 10, leido_en: "ayer" },
      { valor: 10, cliente_uuid: "no-es-un-uuid" },
    ]) {
      const r = await registrar(admin, id, cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
    }
  });

  it("una unidad sin medidor configurado no admite lecturas (400 que dice qué hacer)", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin, null);
    const r = await registrar(admin, id, { valor: 10 });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/no tiene medidor configurado/);
  });

  it("el reintento con el mismo cliente_uuid no duplica; el mismo uuid con otro valor da 409", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    const cliente_uuid = randomUUID();
    const cuerpo = { valor: 500, leido_en: haceHoras(2), cliente_uuid };
    const primera = await registrar(admin, id, cuerpo);
    expect(primera.status).toBe(201);
    const reintento = await registrar(admin, id, cuerpo);
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);
    expect((await admin.get(`/api/erp/equipos/${id}/lecturas`)).body.data).toHaveLength(1);

    const reusado = await registrar(admin, id, { ...cuerpo, valor: 777 });
    expect(reusado.status).toBe(409);
    expect((await admin.get(`/api/erp/equipos/${id}/lecturas`)).body.data).toHaveLength(1);
  });

  it("anular exige motivo, la deja fuera de la última, no se anula dos veces y permite corregir", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    await registrar(admin, id, { valor: 100, leido_en: haceHoras(4) });
    const mala = await registrar(admin, id, { valor: 9000, leido_en: haceHoras(2) });
    const url = `/api/erp/equipos/${id}/lecturas/${mala.body.id}/anular`;

    expect((await admin.post(url).send({})).status).toBe(400);
    expect((await admin.post(url).send({ motivo: "  " })).status).toBe(400);

    const anulada = await admin.post(url).send({ motivo: "Se tipeó un cero de más" });
    expect(anulada.status).toBe(200);
    expect(anulada.body.anulada_en).toBeTruthy();
    expect(anulada.body.motivo_anulacion).toBe("Se tipeó un cero de más");
    expect(anulada.body.anulada_por_nombre).toBe("Admin de prueba");

    expect((await admin.post(url).send({ motivo: "otra vez" })).status).toBe(409);
    expect(
      (
        await admin
          .post(`/api/erp/equipos/${id}/lecturas/999999/anular`)
          .send({ motivo: "no existe" })
      ).status
    ).toBe(404);

    // La anulada ya no cuenta como "última" ni bloquea la corrección.
    expect((await admin.get(`/api/erp/equipos/${id}/lecturas/ultima`)).body.lectura.valor).toBe(
      100
    );
    expect((await registrar(admin, id, { valor: 900, leido_en: haceHoras(2) })).status).toBe(201);
    // El historial las conserva a las dos, con su motivo.
    const historial = (await admin.get(`/api/erp/equipos/${id}/lecturas`)).body.data;
    expect(historial).toHaveLength(3);
    expect(historial.filter((l: { anulada_en: string | null }) => l.anulada_en)).toHaveLength(1);
  });

  it("la base no deja editar una lectura ni reanular una anulada (trigger)", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    const l = await registrar(admin, id, { valor: 50, leido_en: haceHoras(1) });
    const tenantId = e.tenant.id;

    await expect(
      withTenant(tenantId, (c) =>
        c.query(`UPDATE equipo_lecturas SET valor = 1 WHERE id = $1`, [l.body.id])
      )
    ).rejects.toThrow(/no se reescriben/);

    await admin
      .post(`/api/erp/equipos/${id}/lecturas/${l.body.id}/anular`)
      .send({ motivo: "prueba del trigger" });
    await expect(
      withTenant(tenantId, (c) =>
        c.query(`UPDATE equipo_lecturas SET motivo_anulacion = 'otro' WHERE id = $1`, [l.body.id])
      )
    ).rejects.toThrow(/ya está anulada/);
  });

  it("registros a la vez con la misma hora no rompen el orden: el historial queda sin retrocesos", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    const leido_en = haceHoras(1);
    const valores = [500, 100, 300, 200, 400, 150];
    await Promise.all(valores.map((valor) => registrar(admin, id, { valor, leido_en })));
    const filas = (await admin.get(`/api/erp/equipos/${id}/lecturas`)).body.data as {
      id: number;
      valor: number;
      anulada_en: string | null;
    }[];
    // Las que entraron, ordenadas por id (el desempate de misma hora), no bajan nunca.
    const vigentes = filas.filter((f) => !f.anulada_en).sort((a, b) => a.id - b.id);
    expect(vigentes.length).toBeGreaterThan(0);
    for (let i = 1; i < vigentes.length; i++) {
      expect(vigentes[i].valor).toBeGreaterThanOrEqual(vigentes[i - 1].valor);
    }
  });

  it("la bitácora guarda quién registró, el valor y, al anular, el motivo", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    const l = await registrar(admin, id, { valor: 321, leido_en: haceHoras(1) });
    await admin
      .post(`/api/erp/equipos/${id}/lecturas/${l.body.id}/anular`)
      .send({ motivo: "Lectura de otra unidad" });

    const filas = await pool.query(
      `SELECT accion, usuario_id, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion LIKE 'equipos.lectura_%' ORDER BY creado_en`,
      [e.tenant.id]
    );
    expect(filas.rows.map((f) => f.accion)).toEqual([
      "equipos.lectura_registrar",
      "equipos.lectura_anular",
    ]);
    expect(filas.rows[0].usuario_id).toBe(e.usuario.id);
    expect(filas.rows[0].detalle).toMatchObject({ equipoId: id, lecturaId: l.body.id, valor: 321 });
    expect(filas.rows[1].detalle).toMatchObject({
      lecturaId: l.body.id,
      motivo: "Lectura de otra unidad",
    });

    // El reintento de un registro ya hecho no deja una segunda línea de bitácora.
    const cliente_uuid = randomUUID();
    await registrar(admin, id, { valor: 400, leido_en: haceHoras(0.5), cliente_uuid });
    await registrar(admin, id, { valor: 400, leido_en: haceHoras(0.5), cliente_uuid });
    const total = await pool.query(
      `SELECT count(*)::int AS n FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'equipos.lectura_registrar'`,
      [e.tenant.id]
    );
    expect(total.rows[0].n).toBe(2);
  });

  it("otra empresa no ve ni escribe las lecturas de esta unidad", async () => {
    const a = await nueva();
    const b = await nueva();
    const adminA = await sesion(a);
    const adminB = await sesion(b);
    const id = await unidad(adminA);
    const l = await registrar(adminA, id, { valor: 10, leido_en: haceHoras(1) });

    expect((await adminB.get(`/api/erp/equipos/${id}/lecturas`)).status).toBe(404);
    expect((await adminB.get(`/api/erp/equipos/${id}/lecturas/ultima`)).status).toBe(404);
    expect((await registrar(adminB, id, { valor: 20 })).status).toBe(404);
    expect(
      (
        await adminB
          .post(`/api/erp/equipos/${id}/lecturas/${l.body.id}/anular`)
          .send({ motivo: "intruso" })
      ).status
    ).toBe(404);
    expect((await adminA.get(`/api/erp/equipos/${id}/lecturas`)).body.data).toHaveLength(1);
  });

  it("el operador registra; Lectura puede consultar pero no registrar ni anular", async () => {
    const e = await nueva();
    const admin = await sesion(e);
    const id = await unidad(admin);
    const operador = await sesion(e, await usuario(admin, "operador"));
    const lectura = await sesion(e, await usuario(admin, "lectura"));

    const hecha = await registrar(operador, id, { valor: 70, leido_en: haceHoras(1) });
    expect(hecha.status).toBe(201);

    expect((await lectura.get(`/api/erp/equipos/${id}/lecturas`)).status).toBe(200);
    expect((await lectura.get(`/api/erp/equipos/${id}/lecturas/ultima`)).status).toBe(200);
    expect((await registrar(lectura, id, { valor: 80 })).status).toBe(403);
    expect(
      (
        await lectura
          .post(`/api/erp/equipos/${id}/lecturas/${hecha.body.id}/anular`)
          .send({ motivo: "x y z" })
      ).status
    ).toBe(403);
  });
});
