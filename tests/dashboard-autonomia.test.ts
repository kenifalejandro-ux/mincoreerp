/** tests/dashboard-autonomia.test.ts
 *
 * El Dashboard no tiene datos propios: cada tarjeta y cada gráfico es enriquecimiento de OTRO módulo
 * (Repuestos, Combustible, Documentos; `opcionales` en registry.ts). Sin el módulo NO se ejecuta su
 * consulta: no hay 403 ni error, la parte se omite y su clave no aparece en la respuesta. Lo que se
 * fija:
 *
 * 1. Una empresa con SOLO Checklists (más el propio Dashboard) recibe 200 y ninguna clave de otro módulo.
 * 2. Con un solo módulo —Repuestos, Combustible o Documentos— llegan solo las claves de ESE módulo.
 * 3. Con los tres módulos, la respuesta trae todas las claves de siempre.
 * 4. Las rutas sueltas responden `[]` (200) sin el módulo, y los KPIs, vacíos.
 * 5. Una empresa que PIERDE Repuestos deja de recibir sus datos aunque las filas sigan ahí; si el
 *    módulo vuelve, reaparecen.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

const CLAVES_REPUESTOS = [
  "total_repuestos",
  "stock_bajo",
  "valor_inventario",
  "porcentaje_riesgo",
  "sobre_stock",
  "valor_stock_bajo",
  "inventario_categoria",
  "valor_categoria",
  "stock_vs_minimo",
];
const CLAVES_COMBUSTIBLE = ["combustible_porcentaje"];
const CLAVES_DOCUMENTOS = ["docs_vencidos", "docs_por_vencer", "documentos_estado"];
const TODAS = [...CLAVES_REPUESTOS, ...CLAVES_COMBUSTIBLE, ...CLAVES_DOCUMENTOS];

describe("Dashboard: autonomía de módulos", () => {
  const empresas: Empresa[] = [];

  /** Una empresa con exactamente esos módulos habilitados (más el propio Dashboard). */
  const nueva = async (modulos: string[]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    await ponerModulos(e, modulos);
    return e;
  };
  const ponerModulos = async (e: Empresa, modulos: string[]) => {
    const habilitados = ["dashboard", ...modulos];
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: habilitados.includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  // Los módulos del usuario viajan en el JWT: tras cambiarlos hay que entrar de nuevo.
  const sesion = async (e: Empresa) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return agente;
  };
  type Agente = Awaited<ReturnType<typeof sesion>>;

  const dashboard = async (admin: Agente) => {
    const r = await admin.get("/api/erp/dashboard");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Record<string, unknown>;
  };
  /** Las claves de TODAS que la respuesta trae. */
  const clavesPresentes = (cuerpo: Record<string, unknown>) =>
    TODAS.filter((k) => k in cuerpo).sort();

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("una empresa con SOLO Checklists recibe 200 y ninguna clave de Repuestos, Combustible ni Documentos", async () => {
    const e = await nueva(["checklists"]);
    const admin = await sesion(e);
    // De verdad no tiene esos módulos.
    expect((await admin.get("/api/erp/repuestos")).status).toBe(403);

    expect(clavesPresentes(await dashboard(admin))).toEqual([]);
  });

  it("con un solo módulo llegan solo las claves de ese módulo", async () => {
    const soloRepuestos = await sesion(await nueva(["repuestos"]));
    expect(clavesPresentes(await dashboard(soloRepuestos))).toEqual([...CLAVES_REPUESTOS].sort());

    const soloCombustible = await sesion(await nueva(["combustible"]));
    expect(clavesPresentes(await dashboard(soloCombustible))).toEqual(CLAVES_COMBUSTIBLE);

    const soloDocumentos = await sesion(await nueva(["documentos"]));
    expect(clavesPresentes(await dashboard(soloDocumentos))).toEqual([...CLAVES_DOCUMENTOS].sort());
  });

  it("con los tres módulos la respuesta trae todas las claves de siempre", async () => {
    const e = await nueva(["repuestos", "combustible", "documentos"]);
    const admin = await sesion(e);
    const cuerpo = await dashboard(admin);
    expect(clavesPresentes(cuerpo)).toEqual([...TODAS].sort());
    // Los gráficos son listas (vacías en una empresa recién creada), no null.
    for (const lista of ["inventario_categoria", "valor_categoria", "documentos_estado"]) {
      expect(Array.isArray(cuerpo[lista]), lista).toBe(true);
    }
  });

  it("las rutas sueltas responden [] (200) sin el módulo, y los KPIs salen vacíos", async () => {
    const admin = await sesion(await nueva(["checklists"]));
    for (const ruta of ["repuestos-categoria", "valor-categoria", "documentos", "stock-nivel"]) {
      const r = await admin.get(`/api/erp/dashboard/${ruta}`);
      expect(r.status, ruta).toBe(200);
      expect(r.body, ruta).toEqual([]);
    }
    const kpis = await admin.get("/api/erp/dashboard/kpis");
    expect(kpis.status).toBe(200);
    expect(kpis.body).toEqual({});

    // Con el módulo, la misma ruta responde una lista (el valor concreto no importa aquí).
    const conRepuestos = await sesion(await nueva(["repuestos"]));
    const r = await conRepuestos.get("/api/erp/dashboard/repuestos-categoria");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it("una empresa que pierde Repuestos deja de recibir sus datos aunque las filas sigan ahí, y los recupera si vuelve", async () => {
    const e = await nueva(["repuestos"]);
    let admin = await sesion(e);
    const creado = await admin.post("/api/erp/repuestos").send({
      codigo: idUnico("DSH"),
      nombre: "Filtro de aceite",
      categoria: "Filtros",
      stock: 3,
      stock_minimo: 5,
      stock_maximo: 30,
      precio: 25,
    });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);

    // Con el módulo: la fila cuenta.
    const con = await dashboard(admin);
    expect(Number(con.total_repuestos)).toBe(1);
    expect(con.inventario_categoria).toEqual([{ categoria: "Filtros", total: "1" }]);

    // Sin el módulo: la fila sigue en la base, pero el Dashboard ni la consulta ni la devuelve.
    await ponerModulos(e, []);
    admin = await sesion(e);
    const sin = await dashboard(admin);
    expect(clavesPresentes(sin)).toEqual([]);
    const suelta = await admin.get("/api/erp/dashboard/repuestos-categoria");
    expect(suelta.body).toEqual([]);

    // Vuelve el módulo: reaparece.
    await ponerModulos(e, ["repuestos"]);
    admin = await sesion(e);
    expect(Number((await dashboard(admin)).total_repuestos)).toBe(1);
  });
});
