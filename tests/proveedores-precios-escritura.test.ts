/** tests/proveedores-precios-escritura.test.ts
 *
 * Gestión comercial (PR4b): cargar y anular precios de PROVEEDORES desde el ecosistema (combustible de ruta
 * y urea). Las reglas son las de Combustible (se reutiliza CombustibleService); lo que se fija es que el
 * ecosistema las aplica igual y que una empresa SOLO con Proveedores puede cargar sus precios.
 *
 * 1. Sin Combustible: el formulario trae los proveedores y las presentaciones; se cargan precios de combustible
 *    (varios proveedores a la vez) y de urea; el precio nuevo pasa a ser el vigente y el anterior queda.
 * 2. Reglas: solo proveedores de ruta activos (combustible) o que vendan urea con presentación activa (urea);
 *    nada de tanques; rangos y fechas válidos.
 * 3. Anular pide motivo; 404 si no existe o es de un tanque; 409 si ya estaba anulado; al anular rige el anterior.
 * 4. Permisos por producto (`tanques:precios`, `urea:precios`) y rol admin/operador; Lectura no.
 * 5. Auditoría con el precio y los ids; lo cargado acá lo ve Combustible → Precios; otra empresa no puede anularlo.
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
interface Fila {
  producto: string;
  codigo: string;
  proveedorId: number;
  vigente: { precio: number } | null;
  anterior: { precio: number } | null;
  historial: { id: number; precio: number; anulado: boolean; motivo: string | null }[];
}

describe("Gestión comercial: cargar y anular precios de proveedores", () => {
  const empresas: Empresa[] = [];
  let a: Empresa; // solo Proveedores
  let b: Empresa; // otra empresa
  let c: Empresa; // Proveedores + Combustible
  let admin: Agente;
  let adminB: Agente;
  let adminC: Agente;
  let ruta1: number;
  let ruta2: number;
  let soloTanque: number;
  let rutaInactivo: number;
  let ureaProv: number;
  let sinUrea: number;
  let tanquePrecioId: number;

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
      const nuevo = async (
        nombre: string,
        f: { ruta?: boolean; tanque?: boolean; urea?: boolean; activo?: boolean }
      ) =>
        (
          await cl.query<{ id: number }>(
            `INSERT INTO combustible_grifos
               (tenant_id, nombre, abastece_ruta, abastece_tanque, abastece_urea_ruta, activo)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [e.tenant.id, nombre, !!f.ruta, !!f.tanque, !!f.urea, f.activo ?? true]
          )
        ).rows[0].id;
      return {
        ruta1: await nuevo("RUTA UNO", { ruta: true }),
        ruta2: await nuevo("RUTA DOS", { ruta: true }),
        soloTanque: await nuevo("SOLO TANQUE", { tanque: true }),
        rutaInactivo: await nuevo("RUTA INACTIVO", { ruta: true, activo: false }),
        ureaProv: await nuevo("UREA PROV", { urea: true }),
        sinUrea: await nuevo("SIN UREA", { ruta: true }),
      };
    });
  const filas = async (ag: Agente) =>
    (await ag.get("/api/erp/proveedores/precios")).body.filas as Fila[];
  const dia = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
  const comb = (extra: Record<string, unknown> = {}) => ({
    tipo_combustible: "diesel_b5",
    grifo_ids: [ruta1],
    precio_unitario: 15.8,
    ...extra,
  });

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    c = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b, c);
    await modulos(a, ["proveedores"]);
    await modulos(b, ["proveedores"]);
    await modulos(c, ["proveedores", "combustible"]);
    const p = await proveedores(a);
    ({ ruta1, ruta2, soloTanque, rutaInactivo, ureaProv, sinUrea } = p);
    admin = await entrar(a.usuario.email, a);
    adminB = await entrar(b.usuario.email, b);
    adminC = await entrar(c.usuario.email, c);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("sin Combustible: el formulario trae proveedores y presentaciones, y se cargan precios que pasan a regir", async () => {
    const form = await admin.get("/api/erp/proveedores/precios/formulario");
    expect(form.status, JSON.stringify(form.body)).toBe(200);
    expect(form.body).toMatchObject({ combustible: true, urea: true });
    expect(form.body.proveedoresCombustible.map((x: { id: number }) => x.id).sort()).toEqual(
      [ruta1, ruta2, sinUrea].sort()
    );
    expect(form.body.proveedoresUrea.map((x: { id: number }) => x.id)).toEqual([ureaProv]);
    expect(form.body.presentaciones.map((x: { codigo: string }) => x.codigo)).toContain("caja");

    // Varios proveedores a la vez: todo o nada, con la misma fecha.
    const masivo = await admin
      .post("/api/erp/proveedores/precios/combustible")
      .send(comb({ grifo_ids: [ruta1, ruta2], precio_unitario: 15.8, vigente_desde: dia(-10) }));
    expect(masivo.status, JSON.stringify(masivo.body)).toBe(201);
    expect(masivo.body).toHaveLength(2);

    // Un precio nuevo pasa a ser el vigente y el anterior queda para la variación.
    expect(
      (
        await admin
          .post("/api/erp/proveedores/precios/combustible")
          .send(comb({ precio_unitario: 16.6, vigente_desde: dia(-1) }))
      ).status
    ).toBe(201);
    const fila = (await filas(admin)).find(
      (f) => f.proveedorId === ruta1 && f.codigo === "diesel_b5"
    )!;
    expect(fila.vigente?.precio).toBe(16.6);
    expect(fila.anterior?.precio).toBe(15.8);

    const urea = await admin.post("/api/erp/proveedores/precios/urea").send({
      grifo_id: ureaProv,
      presentacion: "caja",
      marca: "Green 32",
      precio_por_bulto: 78,
    });
    expect(urea.status, JSON.stringify(urea.body)).toBe(201);
    const filaUrea = (await filas(admin)).find(
      (f) => f.proveedorId === ureaProv && f.codigo === "caja"
    )!;
    expect(filaUrea.vigente?.precio).toBe(78);
  });

  it("las reglas de Combustible: solo proveedores de ruta activos y nada de tanques", async () => {
    const post = (cuerpo: object) =>
      admin.post("/api/erp/proveedores/precios/combustible").send(cuerpo);
    const deTanque = await post(comb({ grifo_ids: [soloTanque] }));
    expect(deTanque.status).toBe(400);
    expect(deTanque.body.message).toMatch(/no está marcado como proveedor de ruta/);
    const inactivo = await post(comb({ grifo_ids: [rutaInactivo] }));
    expect(inactivo.status).toBe(400);
    expect(inactivo.body.message).toMatch(/proveedor de ruta activo/);
    expect((await post(comb({ grifo_ids: [999999999] }))).status).toBe(400);
    // Un precio a un tanque no se carga desde acá.
    expect((await post({ ...comb(), grifo_ids: undefined, combustible_ids: [1] })).status).toBe(
      400
    );
    for (const mala of [
      { precio_unitario: 0 },
      { precio_unitario: 200000 },
      { tipo_combustible: "agua" },
      { grifo_ids: [ruta1, ruta1] },
      { grifo_ids: [] },
      { vigente_desde: dia(800) },
    ]) {
      expect((await post(comb(mala))).status, JSON.stringify(mala)).toBe(400);
    }
    // Atómico: si uno de varios falla, no se carga ninguno.
    const antes = (await filas(admin)).find((f) => f.proveedorId === ruta2)!.historial.length;
    expect((await post(comb({ grifo_ids: [ruta2, soloTanque] }))).status).toBe(400);
    const despues = (await filas(admin)).find((f) => f.proveedorId === ruta2)!.historial.length;
    expect(despues).toBe(antes);
  });

  it("urea: el proveedor tiene que vender urea y la presentación existir y estar activa", async () => {
    const post = (cuerpo: object) =>
      admin.post("/api/erp/proveedores/precios/urea").send({
        grifo_id: ureaProv,
        presentacion: "caja",
        precio_por_bulto: 80,
        ...cuerpo,
      });
    const noVende = await post({ grifo_id: sinUrea });
    expect(noVende.status).toBe(400);
    expect(noVende.body.message).toMatch(/no está marcado como proveedor de urea/);
    const sinPres = await post({ presentacion: "zzz" });
    expect(sinPres.status).toBe(400);
    expect(sinPres.body.message).toMatch(/no existe en esta empresa/);
    for (const mala of [{ precio_por_bulto: -1 }, { precio_por_bulto: 0 }, { grifo_id: 0 }]) {
      expect((await post(mala)).status, JSON.stringify(mala)).toBe(400);
    }
  });

  it("anular pide motivo, vuelve a regir el anterior, y 404 / 409 según el caso", async () => {
    const fila = (await filas(admin)).find(
      (f) => f.proveedorId === ruta1 && f.codigo === "diesel_b5"
    )!;
    const vigenteId = fila.historial.find((h) => h.precio === 16.6)!.id;
    const anular = (id: number, cuerpo: object = { motivo: "mal tipeado" }) =>
      admin.patch(`/api/erp/proveedores/precios/combustible/${id}/anular`).send(cuerpo);
    expect((await anular(vigenteId, { motivo: "  " })).status).toBe(400);
    expect((await anular(vigenteId)).status).toBe(200);
    expect((await anular(vigenteId)).status).toBe(409);
    expect((await anular(999999999)).status).toBe(404);
    const despues = (await filas(admin)).find(
      (f) => f.proveedorId === ruta1 && f.codigo === "diesel_b5"
    )!;
    expect(despues.vigente?.precio).toBe(15.8);
    expect(despues.historial.find((h) => h.id === vigenteId)).toMatchObject({
      anulado: true,
      motivo: "mal tipeado",
    });

    // Un precio de TANQUE (venta interna) no se anula desde el ecosistema.
    tanquePrecioId = await withTenant(a.tenant.id, async (cl) => {
      const tanque = (
        await cl.query<{ id: number }>(
          `INSERT INTO combustible (tenant_id, tanque_nombre, capacidad_total, codigo, tipo_combustible, unidad, tipo_punto, grifo_interno_id)
           VALUES ($1,'Tanque P',5000,$2,'diesel_b5','gal','fijo',(SELECT id FROM grifos_internos WHERE tenant_id=$1 LIMIT 1)) RETURNING id`,
          [a.tenant.id, `TQ-${a.tenant.slug}`]
        )
      ).rows[0].id;
      return (
        await cl.query<{ id: number }>(
          `INSERT INTO combustible_precios (tenant_id, tipo_combustible, combustible_id, precio_unitario, vigente_desde)
           VALUES ($1,'diesel_b5',$2,16,now()) RETURNING id`,
          [a.tenant.id, tanque]
        )
      ).rows[0].id;
    });
    expect((await anular(tanquePrecioId)).status).toBe(404);

    // Urea: lo mismo.
    const urea = (await filas(admin)).find(
      (f) => f.proveedorId === ureaProv && f.codigo === "caja"
    )!;
    const ureaId = urea.historial[0].id;
    const anularUrea = (id: number, cuerpo: object = { motivo: "error" }) =>
      admin.patch(`/api/erp/proveedores/precios/urea/${id}/anular`).send(cuerpo);
    expect((await anularUrea(ureaId, {})).status).toBe(400);
    expect((await anularUrea(ureaId)).status).toBe(200);
    expect((await anularUrea(ureaId)).status).toBe(409);
    expect((await anularUrea(999999999)).status).toBe(404);
  });

  it("permisos: el operador carga según sus pestañas de Precios; Lectura no", async () => {
    const operador = await persona(admin, a, "operador");
    const lectura = await persona(admin, a, "lectura");
    const op = await entrar(operador.email, a);
    expect((await op.post("/api/erp/proveedores/precios/combustible").send(comb())).status).toBe(
      201
    );

    const lec = await entrar(lectura.email, a);
    expect((await lec.post("/api/erp/proveedores/precios/combustible").send(comb())).status).toBe(
      403
    );
    expect((await lec.get("/api/erp/proveedores/precios/formulario")).status).toBe(403);

    // Se le quita «Precios» de combustible a mano: solo queda la urea.
    const permisos = await admin.get(`/api/erp/usuarios/${operador.id}/permisos`);
    const recorte = await admin.put(`/api/erp/usuarios/${operador.id}/permisos`).send({
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
    const solo = await entrar(operador.email, a);
    expect((await solo.post("/api/erp/proveedores/precios/combustible").send(comb())).status).toBe(
      403
    );
    const form = await solo.get("/api/erp/proveedores/precios/formulario");
    expect(form.body).toMatchObject({ combustible: false, urea: true, proveedoresCombustible: [] });
    expect(
      (
        await solo
          .post("/api/erp/proveedores/precios/urea")
          .send({ grifo_id: ureaProv, presentacion: "caja", precio_por_bulto: 79 })
      ).status
    ).toBe(201);
  });

  it("deja auditoría con el precio y los ids", async () => {
    await admin
      .post("/api/erp/proveedores/precios/combustible")
      .send(comb({ grifo_ids: [ruta2], precio_unitario: 17.25 }));
    const filasAuditoria = await pool.query<{ accion: string; detalle: Record<string, unknown> }>(
      `SELECT accion, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion IN ('proveedores.precio_crear','proveedores.precio_anular')
        ORDER BY id`,
      [a.tenant.id]
    );
    const crear = filasAuditoria.rows.filter((f) => f.accion === "proveedores.precio_crear");
    const anular = filasAuditoria.rows.filter((f) => f.accion === "proveedores.precio_anular");
    expect(crear.length).toBeGreaterThanOrEqual(5);
    expect(anular.length).toBe(2);
    expect(
      crear.some((f) => f.detalle.precioUnitario === 17.25 && f.detalle.proveedorId === ruta2)
    ).toBe(true);
    expect(anular.every((f) => typeof f.detalle.motivo === "string")).toBe(true);
  });

  it("con Combustible lo cargado acá lo ve Combustible → Precios; otra empresa no puede anularlo", async () => {
    const p = await proveedores(c);
    const nuevo = await adminC
      .post("/api/erp/proveedores/precios/combustible")
      .send({ tipo_combustible: "gasolina_90", grifo_ids: [p.ruta1], precio_unitario: 18.4 });
    expect(nuevo.status, JSON.stringify(nuevo.body)).toBe(201);
    const enCombustible = await adminC.get("/api/erp/combustible/precios");
    expect(enCombustible.status).toBe(200);
    expect(
      (enCombustible.body as { id: number; grifo_id: number; precio_unitario: string }[]).some(
        (x) =>
          x.id === nuevo.body[0].id && x.grifo_id === p.ruta1 && Number(x.precio_unitario) === 18.4
      )
    ).toBe(true);

    // Un precio de la empresa A no se anula desde la empresa B (404, no se revela que existe).
    const deA = (await filas(admin)).find((f) => f.proveedorId === ruta2)!.historial[0].id;
    expect(
      (
        await adminB
          .patch(`/api/erp/proveedores/precios/combustible/${deA}/anular`)
          .send({ motivo: "ajeno" })
      ).status
    ).toBe(404);
  });
});
