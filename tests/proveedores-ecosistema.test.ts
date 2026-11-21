/** tests/proveedores-ecosistema.test.ts
 *
 * Ecosistema «Gestión de proveedores», PR1 (solo lectura). Lo que se fija:
 *
 * 1. Una empresa con SOLO el módulo `proveedores` (sin Combustible) ve el directorio, el resumen y la
 *    ficha: los proveedores son las filas de `combustible_grifos`, que el módulo lee sin exigir
 *    Combustible.
 * 2. El comodín «Otros» (`es_otros`) no es un proveedor y no aparece.
 * 3. Interno / Externo salen de las banderas: abastece_tanque / abastece_ruta (combustible) y
 *    abastece_urea / abastece_urea_ruta (urea).
 * 4. Sin el módulo, 403. Otra empresa no ve los proveedores de esta (ficha 404).
 * 5. El perfil Lectura ve el directorio, pero no puede escribir (el módulo no tiene escrituras).
 *    Sin permiso de pestaña propio: el acceso lo da el módulo (ver proveedores.routes.ts).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("Gestión de proveedores: directorio de solo lectura", () => {
  const empresas: Empresa[] = [];

  const ponerModulos = async (e: Empresa, modulos: string[]) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: modulos.includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const entrar = async (email: string, e: Empresa) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return agente;
  };
  const insertar = (e: Empresa, nombre: string, extra: Record<string, unknown> = {}) =>
    withTenant(e.tenant.id, async (client) => {
      const cols = {
        abastece_tanque: false,
        abastece_ruta: false,
        abastece_urea: false,
        abastece_urea_ruta: false,
        activo: true,
        es_otros: false,
        ruc: null,
        ...extra,
      };
      const r = await client.query<{ id: number }>(
        `INSERT INTO combustible_grifos
           (tenant_id, nombre, ruc, activo, abastece_tanque, abastece_ruta, abastece_urea,
            abastece_urea_ruta, es_otros)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          e.tenant.id,
          nombre,
          cols.ruc,
          cols.activo,
          cols.abastece_tanque,
          cols.abastece_ruta,
          cols.abastece_urea,
          cols.abastece_urea_ruta,
          cols.es_otros,
        ]
      );
      return r.rows[0].id;
    });

  let solo: Empresa;
  let sinModulo: Empresa;
  let otra: Empresa;
  let idGrifo: number;
  let idUrea: number;
  let idOtros: number;

  beforeAll(async () => {
    solo = await crearTenantDePrueba(PASSWORD);
    sinModulo = await crearTenantDePrueba(PASSWORD);
    otra = await crearTenantDePrueba(PASSWORD);
    empresas.push(solo, sinModulo, otra);
    await ponerModulos(solo, ["proveedores"]);
    await ponerModulos(sinModulo, ["combustible"]);
    await ponerModulos(otra, ["proveedores"]);
    idGrifo = await insertar(solo, "GRIFO SANTA ROSA", {
      ruc: "20512398744",
      abastece_tanque: true,
      abastece_ruta: true,
    });
    idUrea = await insertar(solo, "QUIMICA DEL SUR", { abastece_urea: true, activo: false });
    idOtros = await insertar(solo, "OTROS", { es_otros: true, abastece_ruta: true });
    await insertar(sinModulo, "GRIFO AJENO", { abastece_ruta: true });
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("sin Combustible, el directorio lista los proveedores y deja fuera el comodín «Otros»", async () => {
    const admin = await entrar(solo.usuario.email, solo);
    const r = await admin.get("/api/erp/proveedores");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const nombres = (r.body as { nombre: string }[]).map((p) => p.nombre);
    expect(nombres).toEqual(["GRIFO SANTA ROSA", "QUIMICA DEL SUR"]);
    expect(nombres).not.toContain("OTROS");
    expect(idOtros).toBeGreaterThan(0);
  });

  it("arma el código, el tipo y el uso Interno/Externo desde las banderas", async () => {
    const admin = await entrar(solo.usuario.email, solo);
    const lista = (await admin.get("/api/erp/proveedores")).body as {
      id: number;
      codigo: string;
      ruc: string | null;
      activo: boolean;
      tipos: string[];
      combustible: { interno: boolean; externo: boolean };
      urea: { interno: boolean; externo: boolean };
    }[];
    const grifo = lista.find((p) => p.id === idGrifo)!;
    expect(grifo.codigo).toBe(`PRV-${String(idGrifo).padStart(3, "0")}`);
    expect(grifo.ruc).toBe("20512398744");
    expect(grifo.tipos).toEqual(["Combustible"]);
    expect(grifo.combustible).toEqual({ interno: true, externo: true });
    expect(grifo.urea).toEqual({ interno: false, externo: false });
    const urea = lista.find((p) => p.id === idUrea)!;
    expect(urea.activo).toBe(false);
    expect(urea.tipos).toEqual(["Urea"]);
    expect(urea.urea).toEqual({ interno: true, externo: false });
  });

  it("el resumen cuenta registrados, activos, tipos y usos", async () => {
    const admin = await entrar(solo.usuario.email, solo);
    const r = await admin.get("/api/erp/proveedores/resumen");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      total: 2,
      activos: 1,
      inactivos: 1,
      combustible: 1,
      urea: 1,
      internos: 2,
      externos: 1,
    });
  });

  it("la ficha abre el proveedor; uno inexistente es 404 y el «Otros» no se abre", async () => {
    const admin = await entrar(solo.usuario.email, solo);
    const ok = await admin.get(`/api/erp/proveedores/${idGrifo}`);
    expect(ok.status).toBe(200);
    expect(ok.body.nombre).toBe("GRIFO SANTA ROSA");
    expect((await admin.get("/api/erp/proveedores/999999999")).status).toBe(404);
    expect((await admin.get(`/api/erp/proveedores/${idOtros}`)).status).toBe(404);
  });

  it("otra empresa no ve los proveedores de esta", async () => {
    const admin = await entrar(otra.usuario.email, otra);
    expect((await admin.get("/api/erp/proveedores")).body).toEqual([]);
    expect((await admin.get(`/api/erp/proveedores/${idGrifo}`)).status).toBe(404);
  });

  it("una empresa sin el módulo recibe 403", async () => {
    const admin = await entrar(sinModulo.usuario.email, sinModulo);
    expect((await admin.get("/api/erp/proveedores")).status).toBe(403);
    expect((await admin.get("/api/erp/proveedores/resumen")).status).toBe(403);
  });

  it("el perfil Lectura ve el directorio y no escribe", async () => {
    const admin = await entrar(solo.usuario.email, solo);
    const email = `lectura-${solo.tenant.slug}@test.local`;
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Lectura de prueba", email, password: PASSWORD, rol: "lectura" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const lectura = await entrar(email, solo);
    expect((await lectura.get("/api/erp/proveedores")).status).toBe(200);
    expect((await lectura.post("/api/erp/proveedores").send({ nombre: "X" })).status).toBe(403);
  });
});
