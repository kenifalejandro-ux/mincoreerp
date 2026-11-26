/** tests/checklists-consulta-oficina.test.ts
 *
 * M7: lo que la pantalla de oficina necesita del módulo Checklists: buscar y filtrar registros, las cifras de
 * hoy y los datos de cada formato.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const PASSWORD = "ClaveDePrueba123";
const CK = "/api/erp/checklists";
const MANT = "/api/erp/mantenimiento";
const TODO = ["mantenimiento", "checklists", "ordenes_trabajo"];

describe("Checklists: consulta de oficina (M7)", () => {
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

  const unidad = async (ag: Agente, extra: Record<string, unknown> = {}) => {
    const placa = idUnico("U").slice(-12).toUpperCase();
    const r = await ag
      .post(`${MANT}/equipos`)
      .send({ placa_codigo: placa, tipo: "Volquete", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: Number(r.body.id), placa };
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

  type Fila = { id: number; fallas: string | null; usuario_nombre: string };
  const lista = async (ag: Agente, query = "") => {
    const r = await ag.get(`${CK}${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { data: Fila[]; pagination: { nextCursor: number; hasMore: boolean } };
  };
  const ids = async (ag: Agente, query: string) => (await lista(ag, query)).data.map((c) => c.id);
  const buscar = (ag: Agente, q: string) => ids(ag, `?q=${encodeURIComponent(q)}`);

  it("busca por número, unidad, activo, persona y falla; filtra por resultado", async () => {
    const e = await empresaCon(TODO);
    const u = await unidad(e.ag);
    const f = await formato(e.ag);
    const mala = await llenar(e.ag, f, { equipo_id: u.id }, ["Frenos", "Luces"]);
    const buena = await llenar(e.ag, f, { activo_texto: "Compresora 100% norte" });

    const todo = (await lista(e.ag)).data;
    expect(todo.map((c) => [c.id, c.fallas])).toEqual([
      [buena, null],
      [mala, "Frenos, Luces"],
    ]);
    expect(await buscar(e.ag, u.placa.toLowerCase())).toEqual([mala]);
    expect(await buscar(e.ag, "compresora")).toEqual([buena]);
    expect(await buscar(e.ag, "fren")).toEqual([mala]);
    expect(await buscar(e.ag, `#${mala}`)).toEqual([mala]);
    expect(await buscar(e.ag, todo[0].usuario_nombre.toUpperCase())).toHaveLength(2);
    // «%» y «_» se buscan tal cual, no son comodines.
    expect(await buscar(e.ag, "100%")).toEqual([buena]);
    expect(await buscar(e.ag, "c_mpresora")).toEqual([]);
    expect(await buscar(e.ag, "'; DROP TABLE checklists; --")).toEqual([]);
    expect(await buscar(e.ag, "99999999999999")).toEqual([]);
    expect(await ids(e.ag, "?resultado=no_apta")).toEqual([mala]);
    expect(await ids(e.ag, "?resultado=bien&q=compresora")).toEqual([buena]);
    expect(await ids(e.ag, "?resultado=no_apta&q=compresora")).toEqual([]);
    expect((await e.ag.get(`${CK}?resultado=otro`)).status).toBe(400);
    expect((await e.ag.get(`${CK}?q=${"a".repeat(81)}`)).status).toBe(400);
    expect((await e.ag.get(`${CK}?q=a&q=b`)).status).toBe(400);
  });

  it("combina con «por autorizar», ignora lo vacío y aguanta caracteres raros", async () => {
    const e = await empresaCon(TODO);
    const f = await formato(e.ag);
    const espera = await llenar(e.ag, f, { activo_texto: "Faja \\ sur" }, ["Luces"]);
    const libre = await llenar(e.ag, f, { activo_texto: "Faja norte" });
    expect(await ids(e.ag, "?salida=por_autorizar&q=faja")).toEqual([espera]);
    expect(await ids(e.ag, "?salida=por_autorizar&resultado=bien")).toEqual([]);
    // Vacío o solo espacios es «sin búsqueda».
    for (const q of ["?q=", "?q=%20%20"]) expect(await ids(e.ag, q)).toEqual([libre, espera]);
    expect(await buscar(e.ag, "\\")).toEqual([espera]);
    expect(await buscar(e.ag, "ñandú 🚚")).toEqual([]);
    expect(await buscar(e.ag, "#999999999")).toEqual([]);
    expect((await e.ag.get(`${CK}?q[a]=1`)).status).toBe(400);
    expect((await request(app).get(`${CK}/hoy`)).status).toBe(401);
  });

  it("el filtro se aplica antes de paginar: las páginas no se saltan ni repiten", async () => {
    const e = await empresaCon(TODO);
    const f = await formato(e.ag);
    const malas: number[] = [];
    for (let i = 0; i < 5; i++) {
      malas.push(await llenar(e.ag, f, { activo_texto: "Bomba" }, ["Frenos"]));
      await llenar(e.ag, f, { activo_texto: "Bomba" });
    }
    const vistas: number[] = [];
    let cursor = "";
    for (;;) {
      const r = await lista(e.ag, `?resultado=no_apta&pageSize=2${cursor}`);
      vistas.push(...r.data.map((c) => c.id));
      if (!r.pagination.hasMore) break;
      cursor = `&cursor=${r.pagination.nextCursor}`;
    }
    expect(vistas).toEqual(malas.reverse());
  });

  it("cuenta lo de hoy por resultado; lo de anoche en Perú no", async () => {
    const e = await empresaCon(TODO);
    const f = await formato(e.ag);
    await llenar(e.ag, f, { activo_texto: "A" }, ["Frenos"]);
    await llenar(e.ag, f, { activo_texto: "B" }, ["Luces"]);
    await llenar(e.ag, f, { activo_texto: "C" });
    expect((await e.ag.get(`${CK}/hoy`)).body).toEqual({
      total: 3,
      bien: 1,
      observado: 1,
      no_apta: 1,
    });
    await e.sql(
      `INSERT INTO checklists (tenant_id, plantilla_id, usuario_id, activo_texto, creado_en)
       SELECT tenant_id, plantilla_id, usuario_id, 'Ayer',
              date_trunc('day', now(), 'America/Lima') - interval '4 hours'
         FROM checklists WHERE tenant_id = $1 LIMIT 1`
    );
    expect((await e.ag.get(`${CK}/hoy`)).body.total).toBe(3);
  });

  it("cada formato dice sus preguntas, críticas, última edición y unidades que lo usan", async () => {
    const e = await empresaCon(TODO);
    await unidad(e.ag);
    await unidad(e.ag, { tipo: "Excavadora" });
    const general = await formato(e.ag);
    const suyo = await formato(e.ag, { tipo_equipo: "VOLQUETE" });
    const formatos = async (ag: Agente) =>
      (await ag.get(`${CK}/plantillas`)).body.data as Record<string, unknown>[];
    expect((await formatos(e.ag))[1]).toMatchObject({
      id: general,
      preguntas: 2,
      criticas: 1,
      unidades: 2,
      editado_por_nombre: null,
    });
    const editado = await e.ag.put(`${CK}/plantillas/${suyo}`).send({
      nombre: "Volquete",
      tipo_equipo: "Volquete",
      items: [{ descripcion: "Frenos", critica: true }],
      cambio: "Se quitó Luces",
      version_base: 1,
    });
    expect(editado.status, JSON.stringify(editado.body)).toBe(200);
    const [nuevo] = await formatos(e.ag);
    expect(nuevo).toMatchObject({ id: suyo, version: 2, preguntas: 1, unidades: 1 });
    expect(nuevo.editado_por_nombre).toEqual(expect.any(String));
  });

  it("solo con Checklists: sin unidades no se busca por placa y los formatos no las cuentan", async () => {
    const e = await empresaCon(TODO);
    const u = await unidad(e.ag);
    const f = await formato(e.ag);
    const c = await llenar(e.ag, f, { equipo_id: u.id }, ["Frenos"]);
    const solo = await e.habilitar(["checklists"]);
    expect(await buscar(solo, u.placa)).toEqual([]);
    expect(await buscar(solo, "frenos")).toEqual([c]);
    expect((await solo.get(`${CK}/plantillas`)).body.data[0].unidades).toBeNull();
    expect((await solo.get(`${CK}/hoy`)).body.total).toBe(1);
    const sin = await e.habilitar(["mantenimiento"]);
    expect((await sin.get(`${CK}/hoy`)).status).toBe(403);
  });

  it("no se cruza entre empresas", async () => {
    const a = await empresaCon(TODO);
    const b = await empresaCon(TODO);
    await llenar(a.ag, await formato(a.ag), { activo_texto: "Secreto" }, ["Frenos"]);
    expect(await buscar(b.ag, "secreto")).toEqual([]);
    expect((await b.ag.get(`${CK}/hoy`)).body.total).toBe(0);
  });

  it("buscar entre 40,000 checklists responde rápido", async () => {
    const e = await empresaCon(TODO);
    await llenar(e.ag, await formato(e.ag), { activo_texto: "Bomba" }, ["Frenos"]);
    await e.sql(
      `INSERT INTO checklists (tenant_id, plantilla_id, usuario_id, activo_texto)
       SELECT k.tenant_id, k.plantilla_id, k.usuario_id, 'Relleno'
         FROM checklists k, generate_series(1, 40000) WHERE k.tenant_id = $1`
    );
    const inicio = Date.now();
    expect(await buscar(e.ag, "no existe")).toEqual([]);
    expect(await buscar(e.ag, "bomba")).toHaveLength(1);
    expect(Date.now() - inicio).toBeLessThan(3000);
  });
});
