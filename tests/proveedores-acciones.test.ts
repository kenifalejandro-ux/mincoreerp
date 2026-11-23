/** tests/proveedores-acciones.test.ts
 *
 * Acciones sobre un proveedor del ecosistema «Gestión de proveedores»: desactivar y reactivar (con motivo en la
 * bitácora) y eliminar (solo el admin y solo un proveedor sin historia).
 *
 * 1. Lógica pura: cuándo se puede eliminar y cómo se dice qué lo ata.
 * 2. API: desactivar exige el motivo; reactivar no; repetir no escribe otra vez en la bitácora; eliminar un
 *    proveedor sin historia borra con él su ficha, contactos y cuentas; con precios (también anulados) o
 *    compras no se puede (409 con el porqué); solo el admin elimina; la bitácora lo dice con el nombre.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import {
  descripcionDeMovimientos,
  hayMovimientos,
  mensajeDeNoEliminable,
} from "../src/modules/proveedores/proveedores.acciones";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

describe("eliminar un proveedor: lógica pura", () => {
  const nada = { precios: 0, compras: 0, recepciones: 0, despachos: 0 };

  it("sin movimientos se puede; con cualquiera, no", () => {
    expect(hayMovimientos(nada)).toBe(false);
    for (const k of ["precios", "compras", "recepciones", "despachos"] as const) {
      expect(hayMovimientos({ ...nada, [k]: 1 }), k).toBe(true);
    }
  });

  it("dice solo lo que tiene, en singular o plural y en orden fijo", () => {
    expect(descripcionDeMovimientos(nada)).toEqual([]);
    expect(
      descripcionDeMovimientos({ precios: 2, compras: 1, recepciones: 0, despachos: 3 })
    ).toEqual(["2 precios", "1 compra", "3 despachos"]);
    expect(descripcionDeMovimientos({ ...nada, recepciones: 1 })).toEqual(["1 recepción"]);
  });

  it("el mensaje une con comas y «y», y manda a desactivar", () => {
    expect(mensajeDeNoEliminable({ ...nada, precios: 1 })).toBe(
      "No se puede eliminar: tiene 1 precio. Desactívalo en su lugar."
    );
    expect(mensajeDeNoEliminable({ precios: 2, compras: 1, recepciones: 4, despachos: 0 })).toBe(
      "No se puede eliminar: tiene 2 precios, 1 compra y 4 recepciones. Desactívalo en su lugar."
    );
  });
});

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

const base = {
  abastece_tanque: false,
  abastece_ruta: true,
  abastece_urea: false,
  abastece_urea_ruta: false,
};

describe("Gestión de proveedores: desactivar, reactivar y eliminar", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;
  let operador: Agente;
  let lectura: Agente;

  const entrar = async (email: string, e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const ponerModulos = async (e: Empresa, ids: string[]) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: ids.includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const nuevo = async (ag: Agente, nombre: string) => {
    const r = await ag.post("/api/erp/proveedores").send({ nombre, ruc: "", ...base });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: number; codigo: string };
  };
  const estado = (ag: Agente, id: number, cuerpo: object) =>
    ag.patch(`/api/erp/proveedores/${id}/estado`).send(cuerpo);
  const auditoria = async (accion: string, id: number) =>
    (
      await pool.query<{ detalle: Record<string, unknown> }>(
        `SELECT detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = $2 AND (detalle->>'proveedorId')::int = $3 ORDER BY id`,
        [a.tenant.id, accion, id]
      )
    ).rows.map((f) => f.detalle);
  const filasDe = (tabla: string, id: number) =>
    withTenant(a.tenant.id, async (cl) =>
      Number(
        (
          await cl.query(`SELECT count(*) FROM ${tabla} WHERE tenant_id = $1 AND grifo_id = $2`, [
            a.tenant.id,
            id,
          ])
        ).rows[0].count
      )
    );

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await ponerModulos(a, ["proveedores", "combustible"]);
    await ponerModulos(b, ["proveedores"]);
    admin = await entrar(a.usuario.email, a);
    adminB = await entrar(b.usuario.email, b);
    for (const rol of ["operador", "lectura"]) {
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: `Persona ${rol}`,
        email: `${rol}-${a.tenant.slug}@test.local`,
        password: PASSWORD,
        rol,
      });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    }
    operador = await entrar(`operador-${a.tenant.slug}@test.local`, a);
    lectura = await entrar(`lectura-${a.tenant.slug}@test.local`, a);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("desactivar exige el motivo; reactivar no; y el cambio queda en la bitácora con su motivo", async () => {
    const p = await nuevo(admin, "PARA DESACTIVAR");
    for (const malo of [
      { activo: false },
      { activo: false, motivo: "  " },
      { activo: false, motivo: "ab" },
    ]) {
      expect((await estado(admin, p.id, malo)).status, JSON.stringify(malo)).toBe(400);
    }
    expect((await estado(admin, p.id, { activo: false, motivo: "x".repeat(301) })).status).toBe(
      400
    );

    const off = await estado(admin, p.id, { activo: false, motivo: "  Ya no nos abastece  " });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.activo).toBe(false);
    const enLista = (await admin.get("/api/erp/proveedores")).body as {
      id: number;
      activo: boolean;
    }[];
    expect(enLista.find((x) => x.id === p.id)?.activo).toBe(false);

    // Repetir lo mismo no cambia nada ni escribe otra vez.
    expect((await estado(admin, p.id, { activo: false, motivo: "Otra vez" })).status).toBe(200);

    const on = await estado(admin, p.id, { activo: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.activo).toBe(true);
    expect((await estado(admin, p.id, { activo: true })).status).toBe(200);

    expect(await auditoria("proveedores.desactivar", p.id)).toEqual([
      { proveedorId: p.id, motivo: "Ya no nos abastece" },
    ]);
    expect(await auditoria("proveedores.reactivar", p.id)).toEqual([{ proveedorId: p.id }]);
  });

  it("el operador desactiva (como edita); Lectura no; otra empresa no ve el proveedor (404)", async () => {
    const p = await nuevo(admin, "DEL OPERADOR");
    expect(
      (await estado(operador, p.id, { activo: false, motivo: "Prueba del operador" })).status
    ).toBe(200);
    expect((await estado(lectura, p.id, { activo: true })).status).toBe(403);
    expect((await estado(adminB, p.id, { activo: false, motivo: "No es mío" })).status).toBe(404);
    expect((await estado(admin, 999999, { activo: false, motivo: "No existe" })).status).toBe(404);
  });

  it("un proveedor sin historia se elimina, con su ficha y sus contactos; queda en la bitácora con su nombre", async () => {
    const p = await nuevo(admin, "CREADO POR ERROR");
    expect(
      (
        await admin
          .put(`/api/erp/proveedores/${p.id}/ficha`)
          .send({ ciudad: "Lima", direccion: "Av. 1" })
      ).status
    ).toBe(200);
    expect(
      (
        await admin
          .post(`/api/erp/proveedores/${p.id}/contactos`)
          .send({ nombre: "Rosa", telefono: "987654321", principal: true })
      ).status
    ).toBe(201);
    expect(await filasDe("proveedores_ficha", p.id)).toBe(1);
    expect(await filasDe("proveedores_contactos", p.id)).toBe(1);

    const antes = await admin.get(`/api/erp/proveedores/${p.id}/eliminable`);
    expect(antes.body).toMatchObject({ eliminable: true, motivo: null });

    const r = await admin.delete(`/api/erp/proveedores/${p.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await admin.get(`/api/erp/proveedores/${p.id}`)).status).toBe(404);
    expect(await filasDe("proveedores_ficha", p.id)).toBe(0);
    expect(await filasDe("proveedores_contactos", p.id)).toBe(0);
    const lista = (await admin.get("/api/erp/proveedores")).body as { id: number }[];
    expect(lista.some((x) => x.id === p.id)).toBe(false);

    expect(await auditoria("proveedores.eliminar", p.id)).toEqual([
      { proveedorId: p.id, codigo: p.codigo, nombre: "CREADO POR ERROR", tipos: ["Combustible"] },
    ]);
    // El Historial lo dice con el nombre, aunque el proveedor ya no exista.
    const h = await admin.get("/api/erp/proveedores/historial?categoria=proveedor");
    const evento = (h.body.eventos as { titulo: string; lineas: string[] }[]).find(
      (e) =>
        e.titulo === "Eliminó un proveedor" && e.lineas.some((l) => l.includes("CREADO POR ERROR"))
    );
    expect(evento?.lineas).toEqual([`CREADO POR ERROR · ${p.codigo}`]);
    // Eliminarlo otra vez: ya no existe.
    expect((await admin.delete(`/api/erp/proveedores/${p.id}`)).status).toBe(404);
  });

  it("con precios (también anulados) o compras no se elimina: 409 con el porqué", async () => {
    // Un precio anulado sigue contando: es parte de lo que se hizo con el proveedor.
    const conPrecio = await nuevo(admin, "CON PRECIO");
    const precio = await admin
      .post("/api/erp/proveedores/precios/combustible")
      .send({ tipo_combustible: "diesel_b5", grifo_ids: [conPrecio.id], precio_unitario: 15.8 });
    expect(precio.status, JSON.stringify(precio.body)).toBe(201);
    const bloqueado = await admin.get(`/api/erp/proveedores/${conPrecio.id}/eliminable`);
    expect(bloqueado.body).toMatchObject({
      eliminable: false,
      movimientos: { precios: 1, compras: 0, recepciones: 0, despachos: 0 },
      motivo: "No se puede eliminar: tiene 1 precio. Desactívalo en su lugar.",
    });
    const intento = await admin.delete(`/api/erp/proveedores/${conPrecio.id}`);
    expect(intento.status).toBe(409);
    expect(intento.body.message).toBe(
      "No se puede eliminar: tiene 1 precio. Desactívalo en su lugar."
    );
    expect(
      (
        await admin
          .patch(`/api/erp/proveedores/precios/combustible/${precio.body[0].id}/anular`)
          .send({ motivo: "Error de tipeo" })
      ).status
    ).toBe(200);
    expect((await admin.delete(`/api/erp/proveedores/${conPrecio.id}`)).status).toBe(409);
    // Sigue ahí, intacto.
    expect((await admin.get(`/api/erp/proveedores/${conPrecio.id}`)).status).toBe(200);

    // Una compra de cisterna.
    const conCompra = await nuevo(admin, "CON COMPRA");
    await withTenant(a.tenant.id, async (cl) => {
      const sede = (
        await cl.query<{ id: number }>(
          `SELECT id FROM grifos_internos WHERE tenant_id = $1 ORDER BY id LIMIT 1`,
          [a.tenant.id]
        )
      ).rows[0].id;
      await cl.query(
        `INSERT INTO combustible_compras_cisterna
           (tenant_id, grifo_interno_id, grifo_id, tipo_combustible, tipo_documento, numero_documento,
            fecha_compra, llegada_estimada, cantidad_facturada, costo_unitario)
         VALUES ($1,$2,$3,'diesel_b5','factura','F001-1', current_date, current_date, 1000, 15.5)`,
        [a.tenant.id, sede, conCompra.id]
      );
    });
    const compra = await admin.delete(`/api/erp/proveedores/${conCompra.id}`);
    expect(compra.status).toBe(409);
    expect(compra.body.message).toBe(
      "No se puede eliminar: tiene 1 compra. Desactívalo en su lugar."
    );
    // Lo que no se pudo eliminar no deja nada en la bitácora.
    expect(await auditoria("proveedores.eliminar", conPrecio.id)).toEqual([]);
    expect(await auditoria("proveedores.eliminar", conCompra.id)).toEqual([]);
  });

  it("dos eliminaciones a la vez: una borra y la otra recibe 404; la bitácora queda con UNA fila que cuenta las cuentas que se fueron (sin números)", async () => {
    const NUMEROS = ["19412345678901234567", "00198765432109876543"];
    for (let vuelta = 1; vuelta <= 3; vuelta++) {
      const p = await nuevo(admin, `DOBLE ELIMINACION ${vuelta}`);
      for (const [i, numero] of NUMEROS.entries()) {
        const cuenta = await admin.post(`/api/erp/proveedores/${p.id}/cuentas`).send({
          banco: i === 0 ? "BCP" : "BBVA",
          tipo_cuenta: "corriente",
          moneda: "PEN",
          principal: i === 0,
          numero,
        });
        expect(cuenta.status, JSON.stringify(cuenta.body)).toBe(201);
      }
      const [uno, otro] = await Promise.all([
        admin.delete(`/api/erp/proveedores/${p.id}`),
        admin.delete(`/api/erp/proveedores/${p.id}`),
      ]);
      expect([uno.status, otro.status].sort(), `vuelta ${vuelta}`).toEqual([200, 404]);
      const filas = await auditoria("proveedores.eliminar", p.id);
      expect(filas, `vuelta ${vuelta}`).toHaveLength(1);
      expect(filas[0]).toMatchObject({ proveedorId: p.id, cuentasBorradas: 2 });
      for (const numero of NUMEROS) expect(JSON.stringify(filas)).not.toContain(numero);
      expect(await filasDe("proveedores_cuentas_bancarias", p.id)).toBe(0);
    }
  });

  it("un precio que entra mientras se elimina gana la base: 409 y el proveedor sigue ahí", async () => {
    const p = await nuevo(admin, "PRECIO EN CARRERA");
    // Otra transacción inserta un precio y todavía no confirma: el DELETE queda esperando esa fila.
    const otra = await pool.connect();
    try {
      await otra.query("BEGIN");
      await otra.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenant.id]);
      await otra.query(
        `INSERT INTO combustible_precios (tenant_id, tipo_combustible, grifo_id, precio_unitario, vigente_desde)
         VALUES ($1, 'diesel_b5', $2, 15.5, now())`,
        [a.tenant.id, p.id]
      );
      // `.then` dispara la petición (supertest es perezoso).
      const borrando = admin.delete(`/api/erp/proveedores/${p.id}`).then((r) => r);
      await new Promise((r) => setTimeout(r, 400));
      await otra.query("COMMIT");
      const r = await borrando;
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.message).toMatch(/Desactívalo/);
    } finally {
      otra.release();
    }
    expect((await admin.get(`/api/erp/proveedores/${p.id}`)).status).toBe(200);
    expect(await filasDe("combustible_precios", p.id)).toBe(1);
    expect(await auditoria("proveedores.eliminar", p.id)).toEqual([]);
  });

  it("solo el admin elimina; el operador y Lectura reciben 403; otra empresa, 404", async () => {
    const p = await nuevo(admin, "SOLO ADMIN");
    for (const ag of [operador, lectura]) {
      expect((await ag.delete(`/api/erp/proveedores/${p.id}`)).status).toBe(403);
      expect((await ag.get(`/api/erp/proveedores/${p.id}/eliminable`)).status).toBe(403);
    }
    expect((await adminB.delete(`/api/erp/proveedores/${p.id}`)).status).toBe(404);
    expect((await adminB.get(`/api/erp/proveedores/${p.id}/eliminable`)).status).toBe(404);
    expect((await admin.get(`/api/erp/proveedores/${p.id}`)).status).toBe(200);
    expect((await admin.delete(`/api/erp/proveedores/abc`)).status).toBe(404);
  });

  it("el comodín «Otros» de Combustible no se desactiva ni se elimina", async () => {
    const otros = await withTenant(
      a.tenant.id,
      async (cl) =>
        (
          await cl.query<{ id: number }>(
            `SELECT id FROM combustible_grifos WHERE tenant_id = $1 AND es_otros LIMIT 1`,
            [a.tenant.id]
          )
        ).rows[0]?.id
    );
    if (otros === undefined) return; // esta empresa no tiene el comodín: nada que probar
    expect((await estado(admin, otros, { activo: false, motivo: "No se toca" })).status).toBe(404);
    expect((await admin.delete(`/api/erp/proveedores/${otros}`)).status).toBe(404);
  });
});
