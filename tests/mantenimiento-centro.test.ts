/** tests/mantenimiento-centro.test.ts
 *
 * M6: lo que el Centro de control calcula (`GET /resumen`).
 *
 * 1. Autonomía: cada bloque sale solo si la persona tiene su módulo; sin él va en null.
 * 2. Estados por área, órdenes (abiertas, sin mecánico, del mes) y checklists de hoy.
 * 3. «Hoy» y «este mes» son los de Perú, no los de UTC.
 * 4. Lo quitado no cuenta, nada se cruza entre empresas y responde rápido con muchos registros.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const PASSWORD = "ClaveDePrueba123";
const CK = "/api/erp/checklists";
const OT = "/api/erp/ordenes_trabajo";
const MANT = "/api/erp/mantenimiento";
const TODO = ["mantenimiento", "checklists", "ordenes_trabajo"];

describe("Mantenimiento: Centro de control (M6)", () => {
  const empresas: Awaited<ReturnType<typeof crearTenantDePrueba>>[] = [];

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  const empresaCon = async (modulos: string[]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    const habilitar = async (lista: string[]) => {
      const r = await request(app)
        .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
        .set("Authorization", `Bearer ${env.platformAdminToken}`)
        .send({
          configuraciones: MODULOS.map((m) => ({
            modulo: m.id,
            estado: lista.includes(m.id) ? "habilitado" : "deshabilitado",
          })),
        });
      expect(r.status).toBe(200);
      const ag = request.agent(app);
      const login = await ag
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
      expect(login.status).toBe(200);
      return ag;
    };
    const sql = (texto: string, params: unknown[] = []) =>
      withTenant(e.tenant.id, (c) => c.query(texto, [e.tenant.id, ...params]));
    return { ag: await habilitar(modulos), habilitar, sql, empresa: e };
  };
  type Empresa = Awaited<ReturnType<typeof empresaCon>>;
  type Agente = Empresa["ag"];

  const centro = async (ag: Agente) => {
    const r = await ag.get(`${MANT}/resumen`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const unidad = async (ag: Agente, extra: Record<string, unknown> = {}) => {
    const placa = idUnico("U").slice(-12).toUpperCase();
    const r = await ag
      .post(`${MANT}/equipos`)
      .send({ placa_codigo: placa, tipo: "Volquete", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: Number(r.body.id), placa };
  };
  const orden = async (ag: Agente, datos: Record<string, unknown>) => {
    const r = await ag.post(OT).send({ titulo: "Revisar faja", ...datos });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const formato = async (ag: Agente, extra: Record<string, unknown> = {}) => {
    const r = await ag.post(`${CK}/plantillas`).send({
      nombre: idUnico("Pre-uso"),
      items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const llenar = async (
    ag: Agente,
    plantilla_id: number,
    unidadDe: Record<string, unknown>,
    malas: string[] = []
  ) => {
    const r = await ag.post(CK).send({
      plantilla_id,
      ...unidadDe,
      items: ["Frenos", "Luces"].map((descripcion) => ({
        descripcion,
        estado: malas.includes(descripcion) ? "malo" : "bien",
      })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };

  it("solo con Mantenimiento: estados por área, sin órdenes ni checklists (null, no cero)", async () => {
    const e = await empresaCon(TODO);
    const area = await e.ag.post(`${MANT}/areas`).send({ nombre: "Cantera" });
    expect(area.status).toBe(201);
    const a = await unidad(e.ag, { area_id: area.body.id, propiedad: "alquilada" });
    const b = await unidad(e.ag);
    const quitada = await unidad(e.ag);
    await orden(e.ag, { equipo_id: a.id, prioridad: "urgente" });
    await orden(e.ag, { equipo_id: quitada.id, prioridad: "urgente" });
    const baja = await e.ag.patch(`${MANT}/equipos/${quitada.id}/quitar`).send({ motivo: "Baja" });
    expect(baja.status).toBe(200);
    expect((await e.ag.put(`${MANT}/config`).send({ meta_disponibilidad: 75 })).status).toBe(200);

    const solo = await e.habilitar(["mantenimiento"]);
    const r = await centro(solo);
    expect(r).toMatchObject({ total: 2, meta_disponibilidad: 75, ordenes: null, checklists: null });
    // Sin Órdenes de trabajo la urgente no detiene; la unidad quitada no cuenta.
    expect(r.estados).toEqual({ operativas: 2, en_mantenimiento: 0, detenidas: 0 });
    expect(r.estado_por_area).toEqual([
      {
        area_id: area.body.id,
        nombre: "Cantera",
        unidades: [{ id: a.id, placa: a.placa, estado: "operativa", alquilada: true }],
      },
      {
        area_id: null,
        nombre: null,
        unidades: [{ id: b.id, placa: b.placa, estado: "operativa", alquilada: false }],
      },
    ]);
  });

  it("sin Checklists salen las órdenes; sin Órdenes de trabajo, los checklists", async () => {
    const e = await empresaCon(TODO);
    const { id } = await unidad(e.ag);
    await llenar(e.ag, await formato(e.ag), { equipo_id: id }, ["Frenos"]);

    const ordenes = await centro(await e.habilitar(["mantenimiento", "ordenes_trabajo"]));
    expect(ordenes.checklists).toBeNull();
    expect(ordenes.ordenes.abiertas).toBe(1);
    expect(ordenes.estados.detenidas).toBe(1);

    const checks = await centro(await e.habilitar(["mantenimiento", "checklists"]));
    expect(checks.ordenes).toBeNull();
    expect(checks.checklists.no_aptos_hoy.total).toBe(1);
    expect(checks.estados.detenidas).toBe(1);
  });

  it("órdenes: abiertas, urgentes, sin mecánico (urgentes primero) y las del mes sin canceladas", async () => {
    const e = await empresaCon(TODO);
    const u = await unidad(e.ag);
    const urgente = await orden(e.ag, { equipo_id: u.id, prioridad: "urgente", titulo: "Frenos" });
    const manual = await orden(e.ag, { activo_texto: "Compresora", tipo: "preventivo" });
    const asignada = await orden(e.ag, { equipo_id: u.id, asignado_a: e.empresa.usuario.id });
    const cancelada = await orden(e.ag, { equipo_id: u.id, prioridad: "urgente" });
    const hecha = await orden(e.ag, { equipo_id: u.id });
    for (const [id, estado] of [
      [asignada, "en_progreso"],
      [cancelada, "cancelada"],
      [hecha, "en_progreso"],
      [hecha, "completada"],
    ] as const) {
      expect((await e.ag.patch(`${OT}/${id}/estado`).send({ estado })).status).toBe(200);
    }

    expect((await centro(e.ag)).ordenes).toEqual({
      abiertas: 3,
      urgentes: 1,
      sin_mecanico: {
        total: 2,
        urgentes: 1,
        casos: [
          { id: urgente, unidad: u.placa, titulo: "Frenos", urgente: true },
          { id: manual, unidad: "Compresora", titulo: "Revisar faja", urgente: false },
        ],
      },
      del_mes: { correctivo: 3, preventivo: 1 },
    });
  });

  it("el mes empieza a la medianoche de Perú", async () => {
    const e = await empresaCon(TODO);
    const { id } = await unidad(e.ag);
    const dentro = await orden(e.ag, { equipo_id: id });
    const fuera = await orden(e.ag, { equipo_id: id });
    const mover = (ot: number, desfase: string) =>
      e.sql(
        `UPDATE ordenes_trabajo
            SET creado_en = date_trunc('month', now(), 'America/Lima') + $3::interval
          WHERE tenant_id = $1 AND id = $2`,
        [ot, desfase]
      );
    await mover(dentro, "0 seconds");
    await mover(fuera, "-1 second");
    const r = (await centro(e.ag)).ordenes;
    expect(r.del_mes).toEqual({ correctivo: 1, preventivo: 0 });
    // La del mes pasado sigue abierta.
    expect(r.abiertas).toBe(2);
  });

  it("hoy es el de Perú: lo de anoche a las 20:00 no cuenta, y lo pendiente de antes sí", async () => {
    const e = await empresaCon(TODO);
    const { id } = await unidad(e.ag);
    const c = await llenar(e.ag, await formato(e.ag), { equipo_id: id }, ["Frenos"]);
    const mover = (desfase: string) =>
      e.sql(
        `UPDATE checklists SET creado_en = date_trunc('day', now(), 'America/Lima') + $3::interval
          WHERE tenant_id = $1 AND id = $2`,
        [c, desfase]
      );
    // Los hijos apuntan a (id, creado_en): se sueltan para poder mover la fecha.
    await e.sql("DELETE FROM checklist_items WHERE tenant_id = $1 AND checklist_id = $2", [c]);

    await mover("0 seconds");
    let r = (await centro(e.ag)).checklists;
    expect(r.hechos_hoy).toBe(1);
    expect(r.no_aptos_hoy.total).toBe(1);

    await mover("-4 hours"); // 20:00 de ayer en Perú, 01:00 de hoy en UTC
    await e.sql("UPDATE checklists SET salida = 'por_autorizar' WHERE tenant_id = $1 AND id = $2", [
      c,
    ]);
    r = (await centro(e.ag)).checklists;
    expect(r.hechos_hoy).toBe(0);
    expect(r.no_aptos_hoy.total).toBe(0);
    expect(r.sin_checklist_hoy.total).toBe(1);
    expect(r.por_autorizar.total).toBe(1);
  });

  it("checklists: falta solo a quien le toca un formato activo; las fallas de cada aviso", async () => {
    const e = await empresaCon(TODO);
    const volquete = await unidad(e.ag, { tipo: "Volquete" });
    const otro = await unidad(e.ag, { tipo: "Volquete" });
    const pala = await unidad(e.ag, { tipo: "Excavadora" });
    // Sin ningún formato no le falta a nadie.
    expect((await centro(e.ag)).checklists.sin_checklist_hoy).toEqual({ total: 0, casos: [] });

    const suyo = await formato(e.ag, { tipo_equipo: "VOLQUETE" });
    let r = (await centro(e.ag)).checklists;
    expect(r.sin_checklist_hoy.casos.sort()).toEqual([volquete.placa, otro.placa].sort());

    // Dos checklists de la misma unidad cuentan como una unidad hecha.
    const noApto = await llenar(e.ag, suyo, { equipo_id: volquete.id }, ["Frenos", "Luces"]);
    const observado = await llenar(e.ag, suyo, { equipo_id: volquete.id }, ["Luces"]);
    const escrito = await llenar(e.ag, suyo, { activo_texto: "Grupo electrógeno" }, ["Frenos"]);
    r = (await centro(e.ag)).checklists;
    expect(r.hechos_hoy).toBe(1);
    expect(r.sin_checklist_hoy).toEqual({ total: 1, casos: [otro.placa] });
    expect(r.no_aptos_hoy).toEqual({
      total: 2,
      casos: [
        { id: escrito, unidad: "Grupo electrógeno", fallas: "Frenos" },
        { id: noApto, unidad: volquete.placa, fallas: "Frenos" },
      ],
    });
    expect(r.por_autorizar).toEqual({
      total: 1,
      casos: [{ id: observado, unidad: volquete.placa, fallas: "Luces" }],
    });

    // Un formato general le toca a todas; desactivado, deja de tocar.
    const general = await formato(e.ag);
    r = (await centro(e.ag)).checklists;
    expect(r.sin_checklist_hoy.casos.sort()).toEqual([otro.placa, pala.placa].sort());
    for (const f of [general, suyo]) {
      const off = await e.ag.patch(`${CK}/plantillas/${f}/estado`).send({ activa: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
    }
    expect((await centro(e.ag)).checklists.sin_checklist_hoy.total).toBe(0);
  });

  it("manda lo que tiene la PERSONA, no la empresa; Lectura ve el Centro", async () => {
    const e = await empresaCon(TODO);
    const { id } = await unidad(e.ag);
    await orden(e.ag, { equipo_id: id, prioridad: "urgente" });
    await llenar(e.ag, await formato(e.ag), { equipo_id: id }, ["Luces"]);
    /** Crea una persona, le deja solo `modulos` y devuelve su sesión. */
    const persona = async (rol: string, modulos: string[]) => {
      const dni = dniUnico();
      const alta = await e.ag
        .post("/api/erp/usuarios")
        .send({ nombre: `P ${rol}`, dni, password: PASSWORD, rol });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
      const suya = (await e.sql("SELECT id FROM usuarios WHERE tenant_id = $1 AND dni = $2", [dni]))
        .rows[0] as { id: string };
      const permisos = await e.ag.put(`/api/erp/usuarios/${suya.id}/permisos`).send({
        modulos: TODO.map((modulo) => ({
          modulo,
          asignado: modulos.includes(modulo),
          nivel: "operar",
        })),
      });
      expect(permisos.status, JSON.stringify(permisos.body)).toBe(200);
      const ag = request.agent(app);
      const login = await ag
        .post("/api/auth/login")
        .send({ tenantSlug: e.empresa.tenant.slug, identificador: dni, password: PASSWORD });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      return ag;
    };

    const soloLoSuyo = await centro(await persona("operador", ["mantenimiento"]));
    expect(soloLoSuyo).toMatchObject({ ordenes: null, checklists: null });
    // Sin esos módulos, lo que hay en ellos tampoco se deja ver por el estado.
    expect(soloLoSuyo.estados.detenidas).toBe(0);
    const lectura = await centro(await persona("lectura", TODO));
    expect(lectura.ordenes.abiertas).toBe(1);
    expect(lectura.checklists.por_autorizar.total).toBe(1);
    const sinCentro = await persona("operador", ["checklists"]);
    expect((await sinCentro.get(`${MANT}/resumen`)).status).toBe(403);
    expect((await request(app).get(`${MANT}/resumen`)).status).toBe(401);
  });

  it("con 1,000 unidades el Centro sigue respondiendo rápido", async () => {
    const e = await empresaCon(TODO);
    await e.sql(
      `INSERT INTO equipos (tenant_id, placa_codigo, tipo)
       SELECT $1::uuid, 'M-' || n, 'Volquete' FROM generate_series(1, 1000) n`
    );
    await formato(e.ag);
    const inicio = Date.now();
    const r = await centro(e.ag);
    expect(Date.now() - inicio).toBeLessThan(2000);
    expect(r.checklists.sin_checklist_hoy.total).toBe(1000);
    expect(r.estado_por_area[0].unidades).toHaveLength(1000);
  });

  it("no se cruza entre empresas", async () => {
    const a = await empresaCon(TODO);
    const b = await empresaCon(TODO);
    const { id } = await unidad(a.ag);
    await orden(a.ag, { equipo_id: id, prioridad: "urgente" });
    await llenar(a.ag, await formato(a.ag), { equipo_id: id }, ["Luces"]);
    const r = await centro(b.ag);
    expect(r.total).toBe(0);
    expect(r.estado_por_area).toEqual([]);
    expect(r.ordenes.abiertas).toBe(0);
    expect(r.checklists.por_autorizar.total).toBe(0);
    expect(r.checklists.hechos_hoy).toBe(0);
  });

  it("con 40,000 checklists cada aviso nombra 5, cuenta todos y responde rápido", async () => {
    const e = await empresaCon(TODO);
    const { id } = await unidad(e.ag);
    await llenar(e.ag, await formato(e.ag), { equipo_id: id }, ["Luces"]);
    await e.sql(
      `INSERT INTO checklists (tenant_id, equipo_id, plantilla_id, usuario_id, salida, resultado)
       SELECT k.tenant_id, k.equipo_id, k.plantilla_id, k.usuario_id, 'por_autorizar', 'no_apta'
         FROM checklists k, generate_series(1, 40000) WHERE k.tenant_id = $1`
    );
    const inicio = Date.now();
    const r = (await centro(e.ag)).checklists;
    const ms = Date.now() - inicio;
    console.info(`centro con 40k checklists: ${ms} ms`);
    expect(r.por_autorizar.total).toBe(40001);
    expect(r.por_autorizar.casos).toHaveLength(5);
    expect(r.no_aptos_hoy.total).toBe(40000);
    expect(r.no_aptos_hoy.casos).toHaveLength(5);
    expect(ms).toBeLessThan(2000);
  });
});
