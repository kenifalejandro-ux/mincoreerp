/** tests/proveedores-alta-edicion.test.ts
 *
 * Ecosistema «Gestión de proveedores», PR2: alta y edición de proveedores. La tabla sigue siendo
 * `combustible_grifos` (de Combustible); el ecosistema escribe en ella con las mismas reglas.
 *
 * 1. Crear (201): aparece en el directorio con código, tipos y uso Interno/Externo; "" en el RUC = sin RUC.
 * 2. Validación (400): nombre vacío, RUC que no tiene 11 dígitos, y un proveedor que no abastece nada.
 * 3. Duplicados (409): mismo nombre o mismo RUC en la empresa; otra empresa puede repetirlos.
 * 4. Editar: cambia nombre, RUC, estado y banderas; conservar el propio RUC no choca; el RUC de otro sí (409);
 *    inexistente o de otra empresa → 404; el comodín «Otros» no se edita.
 * 5. Operador escribe; Lectura no (403). Cada cambio deja su rastro de auditoría, sin el contenido.
 * 6. Lo que se crea aquí lo ve la pestaña Proveedores de Combustible (misma tabla).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

const base = {
  abastece_tanque: true,
  abastece_ruta: false,
  abastece_urea: false,
  abastece_urea_ruta: false,
};

describe("Gestión de proveedores: alta y edición", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;

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
  const crear = (ag: Agente, extra: Record<string, unknown> = {}) =>
    ag.post("/api/erp/proveedores").send({ nombre: "GRIFO UNO", ruc: "", ...base, ...extra });
  const completo = (extra: Record<string, unknown> = {}) => ({
    nombre: "GRIFO UNO",
    ruc: "",
    activo: true,
    ...base,
    ...extra,
  });

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await ponerModulos(a, ["proveedores", "combustible"]);
    await ponerModulos(b, ["proveedores"]);
    admin = await entrar(a.usuario.email, a);
    adminB = await entrar(b.usuario.email, b);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("crea un proveedor y aparece en el directorio con código, tipos y uso", async () => {
    const r = await crear(admin, {
      nombre: "  GRIFO SANTA ROSA  ",
      ruc: "20512398744",
      abastece_ruta: true,
      abastece_urea: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      nombre: "GRIFO SANTA ROSA",
      ruc: "20512398744",
      activo: true,
      tipos: ["Combustible", "Urea"],
      combustible: { interno: true, externo: true },
      urea: { interno: true, externo: false },
    });
    expect(r.body.codigo).toBe(`PRV-${String(r.body.id).padStart(3, "0")}`);
    const lista = (await admin.get("/api/erp/proveedores")).body as { id: number }[];
    expect(lista.some((p) => p.id === r.body.id)).toBe(true);
  });

  it("rechaza lo inválido con 400, no con 500", async () => {
    for (const mala of [
      { nombre: "   " },
      { ruc: "123" },
      { ruc: "2051239874X" },
      { abastece_tanque: false },
    ]) {
      const r = await crear(admin, { nombre: "VALIDO", ...mala });
      expect(r.status, JSON.stringify(mala)).toBe(400);
    }
  });

  it("un nombre o un RUC repetido en la empresa es 409; otra empresa puede repetirlos; sin RUC no choca", async () => {
    expect((await crear(admin, { nombre: "DUP", ruc: "20000000001" })).status).toBe(201);
    const nombre = await crear(admin, { nombre: "DUP", ruc: "20000000002" });
    expect(nombre.status).toBe(409);
    expect(nombre.body.message).toMatch(/DUP/);
    const ruc = await crear(admin, { nombre: "OTRO NOMBRE", ruc: "20000000001" });
    expect(ruc.status).toBe(409);
    expect(ruc.body.message).toMatch(/20000000001/);
    expect((await crear(adminB, { nombre: "DUP", ruc: "20000000001" })).status).toBe(201);
    expect((await crear(admin, { nombre: "SIN RUC 1" })).status).toBe(201);
    expect((await crear(admin, { nombre: "SIN RUC 2" })).status).toBe(201);
  });

  it("edita nombre, RUC, estado y banderas; conservar el propio RUC no choca, el de otro sí", async () => {
    const id = (await crear(admin, { nombre: "EDITABLE", ruc: "20000000010" })).body.id;
    const otro = (await crear(admin, { nombre: "EL OTRO", ruc: "20000000011" })).body.id;
    const r = await admin.put(`/api/erp/proveedores/${id}`).send(
      completo({
        nombre: "EDITADO",
        ruc: "20000000010",
        activo: false,
        abastece_tanque: false,
        abastece_urea_ruta: true,
      })
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      nombre: "EDITADO",
      activo: false,
      tipos: ["Urea"],
      urea: { interno: false, externo: true },
    });
    const choque = await admin
      .put(`/api/erp/proveedores/${id}`)
      .send(completo({ nombre: "EDITADO", ruc: "20000000011" }));
    expect(choque.status).toBe(409);
    const alLimpiar = await admin
      .put(`/api/erp/proveedores/${id}`)
      .send(completo({ nombre: "EDITADO", ruc: "" }));
    expect(alLimpiar.body.ruc).toBeNull();
    expect(otro).not.toBe(id);
  });

  it("un proveedor inexistente, de otra empresa o el comodín «Otros» no se editan (404)", async () => {
    expect((await admin.put("/api/erp/proveedores/999999999").send(completo())).status).toBe(404);
    const ajeno = (await crear(adminB, { nombre: "SOLO DE B", ruc: "20000000020" })).body.id;
    expect((await admin.put(`/api/erp/proveedores/${ajeno}`).send(completo())).status).toBe(404);
    const idOtros = await withTenant(a.tenant.id, async (c) => {
      const r = await c.query<{ id: number }>(
        `INSERT INTO combustible_grifos (tenant_id, nombre, es_otros) VALUES ($1,'OTROS',true) RETURNING id`,
        [a.tenant.id]
      );
      return r.rows[0].id;
    });
    expect((await admin.put(`/api/erp/proveedores/${idOtros}`).send(completo())).status).toBe(404);
  });

  it("el operador escribe; Lectura no", async () => {
    const mail = (rol: string) => `${rol}-${a.tenant.slug}@test.local`;
    for (const rol of ["operador", "lectura"]) {
      const alta = await admin
        .post("/api/erp/usuarios")
        .send({ nombre: `Persona ${rol}`, email: mail(rol), password: PASSWORD, rol });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    }
    const operador = await entrar(mail("operador"), a);
    const creado = await crear(operador, { nombre: "DEL OPERADOR" });
    expect(creado.status).toBe(201);
    expect(
      (
        await operador
          .put(`/api/erp/proveedores/${creado.body.id}`)
          .send(completo({ nombre: "DEL OPERADOR 2" }))
      ).status
    ).toBe(200);
    const lectura = await entrar(mail("lectura"), a);
    expect((await crear(lectura, { nombre: "NO DEBE" })).status).toBe(403);
    expect(
      (await lectura.put(`/api/erp/proveedores/${creado.body.id}`).send(completo())).status
    ).toBe(403);
    expect((await lectura.get("/api/erp/proveedores")).status).toBe(200);
  });

  it("deja auditoría de cada cambio, con ids y sin el contenido del proveedor", async () => {
    const r = await crear(admin, { nombre: "AUDITADO SECRETO", ruc: "20000000030" });
    await admin
      .put(`/api/erp/proveedores/${r.body.id}`)
      .send(completo({ nombre: "AUDITADO SECRETO", ruc: "20000000030", activo: false }));
    const filas = await pool.query<{ accion: string; detalle: Record<string, unknown> }>(
      `SELECT accion, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion IN ('proveedores.crear','proveedores.actualizar')
          AND (detalle->>'proveedorId')::int = $2
        ORDER BY id`,
      [a.tenant.id, r.body.id]
    );
    expect(filas.rows.map((f) => f.accion)).toEqual([
      "proveedores.crear",
      "proveedores.actualizar",
    ]);
    const texto = JSON.stringify(filas.rows);
    expect(texto).not.toContain("AUDITADO SECRETO");
    expect(texto).not.toContain("20000000030");
  });

  it("la ciudad se guarda en la ficha al crear y al editar, sin tocar lo demás de la ficha", async () => {
    const r = await crear(admin, { nombre: "CON CIUDAD", ciudad: "  Arequipa " });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as number;
    // El detalle trae la ciudad y la ficha también.
    expect((await admin.get(`/api/erp/proveedores/${id}`)).body.ciudad).toBe("Arequipa");
    expect((await admin.get(`/api/erp/proveedores/${id}/ficha`)).body.datos.ciudad).toBe(
      "Arequipa"
    );
    const enLista = (await admin.get("/api/erp/proveedores")).body as {
      id: number;
      ciudad: string | null;
    }[];
    expect(enLista.find((p) => p.id === id)?.ciudad).toBe("Arequipa");

    // Se completa la ficha por su pestaña; editar el proveedor con otra ciudad NO borra lo demás.
    expect(
      (
        await admin
          .put(`/api/erp/proveedores/${id}/ficha`)
          .send({ ciudad: "Arequipa", direccion: "Av. Los Pinos 123", telefono: "064123456" })
      ).status
    ).toBe(200);
    const cambio = await admin
      .put(`/api/erp/proveedores/${id}`)
      .send(completo({ nombre: "CON CIUDAD", ciudad: "Cusco" }));
    expect(cambio.status, JSON.stringify(cambio.body)).toBe(200);
    const ficha = (await admin.get(`/api/erp/proveedores/${id}/ficha`)).body.datos;
    expect(ficha).toMatchObject({
      ciudad: "Cusco",
      direccion: "Av. Los Pinos 123",
      telefono: "064123456",
    });

    // Sin el campo, la ciudad queda como está; con "" se borra.
    await admin.put(`/api/erp/proveedores/${id}`).send(completo({ nombre: "CON CIUDAD" }));
    expect((await admin.get(`/api/erp/proveedores/${id}`)).body.ciudad).toBe("Cusco");
    await admin
      .put(`/api/erp/proveedores/${id}`)
      .send(completo({ nombre: "CON CIUDAD", ciudad: "" }));
    expect((await admin.get(`/api/erp/proveedores/${id}`)).body.ciudad).toBeNull();
  });

  it("sin ciudad no crea ficha; una ciudad de más de 80 letras es 400", async () => {
    const r = await crear(admin, { nombre: "SIN CIUDAD" });
    expect(r.status).toBe(201);
    expect((await admin.get(`/api/erp/proveedores/${r.body.id}`)).body.ciudad).toBeNull();
    expect((await crear(admin, { nombre: "CIUDAD LARGA", ciudad: "x".repeat(81) })).status).toBe(
      400
    );
  });

  it("cambiar la ciudad deja el nombre del campo en la bitácora, no su valor", async () => {
    const r = await crear(admin, { nombre: "BITACORA CIUDAD", ciudad: "Tacna" });
    await admin
      .put(`/api/erp/proveedores/${r.body.id}`)
      .send(completo({ nombre: "BITACORA CIUDAD", ciudad: "Puno" }));
    // El mismo valor otra vez no cuenta como cambio.
    await admin
      .put(`/api/erp/proveedores/${r.body.id}`)
      .send(completo({ nombre: "BITACORA CIUDAD", ciudad: "Puno" }));
    const filas = await pool.query<{ detalle: Record<string, unknown> }>(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'proveedores.actualizar'
          AND (detalle->>'proveedorId')::int = $2 ORDER BY id`,
      [a.tenant.id, r.body.id]
    );
    expect(filas.rows.map((f) => f.detalle.campos ?? null)).toEqual([["ciudad"], null]);
    expect(JSON.stringify(filas.rows)).not.toMatch(/Puno|Tacna/);
  });

  it("lo que se crea aquí lo ve la pestaña Proveedores de Combustible (misma tabla)", async () => {
    const r = await crear(admin, { nombre: "VISIBLE EN COMBUSTIBLE", abastece_ruta: true });
    const grifos = await admin.get("/api/erp/combustible/grifos");
    expect(grifos.status).toBe(200);
    expect((grifos.body as { id: number }[]).some((g) => g.id === r.body.id)).toBe(true);
  });
});
