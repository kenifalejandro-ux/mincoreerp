/** tests/proveedores-compras-escritura.test.ts
 *
 * Compras y recepciones (PR5b): registrar, habilitar y anular compras de cisterna desde el ecosistema.
 * Las reglas son las de Combustible (se reutilizan sus funciones); lo que se fija acá es que el ecosistema las
 * aplica igual y que una empresa SOLO con Proveedores puede hacer su trabajo de punta a punta.
 *
 * 1. Sin Combustible: el formulario trae proveedores de tanque, sedes y precios vigentes; se registra,
 *    habilita y anula; el estado va registrada → por_llegar → anulada.
 * 2. Reglas: documento repetido 409; proveedor que no es de tanque o está desactivado 400; datos inválidos
 *    400; reintento con el mismo `cliente_uuid` devuelve la misma compra sin duplicar; no se habilita una
 *    anulada ni se anula una recibida (409); anular pide motivo.
 * 3. Permisos: el admin gestiona; el operador solo con `cisternas:registrar_compra`; Lectura no (403).
 * 4. Auditoría con ids y sin el contenido.
 * 5. Con Combustible: lo registrado acá aparece «por llegar» en Combustible → Cisternas (misma tabla) y el
 *    alcance por sede se respeta (404 fuera de la sede asignada).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;
interface Compra {
  id: number;
  estado: string;
  numeroDocumento: string;
  total: number;
  motivoAnulacion: string | null;
}

describe("Compras y recepciones: escribir desde el ecosistema", () => {
  const empresas: Empresa[] = [];
  let a: Empresa; // Proveedores + Combustible
  let c: Empresa; // Proveedores + Combustible
  let admin: Agente;
  let adminC: Agente;
  let sedeA: number;
  let tanqueA: number; // proveedor de tanque (activo)
  let rutaA: number; // proveedor solo de ruta
  let inactivoA: number; // proveedor de tanque desactivado
  const hoy = new Date().toISOString().slice(0, 10);
  const dia = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  let n = 0;
  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    grifo_interno_id: sedeA,
    grifo_id: tanqueA,
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_documento: "factura",
    numero_documento: `F-${++n}-${a.tenant.slug}`,
    fecha_compra: hoy,
    llegada_estimada: dia(3),
    cantidad_facturada: 1000,
    costo_unitario: 15.5,
    ...extra,
  });

  const entrar = async (email: string, e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const modulos = async (e: Empresa, ids: string[]) => {
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
  const persona = async (ag: Agente, e: Empresa, rol: string) => {
    const email = `${rol}-${e.tenant.slug}@test.local`;
    const alta = await ag
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, email, password: PASSWORD, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    return { id: alta.body.id as string, email };
  };
  const proveedores = (e: Empresa) =>
    withTenant(e.tenant.id, async (cl) => {
      const nuevo = async (nombre: string, tanque: boolean, ruta: boolean, activo = true) =>
        (
          await cl.query<{ id: number }>(
            `INSERT INTO combustible_grifos (tenant_id, nombre, abastece_tanque, abastece_ruta, activo)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [e.tenant.id, nombre, tanque, ruta, activo]
          )
        ).rows[0].id;
      const sede = (
        await cl.query<{ id: number }>(
          `SELECT id FROM grifos_internos WHERE tenant_id = $1 ORDER BY id LIMIT 1`,
          [e.tenant.id]
        )
      ).rows[0].id;
      return {
        sede,
        tanque: await nuevo("PROVEEDOR TANQUE", true, false),
        ruta: await nuevo("PROVEEDOR RUTA", false, true),
        inactivo: await nuevo("PROVEEDOR INACTIVO", true, false, false),
      };
    });

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    c = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, c);
    await modulos(a, ["proveedores", "combustible"]);
    await modulos(c, ["proveedores", "combustible"]);
    const p = await proveedores(a);
    sedeA = p.sede;
    tanqueA = p.tanque;
    rutaA = p.ruta;
    inactivoA = p.inactivo;
    admin = await entrar(a.usuario.email, a);
    adminC = await entrar(c.usuario.email, c);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("el formulario trae lo necesario y la compra va registrada → por llegar → anulada", async () => {
    // Un precio vigente del proveedor para sugerir el costo.
    await withTenant(a.tenant.id, (cl) =>
      cl.query(
        `INSERT INTO combustible_precios (tenant_id, tipo_combustible, grifo_id, precio_unitario, vigente_desde)
         VALUES ($1,'diesel_b5',$2,15.8,now() - interval '1 day')`,
        [a.tenant.id, tanqueA]
      )
    );
    const form = await admin.get("/api/erp/proveedores/compras/formulario");
    expect(form.status, JSON.stringify(form.body)).toBe(200);
    expect(form.body.proveedores.map((x: { id: number }) => x.id)).toEqual([tanqueA]);
    expect(form.body.sedes.map((x: { id: number }) => x.id)).toContain(sedeA);
    expect(form.body.precios).toEqual([
      expect.objectContaining({ grifo_id: tanqueA, tipo_combustible: "diesel_b5" }),
    ]);

    const nueva = await admin.post("/api/erp/proveedores/compras").send(cuerpo());
    expect(nueva.status, JSON.stringify(nueva.body)).toBe(201);
    expect(nueva.body).toMatchObject({ estado: "registrada", total: 15500, recepcion: null });

    const id = nueva.body.id as number;
    const habilitada = await admin.patch(`/api/erp/proveedores/compras/${id}/habilitar`);
    expect(habilitada.status).toBe(200);
    expect(habilitada.body).toMatchObject({ estado: "por_llegar", habilitada: true });
    // Habilitar otra vez es inofensivo.
    expect((await admin.patch(`/api/erp/proveedores/compras/${id}/habilitar`)).body.estado).toBe(
      "por_llegar"
    );

    const anulada = await admin
      .patch(`/api/erp/proveedores/compras/${id}/anular`)
      .send({ motivo: "factura duplicada" });
    expect(anulada.status).toBe(200);
    expect(anulada.body).toMatchObject({ estado: "anulada", motivoAnulacion: "factura duplicada" });

    // Y la lista lo refleja.
    const lista = (await admin.get("/api/erp/proveedores/compras")).body.compras as Compra[];
    expect(lista.find((x) => x.id === id)?.estado).toBe("anulada");
  });

  it("reglas de Combustible: documento repetido, proveedor equivocado, datos inválidos y reintento", async () => {
    const base = cuerpo({ numero_documento: `REPETIDA-${a.tenant.slug}` });
    expect((await admin.post("/api/erp/proveedores/compras").send(base)).status).toBe(201);
    const repetida = await admin.post("/api/erp/proveedores/compras").send({ ...base });
    expect(repetida.status).toBe(409);
    expect(repetida.body.message).toMatch(/Ya hay una compra con el documento/);

    const deRuta = await admin
      .post("/api/erp/proveedores/compras")
      .send(cuerpo({ grifo_id: rutaA }));
    expect(deRuta.status).toBe(400);
    expect(deRuta.body.message).toMatch(/no está marcado como proveedor de tanque/);
    const inactivo = await admin
      .post("/api/erp/proveedores/compras")
      .send(cuerpo({ grifo_id: inactivoA }));
    expect(inactivo.status).toBe(400);
    expect(inactivo.body.message).toMatch(/desactivado/);

    for (const mala of [
      { numero_documento: "  " },
      { cantidad_facturada: 0 },
      { costo_unitario: -1 },
      { tipo_combustible: "agua" },
      { transportista_ruc: "123" },
    ]) {
      expect(
        (await admin.post("/api/erp/proveedores/compras").send(cuerpo(mala))).status,
        JSON.stringify(mala)
      ).toBe(400);
    }

    // El mismo cliente_uuid devuelve la misma compra, sin crear otra.
    const uuid = randomUUID();
    const una = await admin
      .post("/api/erp/proveedores/compras")
      .send(cuerpo({ cliente_uuid: uuid }));
    expect(una.status).toBe(201);
    const otra = await admin
      .post("/api/erp/proveedores/compras")
      .send(cuerpo({ cliente_uuid: uuid, numero_documento: "OTRO-NUMERO" }));
    expect(otra.status).toBe(200);
    expect(otra.body.id).toBe(una.body.id);
  });

  it("estados: no se habilita una anulada, no se anula una recibida, y anular pide motivo", async () => {
    const compra = (await admin.post("/api/erp/proveedores/compras").send(cuerpo())).body;
    expect(
      (await admin.patch(`/api/erp/proveedores/compras/${compra.id}/anular`).send({ motivo: " " }))
        .status
    ).toBe(400);
    expect(
      (
        await admin
          .patch(`/api/erp/proveedores/compras/${compra.id}/anular`)
          .send({ motivo: "error" })
      ).status
    ).toBe(200);
    expect((await admin.patch(`/api/erp/proveedores/compras/${compra.id}/habilitar`)).status).toBe(
      409
    );
    expect(
      (
        await admin
          .patch(`/api/erp/proveedores/compras/${compra.id}/anular`)
          .send({ motivo: "otra" })
      ).status
    ).toBe(409);
    expect((await admin.patch("/api/erp/proveedores/compras/999999999/habilitar")).status).toBe(
      404
    );

    // Una compra ya recibida no se anula (primero se anula su recepción).
    const recibida = (await admin.post("/api/erp/proveedores/compras").send(cuerpo())).body;
    await withTenant(a.tenant.id, async (cl) => {
      const tanque = (
        await cl.query<{ id: number }>(
          `INSERT INTO combustible (tenant_id, tanque_nombre, capacidad_total, codigo, tipo_combustible, unidad, tipo_punto, grifo_interno_id)
           VALUES ($1,'Tanque R',5000,$2,'diesel_b5','gal','fijo',$3) RETURNING id`,
          [a.tenant.id, `TQ-${a.tenant.slug}`, sedeA]
        )
      ).rows[0].id;
      await cl.query(
        `INSERT INTO combustible_recepciones (tenant_id, combustible_id, grifo_id, cantidad, costo_unitario, recibido_en, compra_id)
         VALUES ($1,$2,$3,1000,15.5,now(),$4)`,
        [a.tenant.id, tanque, tanqueA, recibida.id]
      );
    });
    const choque = await admin
      .patch(`/api/erp/proveedores/compras/${recibida.id}/anular`)
      .send({ motivo: "x" });
    expect(choque.status).toBe(409);
    expect(choque.body.message).toMatch(/ya se recibió/);
  });

  it("permisos: el admin gestiona; el operador solo con el permiso; Lectura no", async () => {
    const operador = await persona(admin, a, "operador");
    const lectura = await persona(admin, a, "lectura");
    const op = await entrar(operador.email, a);
    expect((await op.post("/api/erp/proveedores/compras").send(cuerpo())).status).toBe(403);
    expect((await op.get("/api/erp/proveedores/compras/formulario")).status).toBe(403);

    // Se le da `cisternas:registrar_compra` a mano.
    const permisos = await admin.get(`/api/erp/usuarios/${operador.id}/permisos`);
    const dar = await admin.put(`/api/erp/usuarios/${operador.id}/permisos`).send({
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
            p.modulo === "combustible" && p.pestana === "cisternas:registrar_compra"
              ? true
              : p.permitido,
        })
      ),
      motivo: "Registrar compras",
    });
    expect(dar.status, JSON.stringify(dar.body)).toBe(200);
    const op2 = await entrar(operador.email, a);
    expect((await op2.post("/api/erp/proveedores/compras").send(cuerpo())).status).toBe(201);

    const lec = await entrar(lectura.email, a);
    expect((await lec.post("/api/erp/proveedores/compras").send(cuerpo())).status).toBe(403);
    expect((await lec.patch("/api/erp/proveedores/compras/1/habilitar")).status).toBe(403);
  });

  it("deja auditoría de cada cambio, con ids y sin el contenido", async () => {
    const compra = (
      await admin
        .post("/api/erp/proveedores/compras")
        .send(cuerpo({ numero_documento: "SECRETO-777" }))
    ).body;
    await admin.patch(`/api/erp/proveedores/compras/${compra.id}/habilitar`);
    await admin
      .patch(`/api/erp/proveedores/compras/${compra.id}/anular`)
      .send({ motivo: "motivo confidencial" });
    const filas = await pool.query<{ accion: string; detalle: Record<string, unknown> }>(
      `SELECT accion, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion LIKE 'proveedores.compra_%'
          AND (detalle->>'compraId')::int = $2 ORDER BY id`,
      [a.tenant.id, compra.id]
    );
    expect(filas.rows.map((f) => f.accion)).toEqual([
      "proveedores.compra_crear",
      "proveedores.compra_habilitar",
      "proveedores.compra_anular",
    ]);
    const texto = JSON.stringify(filas.rows);
    expect(texto).not.toContain("SECRETO-777");
    expect(texto).not.toContain("motivo confidencial");
  });

  it("con Combustible: lo registrado acá aparece por llegar en Cisternas, y el alcance por sede se respeta", async () => {
    const p = await proveedores(c);
    const cuerpoC = (extra: Record<string, unknown> = {}) => ({
      grifo_interno_id: p.sede,
      grifo_id: p.tanque,
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_documento: "factura",
      numero_documento: `C-${++n}-${c.tenant.slug}`,
      fecha_compra: hoy,
      llegada_estimada: dia(3),
      cantidad_facturada: 800,
      costo_unitario: 16,
      ...extra,
    });
    const nueva = await adminC.post("/api/erp/proveedores/compras").send(cuerpoC());
    expect(nueva.status, JSON.stringify(nueva.body)).toBe(201);
    await adminC.patch(`/api/erp/proveedores/compras/${nueva.body.id}/habilitar`);
    // Combustible la ve igual, por su propia pantalla: es la misma tabla.
    const enCombustible = await adminC.get("/api/erp/combustible/compras-cisterna");
    expect(enCombustible.status).toBe(200);
    const vista = (enCombustible.body as { id: string; estado: string }[]).find(
      (x) => Number(x.id) === nueva.body.id
    );
    expect(vista?.estado).toBe("por_llegar");

    // Un operador con el permiso pero asignado a OTRA sede no puede registrar en esta (404, como allá).
    const otraSede = await withTenant(c.tenant.id, async (cl) => {
      const sede = (
        await cl.query<{ id: number }>(
          `INSERT INTO sedes (tenant_id, nombre) VALUES ($1,'Sede Dos') RETURNING id`,
          [c.tenant.id]
        )
      ).rows[0].id;
      return (
        await cl.query<{ id: number }>(
          `INSERT INTO grifos_internos (tenant_id, sede_id, nombre) VALUES ($1,$2,'Grifo Dos') RETURNING id`,
          [c.tenant.id, sede]
        )
      ).rows[0].id;
    });
    const operador = await persona(adminC, c, "operador");
    const permisos = await adminC.get(`/api/erp/usuarios/${operador.id}/permisos`);
    const dar = await adminC.put(`/api/erp/usuarios/${operador.id}/permisos`).send({
      modulos: permisos.body.modulos.map(
        (m: { modulo: string; asignado: boolean; nivel: string }) => ({
          modulo: m.modulo,
          asignado: m.asignado,
          nivel: m.nivel,
        })
      ),
      pestanas: permisos.body.pestanas.map(
        (q: { modulo: string; pestana: string; permitido: boolean }) => ({
          modulo: q.modulo,
          pestana: q.pestana,
          permitido:
            q.modulo === "combustible" && q.pestana === "cisternas:registrar_compra"
              ? true
              : q.permitido,
        })
      ),
      motivo: "Registrar compras",
    });
    expect(dar.status, JSON.stringify(dar.body)).toBe(200);
    await withTenant(c.tenant.id, async (cl) => {
      await cl.query(`UPDATE usuarios SET alcance_combustible = 'asignado' WHERE id = $1`, [
        operador.id,
      ]);
      await cl.query(
        `INSERT INTO usuario_accesos_combustible (tenant_id, usuario_id, grifo_interno_id) VALUES ($1,$2,$3)`,
        [c.tenant.id, operador.id, otraSede]
      );
    });
    const op = await entrar(operador.email, c);
    expect((await op.post("/api/erp/proveedores/compras").send(cuerpoC())).status).toBe(404);
    expect(
      (await op.post("/api/erp/proveedores/compras").send(cuerpoC({ grifo_interno_id: otraSede })))
        .status
    ).toBe(201);
    // El formulario también recorta las sedes al alcance.
    const form = await op.get("/api/erp/proveedores/compras/formulario");
    expect(form.body.sedes.map((s: { id: number }) => s.id)).toEqual([otraSede]);
  });
});
