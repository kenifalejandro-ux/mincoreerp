/** tests/proveedores-cuentas.test.ts
 *
 * Cuentas bancarias del proveedor (PR3b, migración 0199). A qué cuenta se le paga es el dato que más se
 * defrauda, así que se fija que:
 *
 * 1. El número se guarda CIFRADO (nunca en claro en la base) y no viaja en una lista, un alta ni una edición.
 * 2. Solo «ver completo» lo devuelve, con su permiso, y cada vez queda en la bitácora (sin el número).
 * 3. Permisos: nacen SOLO para el admin; el operador no las trae y se le dan una por una (ver la lista, ver
 *    el número completo, editar); Lectura no escribe aunque se le dé.
 * 4. Reglas: principal automática y única, la misma cuenta no se repite, quitar pide motivo y nunca borra,
 *    reintento con el mismo `cliente_uuid`, validaciones del número.
 * 5. Bitácora con los últimos 4 (de antes y de después si cambió el número), jamás el número entero.
 * 6. Otra empresa no ve ni toca nada.
 */
import { randomUUID } from "node:crypto";

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import { descifrar } from "../src/server/shared/utils/platformCrypto";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const NUMERO = "19412345678901234567"; // CCI de 20 dígitos
const OTRO_NUMERO = "00198765432109876543";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

