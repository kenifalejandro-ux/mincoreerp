/** tests/viajes-conductor-crea-su-viaje.test.ts
 *
 * El conductor crea e inicia su propio viaje desde el celular (migración 0179):
 *   POST /api/erp/viajes/crear-mio
 * Se ataca la API: interruptor de la empresa (403 apagado), reintento con el mismo identificador
 * (no duplica), un viaje ya asignado o en curso (409 con el existente), dos envíos a la vez, la
 * unidad nueva "por completar" con su ruta, la placa repetida, y la alerta de estado que se abre al
 * crear y se cierra sola al terminar el viaje.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

const password = "ClaveDePrueba123";

describe("viajes: el conductor crea su propio viaje (0179)", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let a: number;
  let b: number;
  let seq = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    a = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Orig") })).body.id
    );
    b = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Dest") })).body.id
    );
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const interruptor = (activo: boolean) =>
    pool.query(`UPDATE tenants SET conductor_crea_viaje = $2 WHERE id = $1`, [tenantId, activo]);

  async function conductor(): Promise<{ agente: Agente; dni: string }> {
    const agente = request.agent(app);
    const dni = String(86300000 + Math.floor(Math.random() * 90000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Conductor Prueba ${dni}`, dni, password, rol: "conductor_ruta" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return { agente, dni };
  }

  const placaNueva = () =>
    `Z${Math.floor(Math.random() * 90000 + 10000)}`.slice(0, 3) + `-${seq++ + 100}`;
  const cuerpoNuevo = (placa: string, extra: Record<string, unknown> = {}) => ({
    id_cliente: randomUUID(),
    unidad_nueva: { placa, nombre: "Conductor de Prueba" },
    paradas: [a, b],
    medidor_inicio: 1000,
    ...extra,
  });
  const crear = (ag: Agente, body: Record<string, unknown>) =>
    ag.post("/api/erp/viajes/crear-mio").send(body);

  const alertas = (viajeId: number) =>
    withTenant(tenantId, async (c) => {
      const r = await c.query(
        `SELECT resuelta_en FROM combustible_alertas
          WHERE tenant_id = $1 AND viaje_id = $2 AND tipo = 'viaje_creado_por_conductor'`,
        [tenantId, viajeId]
      );
      return r.rows;
    });
  const contar = (sql: string, params: unknown[]) =>
    withTenant(tenantId, async (c) =>
      Number((await c.query(sql, [tenantId, ...params])).rows[0].n)
    );

  it("con el interruptor apagado (por defecto) responde 403 y nada se crea", async () => {
    await interruptor(false);
    const c = await conductor();
    const cfg = await c.agente.get("/api/erp/viajes/mios/config");
    expect(cfg.body.puede_crear_viaje).toBe(false);
    const placa = placaNueva();
    const r = await crear(c.agente, cuerpoNuevo(placa));
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(
      await contar(`SELECT count(*) AS n FROM equipos WHERE tenant_id = $1 AND placa_codigo = $2`, [
        placa,
      ])
    ).toBe(0);
  });

  it("sin el odómetro de salida, o con unidad y unidad nueva a la vez, responde 400", async () => {
    await interruptor(true);
    const c = await conductor();
    const sin = cuerpoNuevo(placaNueva());
    delete (sin as Record<string, unknown>).medidor_inicio;
    expect((await crear(c.agente, sin)).status).toBe(400);
    const dos = cuerpoNuevo(placaNueva(), { equipo_id: 1 });
    expect((await crear(c.agente, dos)).status).toBe(400);
  });

  it("unidad nueva: viaje en curso, unidad por completar con su ruta y alerta abierta; terminar el viaje la cierra", async () => {
    await interruptor(true);
    const c = await conductor();
    const placa = placaNueva();
    const cuerpo = cuerpoNuevo(placa);
    const r = await crear(c.agente, cuerpo);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.estado).toBe("en_curso");
    expect(r.body.creado_por_conductor).toBe(true);
    expect(r.body.equipo_por_completar).toBe(true);
    const id = Number(r.body.id);

    const eq = await withTenant(tenantId, (cl) =>
      cl.query(
        `SELECT e.tipo, e.por_completar, e.conductor_dni,
                (SELECT count(*) FROM equipo_rutas r WHERE r.equipo_id = e.id AND r.hasta IS NULL
                    AND r.origen_id = $3 AND r.destino_id = $4) AS rutas
           FROM equipos e WHERE e.tenant_id = $1 AND e.placa_codigo = $2`,
        [tenantId, placa.toUpperCase(), a, b]
      )
    );
    expect(eq.rows[0]).toMatchObject({
      tipo: "Por completar",
      por_completar: true,
      conductor_dni: c.dni,
    });
    expect(Number(eq.rows[0].rutas)).toBe(1);

    const abierta = await alertas(id);
    expect(abierta).toHaveLength(1);
    expect(abierta[0].resuelta_en).toBeNull();

    // Una marca intermedia no la cierra: solo terminar el viaje.
    const fin = await c.agente.post(`/api/erp/viajes/${id}/cerrar-mio`).send({
      medidor_fin: 1100,
      cliente_uuid: randomUUID(),
    });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect((await alertas(id))[0].resuelta_en).not.toBeNull();
  });

  it("el mismo identificador devuelve el viaje ya creado, sin duplicar viaje, unidad ni alerta", async () => {
    await interruptor(true);
    const c = await conductor();
    const cuerpo = cuerpoNuevo(placaNueva());
    const primero = await crear(c.agente, cuerpo);
    expect(primero.status, JSON.stringify(primero.body)).toBe(201);
    const otra = await crear(c.agente, cuerpo);
    expect(otra.status, JSON.stringify(otra.body)).toBe(200);
    expect(otra.body.id).toBe(primero.body.id);
    expect(
      await contar(
        `SELECT count(*) AS n FROM combustible_viajes WHERE tenant_id = $1 AND conductor_dni = $2`,
        [c.dni]
      )
    ).toBe(1);
    expect(await alertas(Number(primero.body.id))).toHaveLength(1);
  });

  it("con un viaje en curso no se crea otro: 409 y devuelve el que tiene", async () => {
    await interruptor(true);
    const c = await conductor();
    const primero = await crear(c.agente, cuerpoNuevo(placaNueva()));
    expect(primero.status).toBe(201);
    const segundo = await crear(c.agente, cuerpoNuevo(placaNueva()));
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(409);
    expect(segundo.body.details.viaje.id).toBe(primero.body.id);
  });

  it("con un viaje ya programado por la oficina tampoco: 409", async () => {
    await interruptor(true);
    const c = await conductor();
    const u = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("PR"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Titular",
      conductor_dni: c.dni,
    });
    const prog = await admin
      .post("/api/erp/viajes")
      .send({ equipo_id: Number(u.body.id), origen_id: a, destino_id: b });
    expect(prog.status, JSON.stringify(prog.body)).toBe(201);
    const r = await crear(c.agente, cuerpoNuevo(placaNueva()));
    expect(r.status).toBe(409);
    expect(r.body.details.viaje.id).toBe(prog.body.id);
  });

  it("dos envíos a la vez del mismo conductor dejan un solo viaje", async () => {
    await interruptor(true);
    const c = await conductor();
    const rs = await Promise.all([
      crear(c.agente, cuerpoNuevo(placaNueva())),
      crear(c.agente, cuerpoNuevo(placaNueva())),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await contar(
        `SELECT count(*) AS n FROM combustible_viajes WHERE tenant_id = $1 AND conductor_dni = $2`,
        [c.dni]
      )
    ).toBe(1);
  });

  it("placa repetida (aunque cambie guion o mayúsculas): usa la unidad que ya existe, no crea otra", async () => {
    await interruptor(true);
    const c1 = await conductor();
    const c2 = await conductor();
    const placa = placaNueva();
    const p1 = await crear(c1.agente, cuerpoNuevo(placa));
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    // El primero termina; el segundo escribe la misma placa distinta.
    await c1.agente
      .post(`/api/erp/viajes/${p1.body.id}/cerrar-mio`)
      .send({ medidor_fin: 1100, cliente_uuid: randomUUID() });
    const p2 = await crear(
      c2.agente,
      cuerpoNuevo(placa.toLowerCase().replace("-", " "), { medidor_inicio: 1100 })
    );
    expect(p2.status, JSON.stringify(p2.body)).toBe(201);
    expect(p2.body.equipo_id).toBe(p1.body.equipo_id);
    expect(
      await contar(
        `SELECT count(*) AS n FROM equipos
          WHERE tenant_id = $1 AND regexp_replace(upper(placa_codigo), '[^A-Z0-9]', '', 'g') = $2`,
        [placa.replace("-", "").toUpperCase()]
      )
    ).toBe(1);
  });

  it("con una unidad registrada, el conductor asignado en Equipos no cambia", async () => {
    await interruptor(true);
    const c = await conductor();
    const u = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("RG"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Otro Titular",
      conductor_dni: String(40900000 + seq++),
    });
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    const r = await crear(c.agente, {
      id_cliente: randomUUID(),
      equipo_id: Number(u.body.id),
      paradas: [a, b, a],
      medidor_inicio: 500,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.conductor_dni).toBe(c.dni);
    const eq = await withTenant(tenantId, (cl) =>
      cl.query(
        `SELECT conductor_dni, por_completar FROM equipos WHERE tenant_id = $1 AND id = $2`,
        [tenantId, Number(u.body.id)]
      )
    );
    expect(eq.rows[0].conductor_dni).toBe(u.body.conductor_dni);
    expect(eq.rows[0].por_completar).toBe(false);
  });
});
