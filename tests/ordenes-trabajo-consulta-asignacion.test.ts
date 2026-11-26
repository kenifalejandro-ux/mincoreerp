/** tests/ordenes-trabajo-consulta-asignacion.test.ts
 *
 * Lo que la oficina consulta de las órdenes y la asignación de mecánico (M8): filtros, cifras, mecánicos con
 * su carga y PATCH /:id/asignado, que cambia solo eso. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const PASSWORD = "ClaveDePrueba123";
const RUTA = "/api/erp/ordenes_trabajo";

describe("Órdenes de Trabajo: consulta y asignación", () => {
  let tenantId: string;
  let slug: string;
  let correo: string;
  const otras: string[] = [];
  const admin = request.agent(app);
  let mecanico: string;
  let operador: string;
  let orden: number;

  const usuario = async (nombre: string, rol: string) => {
    const r = await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ nombre, email: `${idUnico("m8")}@test.local`, password: PASSWORD, rol });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.usuario.id as string;
  };
  const asignar = (id: number, asignado_a: string | null) =>
    admin.patch(`${RUTA}/${id}/asignado`).send({ asignado_a });
  const ids = async (query: string) => {
    const r = await admin.get(`${RUTA}?${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.data as { id: number }[]).map((o) => o.id);
  };

  beforeAll(async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    tenantId = e.tenant.id;
    slug = e.tenant.slug;
    correo = e.usuario.email;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    mecanico = await usuario("Mecánico Uno", "mecanico");
    operador = await usuario("Operador Uno", "operador");
    const r = await admin.post(RUTA).send({
      activo_texto: "Horno 4",
      titulo: "Cambiar faja 100%",
      descripcion: "No se debe borrar",
      prioridad: "urgente",
      fecha_programada: "2026-01-15",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    orden = r.body.id;
  });

  afterAll(async () => {
    for (const id of [tenantId, ...otras]) await borrarTenantDePrueba(id);
    await closeDatabase();
  });

  it("asigna y quita sin borrar el resto de la orden", async () => {
    const r = await asignar(orden, mecanico);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.asignado_a_nombre).toBe("Mecánico Uno");
    expect((await asignar(orden, mecanico)).status).toBe(200);

    const leida = await admin.get(`${RUTA}/${orden}`);
    expect(leida.body.descripcion).toBe("No se debe borrar");
    expect(leida.body.prioridad).toBe("urgente");
    expect(leida.body.fecha_programada).toBeTruthy();
    expect(leida.body.asignado_a).toBe(mecanico);
  });

  it("los mecánicos salen con su carga; otros perfiles no salen ni se asignan", async () => {
    const r = await admin.get(`${RUTA}/mecanicos`);
    expect(r.body).toEqual([
      {
        id: mecanico,
        nombre: "Mecánico Uno",
        ordenes: [{ id: orden, titulo: "Cambiar faja 100%" }],
      },
    ]);
    expect((await asignar(orden, operador)).status).toBe(400);
  });

  it("filtra y cuenta", async () => {
    const otra = (await admin.post(RUTA).send({ activo_texto: "Molino", titulo: "Engrase" })).body
      .id;
    expect(await ids("q=faja")).toEqual([orden]);
    expect(await ids(`q=${encodeURIComponent(`#${otra}`)}`)).toEqual([otra]);
    expect(await ids("q=mec%C3%A1nico")).toEqual([orden]);
    expect(await ids(`q=${encodeURIComponent("100%")}`)).toEqual([orden]);
    expect(await ids("q=_")).toEqual([]);
    expect(await ids("sin_asignar=true")).toEqual([otra]);
    expect(await ids("prioridad=urgente&tipo=correctivo&estado=abierta")).toEqual([orden]);
    expect(await ids("estado=&q=")).toEqual([otra, orden]);
    expect((await admin.get(`${RUTA}?estado=inventado`)).status).toBe(400);
    expect((await admin.get(`${RUTA}?asignado_a=x`)).status).toBe(400);

    const resumen = await admin.get(`${RUTA}/resumen`);
    expect(resumen.body).toEqual({
      abiertas: 2,
      en_progreso: 0,
      urgentes: 1,
      sin_asignar: 1,
      completadas_del_mes: 0,
    });
  });

  it("quita el mecánico; sin el campo no hace nada; una orden cerrada no se toca", async () => {
    expect((await admin.patch(`${RUTA}/${orden}/asignado`).send({})).status).toBe(400);
    expect((await asignar(orden, null)).body.asignado_a).toBeNull();
    expect((await asignar(999999999, mecanico)).status).toBe(404);
    await admin.patch(`${RUTA}/${orden}/estado`).send({ estado: "cancelada" });
    expect((await asignar(orden, mecanico)).status).toBe(409);
  });

  // ── Ataques (rol QA) ──────────────────────────────────────────────────
  const entrar = async (tenantSlug: string, email: string) => {
    const ag = request.agent(app);
    const r = await ag.post("/api/auth/login").send({ tenantSlug, email, password: PASSWORD });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ag;
  };
  /** Deja a la empresa principal con exactamente esos módulos y entra de nuevo. */
  const conModulos = async (modulos: string[]) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${tenantId}/modulos`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: modulos.includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
    return entrar(slug, correo);
  };
  const nuevaOrden = async (extra: Record<string, unknown> = {}) => {
    const r = await admin
      .post(RUTA)
      .send({ activo_texto: "Chancadora", titulo: "Ataque", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };

  it("otra empresa: no ve, no cuenta ni asigna lo ajeno", async () => {
    const mia = await nuevaOrden();
    const e = await crearTenantDePrueba(PASSWORD);
    otras.push(e.tenant.id);
    const ajeno = await entrar(e.tenant.slug, e.usuario.email);
    const r = await ajeno.patch(`${RUTA}/${mia}/asignado`).send({ asignado_a: null });
    expect(r.status).toBe(404);
    expect((await ajeno.get(`${RUTA}/mecanicos`)).body).toEqual([]);
    expect((await ajeno.get(`${RUTA}?asignado_a=${mecanico}`)).body.data).toEqual([]);
    expect((await ajeno.get(`${RUTA}/resumen`)).body.abiertas).toBe(0);
    const suya = (await ajeno.post(RUTA).send({ activo_texto: "X", titulo: "Suya" })).body.id;
    const cruzada = await ajeno.patch(`${RUTA}/${suya}/asignado`).send({ asignado_a: mecanico });
    expect(cruzada.status).toBe(400);
  });

  it("Lectura mira pero no asigna ni lista mecánicos; sin sesión, 401", async () => {
    const id = await nuevaOrden();
    await usuario("Solo Mira", "lectura");
    const fila = await withTenant(tenantId, (c) =>
      c.query<{ email: string }>(
        "SELECT email FROM usuarios WHERE tenant_id = $1 AND nombre = 'Solo Mira'",
        [tenantId]
      )
    );
    const lectura = await entrar(slug, fila.rows[0].email);
    expect((await lectura.get(RUTA)).status).toBe(200);
    expect((await lectura.get(`${RUTA}/resumen`)).status).toBe(200);
    expect((await lectura.get(`${RUTA}/mecanicos`)).status).toBe(403);
    const r = await lectura.patch(`${RUTA}/${id}/asignado`).send({ asignado_a: mecanico });
    expect(r.status).toBe(403);
    expect((await request(app).get(`${RUTA}/resumen`)).status).toBe(401);
  });

  it("entradas absurdas dan 400 o 404, nunca 500", async () => {
    const id = await nuevaOrden();
    for (const q of [
      `q=${"a".repeat(81)}`,
      "q=a&q=b",
      "estado=abierta&estado=cancelada",
      "area_id=99999999999",
      "area_id=-1",
      "area_id=abc",
      "sin_asignar=1",
    ]) {
      expect((await admin.get(`${RUTA}?${q}`)).status, q).toBe(400);
    }
    for (const q of ["q=%27%3B--", "q=%5C", "equipo_id=abc"]) {
      expect((await admin.get(`${RUTA}?${q}`)).status, q).toBe(200);
    }
    for (const cuerpo of [{ asignado_a: "" }, { asignado_a: 5 }, { asignado_a: "x" }]) {
      expect((await admin.patch(`${RUTA}/${id}/asignado`).send(cuerpo)).status).toBe(400);
    }
    expect(
      (await admin.patch(`${RUTA}/9999999999/asignado`).send({ asignado_a: null })).status
    ).toBe(404);
  });

  const auditorias = async (id: number) => {
    const r = await withTenant(tenantId, (c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'ordenes_trabajo.asignar'
            AND detalle->>'ordenTrabajoId' = $2`,
        [tenantId, String(id)]
      )
    );
    return r.rows[0].n;
  };

  it("seis envíos iguales a la vez y en mayúsculas: un solo cambio auditado", async () => {
    const id = await nuevaOrden();
    const envios = await Promise.all(Array.from({ length: 6 }, () => asignar(id, mecanico)));
    expect(envios.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect((await asignar(id, mecanico.toUpperCase())).status).toBe(200);
    expect(await auditorias(id)).toBe(1);
  });

  it("asignar y cerrar a la vez: nunca 500 y una orden cerrada ya no cambia", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await nuevaOrden();
      const [a, c] = await Promise.all([
        asignar(id, mecanico),
        admin.patch(`${RUTA}/${id}/estado`).send({ estado: "cancelada" }),
      ]);
      expect([200, 409]).toContain(a.status);
      expect(c.status).toBe(200);
      const leida = await admin.get(`${RUTA}/${id}`);
      expect(leida.body.asignado_a).toBe(a.status === 200 ? mecanico : null);
    }
  });

  it("un mecánico dado de baja no sale ni se asigna", async () => {
    const id = await nuevaOrden();
    const baja = await usuario("Mecánico Baja", "mecanico");
    const r = await request(app)
      .patch(`/api/platform/tenants/${tenantId}/usuarios/${baja}/estado`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ activo: false });
    expect(r.status).toBe(200);
    const lista = (await admin.get(`${RUTA}/mecanicos`)).body as { id: string }[];
    expect(lista.map((m) => m.id)).not.toContain(baja);
    expect((await asignar(id, baja)).status).toBe(400);
  });

  it("área e IPERC solo con su módulo; sin ellos la columna va vacía y el filtro se ignora", async () => {
    let ag = await conModulos(["ordenes_trabajo", "mantenimiento", "iperc"]);
    const area = await ag.post("/api/erp/mantenimiento/areas").send({ nombre: "Cantera" });
    expect(area.status, JSON.stringify(area.body)).toBe(201);
    const placa = idUnico("U").slice(-12).toUpperCase();
    const u = await ag
      .post("/api/erp/mantenimiento/equipos")
      .send({ placa_codigo: placa, tipo: "Volquete", area_id: area.body.id });
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    const o = await ag.post(RUTA).send({ equipo_id: Number(u.body.id), titulo: "Con área" });
    expect(o.status, JSON.stringify(o.body)).toBe(201);

    const conTodo = await ag.get(`${RUTA}?area_id=${area.body.id}`);
    expect(conTodo.body.data).toHaveLength(1);
    expect(conTodo.body.data[0]).toMatchObject({
      id: o.body.id,
      placa_codigo: placa,
      equipo_tipo: "Volquete",
      area: "Cantera",
      iperc_estado: null,
    });
    ag = await conModulos(["ordenes_trabajo"]);
    const solo = await ag.get(`${RUTA}?area_id=${area.body.id}&q=${placa}&pageSize=100`);
    expect(solo.status).toBe(200);
    // Sin unidades la placa no se lee, así que tampoco se busca por ella.
    expect(solo.body.data).toEqual([]);
    const todas = await ag.get(`${RUTA}?area_id=${area.body.id}&pageSize=100`);
    const fila = (todas.body.data as { id: number }[]).find((f) => f.id === o.body.id);
    expect(fila).toMatchObject({ placa_codigo: null, equipo_tipo: null, area: null });
    expect(todas.body.data.length).toBeGreaterThan(1);
    expect((await ag.get(`${RUTA}/resumen`)).status).toBe(200);
    expect((await ag.get(`${RUTA}/mecanicos`)).status).toBe(200);

    ag = await conModulos(["mantenimiento"]);
    expect((await ag.get(`${RUTA}/resumen`)).status).toBe(403);
  });
});