describe("Cuentas bancarias del proveedor", () => {
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
  const consultar = (sql: string, params: unknown[]) =>
    withTenant(a.tenant.id, (cl) => cl.query(sql, params));
  const cuenta = (extra: Record<string, unknown> = {}) => ({
    banco: "BCP",
    tipo_cuenta: "corriente",
    moneda: "PEN",
    titular: "GRIFO CUENTAS SAC",
    numero: NUMERO,
    principal: false,
    ...extra,
  });
  const nueva = (ag: Agente, extra: Record<string, unknown> = {}, id = proveedor) =>
    ag.post(`/api/erp/proveedores/${id}/cuentas`).send(cuenta(extra));
  const lista = (ag: Agente, id = proveedor) => ag.get(`/api/erp/proveedores/${id}/cuentas`);
  /** Crea una persona del rol y le deja SOLO los permisos de cuentas que se le pidan. */
  const persona = async (rol: string, dar: string[]) => {
    const email = `${rol}-${randomUUID().slice(0, 6)}-${a.tenant.slug}@test.local`;
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, email, password: PASSWORD, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const id = alta.body.id as string;
    const permisos = await admin.get(`/api/erp/usuarios/${id}/permisos`);
    const guardado = await admin.put(`/api/erp/usuarios/${id}/permisos`).send({
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
            p.modulo === "proveedores" && p.pestana.startsWith("cuentas")
              ? dar.includes(p.pestana)
              : p.permitido,
        })
      ),
      motivo: "Prueba de cuentas",
    });
    expect(guardado.status, JSON.stringify(guardado.body)).toBe(200);
    return entrar(email, a);
  };

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await soloProveedores(a);
    await soloProveedores(b);
    proveedor = await crearProveedor(a, "GRIFO CUENTAS");
    proveedorB = await crearProveedor(b, "GRIFO DE B");
    admin = await entrar(a.usuario.email, a);
    adminB = await entrar(b.usuario.email, b);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("sin Combustible: el número se guarda cifrado y no viaja nunca en claro", async () => {
    expect((await lista(admin)).body).toMatchObject({
      verCompleta: true,
      puedeEditar: true,
      cuentas: [],
    });
    const alta = await nueva(admin, { numero: "194-1234 5678 9012 34567" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    expect(alta.body).toMatchObject({
      banco: "BCP",
      tipoCuenta: "corriente",
      moneda: "PEN",
      numeroEnmascarado: "•••• 4567",
      principal: true,
    });
    // Ni el alta ni la lista llevan el número.
    const enLista = await lista(admin);
    expect(enLista.headers["cache-control"]).toBe("no-store");
    for (const texto of [JSON.stringify(alta.body), JSON.stringify(enLista.body)]) {
      expect(texto).not.toContain(NUMERO);
      expect(texto).not.toContain("1941234");
    }
    // En la base no hay rastro del número en claro: solo cifrado, últimos 4 y huella.
    const fila = (
      await consultar(`SELECT * FROM proveedores_cuentas_bancarias WHERE tenant_id = $1`, [
        a.tenant.id,
      ])
    ).rows[0];
    expect(JSON.stringify(fila)).not.toContain(NUMERO);
    expect(fila.numero_ultimos4).toBe("4567");
    expect(fila.numero_cifrado).not.toContain("4567");
    expect(descifrar(fila.numero_cifrado)).toBe(NUMERO);
    expect(fila.numero_huella).toMatch(/^[0-9a-f]{64}$/);
  });

  it("«ver completo» devuelve el número, sin caché, y deja constancia con los últimos 4", async () => {
    const id = (await lista(admin)).body.cuentas[0].id;
    const ver = await admin.post(`/api/erp/proveedores/${proveedor}/cuentas/${id}/ver-completa`);
    expect(ver.status, JSON.stringify(ver.body)).toBe(200);
    expect(ver.body).toEqual({ numero: NUMERO });
    expect(ver.headers["cache-control"]).toBe("no-store");
    const auditoria = await pool.query<{ detalle: Record<string, unknown> }>(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'proveedores.cuenta_ver'`,
      [a.tenant.id]
    );
    expect(auditoria.rows).toHaveLength(1);
    expect(auditoria.rows[0].detalle).toMatchObject({
      proveedorId: proveedor,
      cuentaId: id,
      ultimos4: "4567",
    });
    expect(JSON.stringify(auditoria.rows)).not.toContain(NUMERO);
    // Una cuenta que no existe: 404, sin bitácora de más.
    expect(
      (await admin.post(`/api/erp/proveedores/${proveedor}/cuentas/999999999/ver-completa`)).status
    ).toBe(404);
  });

  it("principal automática y única, y la misma cuenta no se repite", async () => {
    const segunda = await nueva(admin, { banco: "BBVA", numero: OTRO_NUMERO });
    expect(segunda.status).toBe(201);
    expect(segunda.body.principal).toBe(false);
    // Repetir una cuenta ya registrada (aunque se escriba con otros espacios): 409.
    const repetida = await nueva(admin, {
      banco: "Otro",
      numero: `${NUMERO.slice(0, 4)} ${NUMERO.slice(4)}`,
    });
    expect(repetida.status).toBe(409);
    expect(repetida.body.message).toMatch(/ya está registrada/);

    // Marcar la segunda como principal le quita la marca a la primera.
    const cambio = await admin
      .put(`/api/erp/proveedores/${proveedor}/cuentas/${segunda.body.id}`)
      .send({ ...cuenta({ banco: "BBVA" }), principal: true, numero: undefined });
    expect(cambio.status, JSON.stringify(cambio.body)).toBe(200);
    const cuentas = (await lista(admin)).body.cuentas as { id: number; principal: boolean }[];
    expect(cuentas.map((c) => c.principal)).toEqual([true, false]);
    expect(cuentas[0].id).toBe(segunda.body.id);
    // Sin mandar el número, se conserva el que estaba.
    const ver = await admin.post(
      `/api/erp/proveedores/${proveedor}/cuentas/${segunda.body.id}/ver-completa`
    );
    expect(ver.body.numero).toBe(OTRO_NUMERO);
  });

  it("cambiar el número se guarda cifrado y la bitácora dice los últimos 4 de antes y de después", async () => {
    const id = (await lista(admin)).body.cuentas.find(
      (c: { banco: string }) => c.banco === "BCP"
    ).id;
    const nuevoNumero = "00112233445566778899";
    const r = await admin
      .put(`/api/erp/proveedores/${proveedor}/cuentas/${id}`)
      .send(cuenta({ numero: nuevoNumero }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.numeroEnmascarado).toBe("•••• 8899");
    expect(JSON.stringify(r.body)).not.toContain(nuevoNumero);
    const ver = await admin.post(`/api/erp/proveedores/${proveedor}/cuentas/${id}/ver-completa`);
    expect(ver.body.numero).toBe(nuevoNumero);
    const log = await pool.query<{ detalle: Record<string, unknown> }>(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'proveedores.cuenta_cambiar_numero'`,
      [a.tenant.id]
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].detalle).toMatchObject({
      ultimos4Anteriores: "4567",
      ultimos4Nuevos: "8899",
    });
    // Editar sin tocar el número no es «cambiar el número».
    const sinNumero = await admin
      .put(`/api/erp/proveedores/${proveedor}/cuentas/${id}`)
      .send({ ...cuenta({ titular: "OTRO TITULAR" }), numero: undefined });
    expect(sinNumero.status).toBe(200);
    const editar = await pool.query(
      `SELECT 1 FROM platform_audit_log WHERE tenant_id = $1 AND accion = 'proveedores.cuenta_editar'`,
      [a.tenant.id]
    );
    // Dos ediciones sin número: marcar la principal (test anterior) y esta.
    expect(editar.rowCount).toBe(2);
  });

  it("validaciones del número y de los datos", async () => {
    for (const malo of [
      { numero: "" },
      { numero: "1234567" },
      { numero: "123456789012345678901" },
      { numero: "12345678abc" },
      { banco: "" },
      { banco: "   " },
      { tipo_cuenta: "plazo_fijo" },
      { moneda: "EUR" },
      { principal: "si" },
      { titular: "x".repeat(151) },
    ]) {
      expect((await nueva(admin, malo)).status, JSON.stringify(malo)).toBe(400);
    }
    expect((await nueva(admin, { numero: "5551234567" }, 999999999)).status).toBe(404);
    expect((await lista(admin, 999999999)).status).toBe(404);
  });

  it("quitar pide motivo, no borra, y la otra cuenta pasa a ser la principal", async () => {
    const [principal, otra] = (await lista(admin)).body.cuentas as { id: number }[];
    const quitar = (id: number, cuerpo: object) =>
      admin.patch(`/api/erp/proveedores/${proveedor}/cuentas/${id}/quitar`).send(cuerpo);
    expect((await quitar(principal.id, {})).status).toBe(400);
    expect((await quitar(principal.id, { motivo: "ab" })).status).toBe(400);
    expect((await quitar(principal.id, { motivo: "Cerró la cuenta" })).status).toBe(200);
    expect((await quitar(principal.id, { motivo: "Otra vez" })).status).toBe(404);
    const restantes = (await lista(admin)).body.cuentas as { id: number; principal: boolean }[];
    expect(restantes.map((c) => [c.id, c.principal])).toEqual([[otra.id, true]]);
    // Nunca se borra: queda la fila, con quién y por qué.
    const fila = (
      await consultar(
        `SELECT activo, principal, quitado_por, motivo_baja FROM proveedores_cuentas_bancarias WHERE id = $1`,
        [principal.id]
      )
    ).rows[0];
    expect(fila).toMatchObject({ activo: false, principal: false, motivo_baja: "Cerró la cuenta" });
    expect(fila.quitado_por).toBe(a.usuario.id);
    // Una cuenta quitada no se edita ni se ve completa; y su número se puede volver a registrar.
    expect(
      (
        await admin
          .put(`/api/erp/proveedores/${proveedor}/cuentas/${principal.id}`)
          .send({ ...cuenta(), numero: undefined })
      ).status
    ).toBe(404);
    expect(
      (await admin.post(`/api/erp/proveedores/${proveedor}/cuentas/${principal.id}/ver-completa`))
        .status
    ).toBe(404);
    expect((await nueva(admin, { numero: OTRO_NUMERO })).status).toBe(201);
  });

  it("reintento con el mismo cliente_uuid no duplica ni repite la bitácora", async () => {
    const uuid = randomUUID();
    const una = await nueva(admin, {
      banco: "Interbank",
      numero: "4003456789012",
      cliente_uuid: uuid,
    });
    const otra = await nueva(admin, {
      banco: "Interbank",
      numero: "4003456789012",
      cliente_uuid: uuid,
    });
    expect(una.status).toBe(201);
    expect(otra.status).toBe(200);
    expect(otra.body.id).toBe(una.body.id);
    const n = await consultar(
      `SELECT count(*)::int AS n FROM proveedores_cuentas_bancarias WHERE tenant_id = $1 AND banco = 'Interbank'`,
      [a.tenant.id]
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("permisos: nace solo para el admin; el operador y Lectura reciben lo que se les dé, por niveles", async () => {
    const id = (await lista(admin)).body.cuentas[0].id;
    const ver = (ag: Agente) =>
      ag.post(`/api/erp/proveedores/${proveedor}/cuentas/${id}/ver-completa`);

    // Operador sin nada de cuentas (por defecto): no ve ni la lista.
    const sinNada = await persona("operador", []);
    expect((await lista(sinNada)).status).toBe(403);
    expect((await nueva(sinNada)).status).toBe(403);
    expect((await ver(sinNada)).status).toBe(403);

    // Solo la lista: ve el número enmascarado, no lo completo ni edita.
    const soloLista = await persona("operador", ["cuentas"]);
    const l = await lista(soloLista);
    expect(l.status).toBe(200);
    expect(l.body).toMatchObject({ verCompleta: false, puedeEditar: false });
    expect(JSON.stringify(l.body)).not.toContain("4003456789012");
    expect((await ver(soloLista)).status).toBe(403);
    expect((await nueva(soloLista, { numero: "7771234567" })).status).toBe(403);

    // Con «ver completo» lo ve (y queda constancia), pero no edita.
    const conVer = await persona("operador", ["cuentas", "cuentas:ver_completa"]);
    expect((await ver(conVer)).status).toBe(200);
    expect((await nueva(conVer, { numero: "7771234567" })).status).toBe(403);
    const constancia = await pool.query(
      `SELECT usuario_id FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'proveedores.cuenta_ver' ORDER BY id DESC LIMIT 1`,
      [a.tenant.id]
    );
    expect(constancia.rows[0].usuario_id).not.toBe(a.usuario.id);

    // Con «editar» agrega y quita, pero no ve el número completo.
    const conEditar = await persona("operador", ["cuentas", "cuentas:editar"]);
    expect((await nueva(conEditar, { banco: "Scotiabank", numero: "7771234567" })).status).toBe(
      201
    );
    expect((await ver(conEditar)).status).toBe(403);

    // Lectura: puede ver la lista si se le da, pero escribir lo corta el perfil aunque tenga el permiso.
    const lectura = await persona("lectura", ["cuentas", "cuentas:ver_completa", "cuentas:editar"]);
    expect((await lista(lectura)).status).toBe(200);
    expect((await nueva(lectura, { numero: "8881234567" })).status).toBe(403);
  });

  it("la bitácora lleva ids y los últimos 4, nunca el número entero", async () => {
    const r = await pool.query<{ accion: string }>(
      `SELECT accion, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion LIKE 'proveedores.cuenta_%'`,
      [a.tenant.id]
    );
    const acciones = new Set(r.rows.map((x) => x.accion));
    for (const esperada of [
      "proveedores.cuenta_crear",
      "proveedores.cuenta_ver",
      "proveedores.cuenta_editar",
      "proveedores.cuenta_cambiar_numero",
      "proveedores.cuenta_quitar",
    ]) {
      expect(acciones.has(esperada), esperada).toBe(true);
    }
    const texto = JSON.stringify(r.rows);
    for (const numero of [
      NUMERO,
      OTRO_NUMERO,
      "00112233445566778899",
      "4003456789012",
      "7771234567",
    ]) {
      expect(texto).not.toContain(numero);
    }
  });

  it("otra empresa no ve ni toca las cuentas", async () => {
    const id = (await lista(admin)).body.cuentas[0].id;
    expect((await lista(adminB, proveedor)).status).toBe(404);
    expect(
      (await adminB.post(`/api/erp/proveedores/${proveedor}/cuentas/${id}/ver-completa`)).status
    ).toBe(404);
    expect((await nueva(adminB, { numero: "9991234567" }, proveedor)).status).toBe(404);
    // Un id de cuenta de A por la puerta de un proveedor de B tampoco sirve.
    expect(
      (await adminB.post(`/api/erp/proveedores/${proveedorB}/cuentas/${id}/ver-completa`)).status
    ).toBe(404);
    expect(
      (
        await adminB
          .patch(`/api/erp/proveedores/${proveedorB}/cuentas/${id}/quitar`)
          .send({ motivo: "intruso" })
      ).status
    ).toBe(404);
    expect((await lista(adminB, proveedorB)).body.cuentas).toEqual([]);
  });
});
