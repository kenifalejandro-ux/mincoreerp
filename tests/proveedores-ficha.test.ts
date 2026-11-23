/** tests/proveedores-ficha.test.ts
 *
 * La ficha del proveedor (PR3a): dirección, teléfono, correo, condiciones de pago y personas de contacto.
 * Tablas propias del módulo (`proveedores_ficha` y `proveedores_contactos`, 0198).
 *
 * 1. Sin Combustible (empresa SOLO con Proveedores): la ficha nace vacía; se guardan los datos y se leen.
 * 2. Condiciones de pago: contado no lleva plazo, crédito lo exige (1 a 365 días); validaciones de correo
 *    y teléfono.
 * 3. Contactos: alta, el primero es el principal, cambiar de principal, editar, quitar (nunca se borra) y
 *    el siguiente pasa a principal; un reintento con el mismo `cliente_uuid` no duplica.
 * 4. Permisos: admin y operador escriben, Lectura solo mira.
 * 5. Auditoría con los ids y los campos cambiados (sin los valores); otra empresa no ve ni toca nada.
 */
import { randomUUID } from "node:crypto";

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

describe("Ficha del proveedor: datos, condiciones de pago y contactos", () => {
  const empresas: Empresa[] = [];
  let a: Empresa; // solo Proveedores
  let b: Empresa; // otra empresa
  let admin: Agente;
  let adminB: Agente;
  let proveedor: number;
  let proveedorB: number;

  const entrar = async (email: string, e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
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
  const crearProveedor = (e: Empresa, nombre: string) =>
    withTenant(
      e.tenant.id,
      async (cl) =>
        (
          await cl.query<{ id: number }>(
            `INSERT INTO combustible_grifos (tenant_id, nombre, abastece_ruta)
             VALUES ($1,$2,true) RETURNING id`,
            [e.tenant.id, nombre]
          )
        ).rows[0].id
    );
  /** Las tablas de la ficha tienen RLS: se consultan con el tenant puesto. */
  const consultar = (sql: string, params: unknown[]) =>
    withTenant(a.tenant.id, (cl) => cl.query(sql, params));
  const ficha = (ag: Agente, id = proveedor) => ag.get(`/api/erp/proveedores/${id}/ficha`);
  const contacto = (extra: Record<string, unknown> = {}) => ({
    nombre: "Rosa Quispe",
    cargo: "Ventas",
    telefono: "987654321",
    correo: "ROSA@grifo.pe",
    principal: false,
    ...extra,
  });
  const nuevoContacto = (ag: Agente, extra: Record<string, unknown> = {}, id = proveedor) =>
    ag.post(`/api/erp/proveedores/${id}/contactos`).send(contacto(extra));

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await soloProveedores(a);
    await soloProveedores(b);
    proveedor = await crearProveedor(a, "GRIFO FICHA");
    proveedorB = await crearProveedor(b, "GRIFO DE B");
    admin = await entrar(a.usuario.email, a);
    adminB = await entrar(b.usuario.email, b);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("sin Combustible: la ficha nace vacía y los datos se guardan y se leen", async () => {
    const vacia = await ficha(admin);
    expect(vacia.status, JSON.stringify(vacia.body)).toBe(200);
    expect(vacia.body).toEqual({
      datos: {
        ciudad: null,
        direccion: null,
        telefono: null,
        correo: null,
        formaPago: null,
        plazoPagoDias: null,
        moneda: null,
      },
      contactos: [],
    });

    const guardado = await admin.put(`/api/erp/proveedores/${proveedor}/ficha`).send({
      direccion: "  Av. Los Pinos 123, Huancayo ",
      telefono: "064-123456",
      correo: "VENTAS@Grifo.pe",
      forma_pago: "credito",
      plazo_pago_dias: 30,
      moneda: "PEN",
    });
    expect(guardado.status, JSON.stringify(guardado.body)).toBe(200);
    expect(guardado.body).toEqual({
      ciudad: null,
      direccion: "Av. Los Pinos 123, Huancayo",
      telefono: "064-123456",
      correo: "ventas@grifo.pe",
      formaPago: "credito",
      plazoPagoDias: 30,
      moneda: "PEN",
    });
    expect((await ficha(admin)).body.datos).toEqual(guardado.body);

    // Se guarda completo: lo que no se manda queda vacío.
    const parcial = await admin
      .put(`/api/erp/proveedores/${proveedor}/ficha`)
      .send({ forma_pago: "contado", moneda: "USD" });
    expect(parcial.status).toBe(200);
    expect(parcial.body).toMatchObject({
      direccion: null,
      correo: null,
      formaPago: "contado",
      plazoPagoDias: null,
      moneda: "USD",
    });
    // Una sola fila por proveedor.
    const filas = await consultar(
      `SELECT count(*)::int AS n FROM proveedores_ficha WHERE tenant_id = $1`,
      [a.tenant.id]
    );
    expect(filas.rows[0].n).toBe(1);
  });

  it("la ciudad: un PUT de la ficha sin ciudad la conserva; con null o vacía, la borra", async () => {
    const alta = await admin.post("/api/erp/proveedores").send({
      nombre: "CIUDAD QUE NO SE PIERDE",
      ruc: "",
      ciudad: "Huancayo",
      abastece_tanque: false,
      abastece_ruta: true,
      abastece_urea: false,
      abastece_urea_ruta: false,
    });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const id = alta.body.id as number;
    const leer = async () => (await admin.get(`/api/erp/proveedores/${id}/ficha`)).body.datos;
    expect((await leer()).ciudad).toBe("Huancayo");

    // Sin la clave `ciudad`: se guarda lo demás y la ciudad queda como estaba.
    const sinCiudad = await admin
      .put(`/api/erp/proveedores/${id}/ficha`)
      .send({ telefono: "064123456", moneda: "PEN" });
    expect(sinCiudad.status, JSON.stringify(sinCiudad.body)).toBe(200);
    expect(sinCiudad.body.ciudad).toBe("Huancayo");
    expect((await leer()).telefono).toBe("064123456");
    // La bitácora tampoco dice que cambió la ciudad.
    const campos = (
      await pool.query<{ detalle: { campos: string[] } }>(
        `SELECT detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'proveedores.datos_editar' AND (detalle->>'proveedorId')::int = $2`,
        [a.tenant.id, id]
      )
    ).rows[0].detalle.campos;
    expect(campos).not.toContain("ciudad");

    // La pantalla la manda siempre: con otro valor la cambia…
    expect(
      (await admin.put(`/api/erp/proveedores/${id}/ficha`).send({ ciudad: "Lima" })).body.ciudad
    ).toBe("Lima");
    // …y con null o vacía la borra, a propósito.
    expect(
      (await admin.put(`/api/erp/proveedores/${id}/ficha`).send({ ciudad: null })).body.ciudad
    ).toBeNull();
    await admin.put(`/api/erp/proveedores/${id}/ficha`).send({ ciudad: "Cusco" });
    expect(
      (await admin.put(`/api/erp/proveedores/${id}/ficha`).send({ ciudad: "  " })).body.ciudad
    ).toBeNull();
    // Ciudad demasiado larga: 400.
    expect(
      (await admin.put(`/api/erp/proveedores/${id}/ficha`).send({ ciudad: "x".repeat(81) })).status
    ).toBe(400);
  });

  it("validaciones: crédito exige plazo, contado no lo lleva, correo y teléfono válidos", async () => {
    const put = (cuerpo: object) =>
      admin.put(`/api/erp/proveedores/${proveedor}/ficha`).send(cuerpo);
    for (const mala of [
      { forma_pago: "credito" },
      { forma_pago: "credito", plazo_pago_dias: 0 },
      { forma_pago: "credito", plazo_pago_dias: 366 },
      { forma_pago: "credito", plazo_pago_dias: 2.5 },
      { forma_pago: "contado", plazo_pago_dias: 15 },
      { plazo_pago_dias: 15 },
      { forma_pago: "trueque" },
      { moneda: "EUR" },
      { correo: "no-es-correo" },
      { telefono: "abc" },
      { direccion: "x".repeat(251) },
    ]) {
      expect((await put(mala)).status, JSON.stringify(mala)).toBe(400);
    }
    expect((await put({})).status).toBe(200);
    expect((await admin.get(`/api/erp/proveedores/999999999/ficha`)).status).toBe(404);
    expect((await admin.put(`/api/erp/proveedores/999999999/ficha`).send({})).status).toBe(404);
  });

  it("contactos: el primero es el principal, se cambia de principal, se edita y se quita sin borrar", async () => {
    const primero = await nuevoContacto(admin);
    expect(primero.status, JSON.stringify(primero.body)).toBe(201);
    expect(primero.body).toMatchObject({
      nombre: "Rosa Quispe",
      correo: "rosa@grifo.pe",
      principal: true,
    });
    const segundo = await nuevoContacto(admin, { nombre: "Juan Pérez", cargo: "" });
    expect(segundo.status).toBe(201);
    expect(segundo.body).toMatchObject({ principal: false, cargo: null });

    // Marcar al segundo como principal le quita la marca al primero.
    const cambio = await admin
      .put(`/api/erp/proveedores/${proveedor}/contactos/${segundo.body.id}`)
      .send(contacto({ nombre: "Juan Pérez", principal: true }));
    expect(cambio.status, JSON.stringify(cambio.body)).toBe(200);
    let lista = (await ficha(admin)).body.contactos as { id: number; principal: boolean }[];
    expect(lista.map((c) => [c.id, c.principal])).toEqual([
      [segundo.body.id, true],
      [primero.body.id, false],
    ]);

    // Quitar al principal: nunca se borra la fila y el otro pasa a principal.
    const quitado = await admin.patch(
      `/api/erp/proveedores/${proveedor}/contactos/${segundo.body.id}/quitar`
    );
    expect(quitado.status).toBe(200);
    lista = (await ficha(admin)).body.contactos;
    expect(lista.map((c) => [c.id, c.principal])).toEqual([[primero.body.id, true]]);
    const enBase = await consultar(
      `SELECT activo, principal, quitado_por FROM proveedores_contactos WHERE id = $1`,
      [segundo.body.id]
    );
    expect(enBase.rows[0]).toMatchObject({ activo: false, principal: false });
    expect(enBase.rows[0].quitado_por).toBe(a.usuario.id);

    // Uno quitado no se edita ni se quita otra vez; el principal único no puede dejar de serlo.
    expect(
      (
        await admin
          .put(`/api/erp/proveedores/${proveedor}/contactos/${segundo.body.id}`)
          .send(contacto())
      ).status
    ).toBe(404);
    expect(
      (await admin.patch(`/api/erp/proveedores/${proveedor}/contactos/${segundo.body.id}/quitar`))
        .status
    ).toBe(404);
    const sinMarca = await admin
      .put(`/api/erp/proveedores/${proveedor}/contactos/${primero.body.id}`)
      .send(contacto({ principal: false }));
    expect(sinMarca.body.principal).toBe(true);
  });

  it("contactos: validaciones y reintento con el mismo cliente_uuid", async () => {
    for (const malo of [
      { nombre: "" },
      { nombre: "   " },
      { telefono: "", correo: "" },
      { correo: "sin-arroba" },
      { telefono: "abc" },
      { principal: "si" },
    ]) {
      expect((await nuevoContacto(admin, malo)).status, JSON.stringify(malo)).toBe(400);
    }
    expect((await nuevoContacto(admin, {}, 999999999)).status).toBe(404);

    const uuid = randomUUID();
    const una = await nuevoContacto(admin, { nombre: "Ana Reintento", cliente_uuid: uuid });
    const otra = await nuevoContacto(admin, { nombre: "Ana Reintento", cliente_uuid: uuid });
    expect(una.status).toBe(201);
    expect(otra.status).toBe(200);
    expect(otra.body.id).toBe(una.body.id);
    const n = await consultar(
      `SELECT count(*)::int AS n FROM proveedores_contactos WHERE tenant_id = $1 AND nombre = $2`,
      [a.tenant.id, "Ana Reintento"]
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("permisos: el operador escribe, Lectura solo mira", async () => {
    const alta = async (rol: string) => {
      const email = `${rol}-${a.tenant.slug}@test.local`;
      const r = await admin
        .post("/api/erp/usuarios")
        .send({ nombre: `Persona ${rol}`, email, password: PASSWORD, rol });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return email;
    };
    const op = await entrar(await alta("operador"), a);
    expect((await nuevoContacto(op, { nombre: "Del operador" })).status).toBe(201);
    expect(
      (await op.put(`/api/erp/proveedores/${proveedor}/ficha`).send({ moneda: "PEN" })).status
    ).toBe(200);

    const lec = await entrar(await alta("lectura"), a);
    expect((await ficha(lec)).status).toBe(200);
    expect((await nuevoContacto(lec)).status).toBe(403);
    expect(
      (await lec.put(`/api/erp/proveedores/${proveedor}/ficha`).send({ moneda: "PEN" })).status
    ).toBe(403);
    const id = (await ficha(admin)).body.contactos[0].id;
    expect(
      (await lec.patch(`/api/erp/proveedores/${proveedor}/contactos/${id}/quitar`)).status
    ).toBe(403);
  });

  it("auditoría: ids y campos cambiados, sin los valores", async () => {
    await admin
      .put(`/api/erp/proveedores/${proveedor}/ficha`)
      .send({ direccion: "Jr. Secreto 999", moneda: "USD" });
    const r = await pool.query<{ accion: string; detalle: Record<string, unknown> }>(
      `SELECT accion, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion LIKE 'proveedores.%' AND accion <> 'proveedores.crear'
        ORDER BY id`,
      [a.tenant.id]
    );
    const acciones = new Set(r.rows.map((x) => x.accion));
    for (const esperada of [
      "proveedores.datos_editar",
      "proveedores.contacto_crear",
      "proveedores.contacto_editar",
      "proveedores.contacto_quitar",
    ]) {
      expect(acciones.has(esperada), esperada).toBe(true);
    }
    const ultima = r.rows.filter((x) => x.accion === "proveedores.datos_editar").at(-1)!;
    expect(ultima.detalle.campos).toEqual(expect.arrayContaining(["direccion", "moneda"]));
    const texto = JSON.stringify(r.rows);
    expect(texto).not.toContain("Jr. Secreto 999");
    expect(texto).not.toContain("987654321");
    expect(texto).not.toContain("rosa@grifo.pe");
  });

  it("otra empresa no ve ni toca la ficha", async () => {
    const id = (await ficha(admin)).body.contactos[0].id;
    // Con el id de A, B recibe 404 (no se revela que existe).
    expect((await ficha(adminB, proveedor)).status).toBe(404);
    expect(
      (await adminB.put(`/api/erp/proveedores/${proveedor}/ficha`).send({ moneda: "USD" })).status
    ).toBe(404);
    expect(
      (await adminB.patch(`/api/erp/proveedores/${proveedor}/contactos/${id}/quitar`)).status
    ).toBe(404);
    // Un contacto de A no se toca por la puerta de un proveedor de B.
    expect(
      (
        await adminB
          .put(`/api/erp/proveedores/${proveedorB}/contactos/${id}`)
          .send(contacto({ nombre: "Intruso" }))
      ).status
    ).toBe(404);
    expect((await ficha(adminB, proveedorB)).body.contactos).toEqual([]);
    expect(
      (await ficha(admin)).body.contactos.some((c: { nombre: string }) => c.nombre === "Intruso")
    ).toBe(false);
  });
});
