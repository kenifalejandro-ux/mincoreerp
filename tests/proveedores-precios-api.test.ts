/** tests/proveedores-precios-api.test.ts
 *
 * Gestión comercial (PR4): GET /api/erp/proveedores/precios, con base de datos.
 *
 * 1. Una empresa con SOLO el módulo `proveedores` (sin Combustible) ve los precios que ya están en las
 *    tablas de Combustible; los de tanque (venta interna) no se mezclan.
 * 2. Rige lo de Combustible: el anulado no vale y el de fecha futura es «programado».
 * 3. Permisos reutilizados de Precios: admin y operador ven combustible y urea; Lectura recibe 403; un
 *    permiso puesto a mano por producto recorta lo que se devuelve.
 * 4. Otra empresa no ve estos precios.
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
type Agente = ReturnType<typeof request.agent>;
interface Fila {
  producto: string;
  codigo: string;
  proveedorId: number;
  vigente: { precio: number } | null;
  anterior: { precio: number } | null;
  programado: { precio: number } | null;
  historial: { precio: number; anulado: boolean }[];
}

describe("Gestión comercial: precios de proveedores (solo lectura)", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let grifoRuta: number;
  let grifoUrea: number;

  const entrar = async (email: string, e: Empresa) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return agente;
  };
  const soloProveedores = async (e: Empresa) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "proveedores" ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const dias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
  const filas = async (ag: Agente) =>
    (await ag.get("/api/erp/proveedores/precios")).body.filas as Fila[];

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await soloProveedores(a);
    await soloProveedores(b);
    admin = await entrar(a.usuario.email, a);

    const ids = await withTenant(a.tenant.id, async (c) => {
      const g = async (nombre: string, ruta: boolean, urea: boolean) =>
        (
          await c.query<{ id: number }>(
            `INSERT INTO combustible_grifos (tenant_id, nombre, abastece_ruta, abastece_tanque, abastece_urea_ruta)
             VALUES ($1,$2,$3,false,$4) RETURNING id`,
            [a.tenant.id, nombre, ruta, urea]
          )
        ).rows[0].id;
      const ruta = await g("GRIFO RUTA", true, false);
      const urea = await g("PROVEEDOR UREA", false, true);
      const precio = (p: number, desde: string, anulado = false) =>
        c.query(
          `INSERT INTO combustible_precios (tenant_id, tipo_combustible, grifo_id, precio_unitario, vigente_desde, anulada_en, motivo_anulacion)
           VALUES ($1,'diesel_b5',$2,$3,$4,$5,$6)`,
          [a.tenant.id, ruta, p, desde, anulado ? new Date() : null, anulado ? "error" : null]
        );
      await precio(10, dias(-30));
      await precio(12, dias(-10));
      await precio(99, dias(-5), true);
      await precio(14, dias(3));
      await c.query(
        `INSERT INTO combustible_urea_precios (tenant_id, grifo_id, presentacion, precio_por_bulto, vigente_desde)
         VALUES ($1,$2,'caja',78,$3)`,
        [a.tenant.id, urea, dias(-2)]
      );
      return { ruta, urea };
    });
    grifoRuta = ids.ruta;
    grifoUrea = ids.urea;
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("sin Combustible, el admin ve el precio vigente, el anterior, el programado y la historia", async () => {
    const r = await admin.get("/api/erp/proveedores/precios");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ combustible: true, urea: true });
    const fila = (r.body.filas as Fila[]).find(
      (f) => f.proveedorId === grifoRuta && f.codigo === "diesel_b5"
    )!;
    expect(fila.vigente?.precio).toBe(12);
    expect(fila.anterior?.precio).toBe(10);
    expect(fila.programado?.precio).toBe(14);
    expect(fila.historial.map((h) => h.precio)).toEqual([14, 99, 12, 10]);
    expect(fila.historial.find((h) => h.precio === 99)?.anulado).toBe(true);
  });

  it("la urea va por proveedor y presentación, y el precio de un proveedor de ruta no aparece como urea", async () => {
    const lista = await filas(admin);
    const urea = lista.filter((f) => f.producto === "urea" && f.proveedorId === grifoUrea);
    expect(urea.find((f) => f.codigo === "caja")?.vigente?.precio).toBe(78);
    expect(lista.some((f) => f.producto === "urea" && f.proveedorId === grifoRuta)).toBe(false);
  });

  it("el operador ve los precios; Lectura no (403); un permiso a mano recorta el producto", async () => {
    const correo = (rol: string) => `${rol}-${a.tenant.slug}@test.local`;
    const ids: Record<string, string> = {};
    for (const rol of ["operador", "lectura"]) {
      const alta = await admin
        .post("/api/erp/usuarios")
        .send({ nombre: `Persona ${rol}`, email: correo(rol), password: PASSWORD, rol });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
      ids[rol] = alta.body.id;
    }
    const operador = await entrar(correo("operador"), a);
    expect((await operador.get("/api/erp/proveedores/precios")).body).toMatchObject({
      combustible: true,
      urea: true,
    });
    const lectura = await entrar(correo("lectura"), a);
    expect((await lectura.get("/api/erp/proveedores/precios")).status).toBe(403);

    // Al operador se le quita «Precios» de combustible a mano: solo queda la urea.
    const permisos = await admin.get(`/api/erp/usuarios/${ids.operador}/permisos`);
    const recorte = await admin.put(`/api/erp/usuarios/${ids.operador}/permisos`).send({
      modulos: permisos.body.modulos.map(
        (m: { modulo: string; asignado: boolean; nivel: string }) => ({
          modulo: m.modulo,
          asignado: m.asignado,
          nivel: m.nivel,
        })
      ),
      pestanas: permisos.body.pestanas.map(
        (p: { modulo: string; pestana: string; permitido: boolean }) => ({
          modulo: p.modulo,
          pestana: p.pestana,
          permitido:
            p.modulo === "combustible" && p.pestana === "tanques:precios" ? false : p.permitido,
        })
      ),
      motivo: "Solo urea",
    });
    expect(recorte.status, JSON.stringify(recorte.body)).toBe(200);
    const solo = await (await entrar(correo("operador"), a)).get("/api/erp/proveedores/precios");
    expect(solo.body).toMatchObject({ combustible: false, urea: true });
    expect((solo.body.filas as Fila[]).every((f) => f.producto === "urea")).toBe(true);
  });

  it("otra empresa no ve estos precios", async () => {
    const adminB = await entrar(b.usuario.email, b);
    expect(await filas(adminB)).toEqual([]);
  });
});
