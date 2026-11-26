/** tests/mantenimiento-actividad.test.ts
 *
 * M6: «Actividad del turno» (`GET /actividad`).
 *
 * 1. Los movimientos de checklists y órdenes, lo último arriba, con su efecto.
 * 2. Autonomía: cada fuente sale solo con su módulo.
 * 3. Solo 7 días y 8 movimientos; nada del futuro ni de otra empresa.
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

describe("Mantenimiento: Actividad del turno (M6)", () => {
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

  type Movimiento = Record<string, unknown> & { tipo: string; en: string };
  const actividad = async (ag: Agente): Promise<Movimiento[]> => {
    const r = await ag.get(`${MANT}/actividad`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.movimientos;
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

  const estado = async (ag: Agente, id: number, a: string) => {
    const r = await ag.patch(`${OT}/${id}/estado`).send({ estado: a });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  it("una falla crítica: el checklist y su orden, con el efecto; al cerrar, la unidad vuelve", async () => {
    const e = await empresaCon(TODO);
    const u = await unidad(e.ag);
    const f = await formato(e.ag);
    const ck = await llenar(e.ag, f, { equipo_id: u.id }, ["Frenos"]);
    const [orden, checklist] = await actividad(e.ag);
    expect(checklist).toMatchObject({
      tipo: "checklist",
      checklist_id: ck,
      unidad: u.placa,
      resultado: "no_apta",
      fallas: "Frenos",
      por_autorizar: false,
      orden: { nueva: true },
    });
    const ot = (checklist.orden as { id: number }).id;
    expect(orden).toMatchObject({
      tipo: "orden_creada",
      orden_id: ot,
      detiene: true,
      sin_mecanico: true,
      desde_checklist: true,
      unidad_hoy: "detenida",
    });

    // La misma falla otra vez no crea orden: queda anotada en la abierta.
    await llenar(e.ag, f, { equipo_id: u.id }, ["Frenos"]);
    expect((await actividad(e.ag))[0]).toMatchObject({ orden: { id: ot, nueva: false } });

    await estado(e.ag, ot, "en_progreso");
    await estado(e.ag, ot, "completada");
    const [cerrada, iniciada] = await actividad(e.ag);
    expect(cerrada).toMatchObject({
      tipo: "orden_cerrada",
      estado: "completada",
      unidad_hoy: "operativa",
    });
    expect(iniciada).toMatchObject({ tipo: "orden_iniciada", orden_id: ot });
  });

  it("falla menor: espera autorización y la decisión es otro movimiento", async () => {
    const e = await empresaCon(TODO);
    const u = await unidad(e.ag);
    const ck = await llenar(e.ag, await formato(e.ag), { equipo_id: u.id }, ["Luces"]);
    expect(await actividad(e.ag)).toMatchObject([
      { tipo: "checklist", resultado: "observado", por_autorizar: true, orden: null },
    ]);
    await e.sql(
      `UPDATE checklists SET salida = 'rechazada', salida_en = now()
        WHERE tenant_id = $1 AND id = $2`,
      [ck]
    );
    expect(await actividad(e.ag)).toMatchObject([
      { tipo: "salida", checklist_id: ck, autorizada: false, fallas: "Luces", unidad: u.placa },
      { tipo: "checklist", por_autorizar: false },
    ]);
  });

  it("cada fuente sale solo con su módulo", async () => {
    const e = await empresaCon(TODO);
    const u = await unidad(e.ag);
    await llenar(e.ag, await formato(e.ag), { equipo_id: u.id }, ["Frenos"]);
    const soloCk = await actividad(await e.habilitar(["mantenimiento", "checklists"]));
    expect(soloCk).toMatchObject([{ tipo: "checklist", orden: null }]);
    const soloOt = await actividad(await e.habilitar(["mantenimiento", "ordenes_trabajo"]));
    expect(soloOt.map((m) => m.tipo)).toEqual(["orden_creada"]);
    expect(await actividad(await e.habilitar(["mantenimiento"]))).toEqual([]);
  });

  it("manda lo que tiene la persona: Lectura ve, y sin el módulo no entra", async () => {
    const e = await empresaCon(TODO);
    const u = await unidad(e.ag);
    await llenar(e.ag, await formato(e.ag), { equipo_id: u.id }, ["Frenos"]);
    const persona = async (rol: string, modulos: string[]) => {
      const dni = dniUnico();
      const alta = await e.ag
        .post("/api/erp/usuarios")
        .send({ nombre: `P ${rol}`, dni, password: PASSWORD, rol });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
      const { id } = (
        await e.sql("SELECT id FROM usuarios WHERE tenant_id = $1 AND dni = $2", [dni])
      ).rows[0] as { id: string };
      const permisos = await e.ag.put(`/api/erp/usuarios/${id}/permisos`).send({
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
    expect(await actividad(await persona("operador", ["mantenimiento"]))).toEqual([]);
    expect(await actividad(await persona("lectura", TODO))).toHaveLength(2);
    const sin = await persona("operador", ["checklists"]);
    expect((await sin.get(`${MANT}/actividad`)).status).toBe(403);
  });

  it("solo los últimos 7 días, nada del futuro y como mucho 8", async () => {
    const e = await empresaCon(TODO);
    const vieja = await orden(e.ag, { activo_texto: "Compresora" });
    const futura = await orden(e.ag, { activo_texto: "Compresora" });
    const mover = (id: number, desfase: string) =>
      e.sql(
        `UPDATE ordenes_trabajo SET creado_en = now() + $3::interval
          WHERE tenant_id = $1 AND id = $2`,
        [id, desfase]
      );
    await mover(vieja, "-8 days");
    await mover(futura, "1 hour");
    expect(await actividad(e.ag)).toEqual([]);

    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await orden(e.ag, { activo_texto: `Bomba ${i}` }));
    const r = await actividad(e.ag);
    expect(r.map((m) => m.orden_id)).toEqual(ids.slice(2).reverse());
    expect(r[0]).toMatchObject({ unidad: "Bomba 9", unidad_hoy: null });
  });

  it("no se cruza entre empresas y sin sesión no entra", async () => {
    const a = await empresaCon(TODO);
    const b = await empresaCon(TODO);
    const u = await unidad(a.ag);
    await llenar(a.ag, await formato(a.ag), { equipo_id: u.id }, ["Frenos"]);
    expect(await actividad(b.ag)).toEqual([]);
    expect((await request(app).get(`${MANT}/actividad`)).status).toBe(401);
  });

  it("con 40,000 checklists responde rápido", async () => {
    const e = await empresaCon(TODO);
    const u = await unidad(e.ag);
    await llenar(e.ag, await formato(e.ag), { equipo_id: u.id }, ["Luces"]);
    await e.sql(
      `INSERT INTO checklists (tenant_id, equipo_id, plantilla_id, usuario_id, salida)
       SELECT k.tenant_id, k.equipo_id, k.plantilla_id, k.usuario_id, 'libre'
         FROM checklists k, generate_series(1, 40000) WHERE k.tenant_id = $1`
    );
    const inicio = Date.now();
    expect(await actividad(e.ag)).toHaveLength(8);
    expect(Date.now() - inicio).toBeLessThan(2000);
  });
});
