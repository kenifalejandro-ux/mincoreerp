/** Lecturas mínimas del formulario de despacho: proveedores de ruta y precio
 *  vigente para quien registra despachos (conductor, grifero) sin tener las
 *  pestañas Proveedores ni Precios. El catálogo completo sigue cerrado
 *  (ver combustible-precios-permisos.test.ts). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  app,
  crearTenantDePrueba,
  borrarTenantDePrueba,
  idUnico,
  cargarPrecioCombustible,
} from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("lectura del formulario de despacho", () => {
  const password = "ClaveDePrueba123";
  const base = "/api/erp/combustible";
  const admin = request.agent(app);
  const adminOtro = request.agent(app);
  let tenantId: string;
  let tenantOtroId: string;
  let slug: string;
  let tanque: number;
  let grifoRuta: number;
  let grifoSoloTanque: number;
  let grifoInactivo: number;
  let grifoOtroTenant: number;
  let seq = 0;

  async function persona(rol: string) {
    const agente = request.agent(app);
    const dni = String(86900000 + Math.floor(Math.random() * 90000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `F ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const entrar = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entrar.status).toBe(200);
    return agente;
  }

  async function grifo(agente: request.Agent, nombre: string, ruta: boolean, tanqueFlag: boolean) {
    const r = await agente
      .post(`${base}/grifos`)
      .send({ nombre, abastece_ruta: ruta, abastece_tanque: tanqueFlag });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });

    const o = await crearTenantDePrueba(password);
    tenantOtroId = o.tenant.id;
    await adminOtro
      .post("/api/auth/login")
      .send({ tenantSlug: o.tenant.slug, email: o.usuario.email, password });

    tanque = await withTenant(tenantId, async (client) => {
      const f = await client.query(
        `INSERT INTO combustible (tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total)
         VALUES ($1,$2,'Tanque form','diesel_b5','gal','fijo',5000) RETURNING id`,
        [tenantId, idUnico("TQ")]
      );
      return f.rows[0].id;
    });

    grifoRuta = await grifo(admin, "Grifo Ruta Form", true, false);
    grifoSoloTanque = await grifo(admin, "Grifo Solo Tanque Form", false, true);
    grifoInactivo = await grifo(admin, "Grifo Inactivo Form", true, false);
    await admin.put(`${base}/grifos/${grifoInactivo}`).send({
      nombre: "Grifo Inactivo Form",
      activo: false,
      abastece_ruta: true,
      abastece_tanque: false,
      abastece_urea: false,
      abastece_urea_ruta: false,
    });
    grifoOtroTenant = await grifo(adminOtro, "Grifo De Otro Tenant", true, false);

    for (const body of [
      { tipo_combustible: "diesel_b5", grifo_id: grifoRuta, precio_unitario: 17.5 },
      { tipo_combustible: "diesel_b5", combustible_id: tanque, precio_unitario: 12.25 },
    ]) {
      const p = await cargarPrecioCombustible(admin, body);
      expect(p.status, JSON.stringify(p.body)).toBe(201);
    }
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(tenantOtroId);
    await closeDatabase();
  });

  const vigente = (a: request.Agent, destino: string) =>
    a.get(
      `${base}/precios/vigente-formulario?tipo_combustible=diesel_b5&${destino}&fecha=${encodeURIComponent(new Date().toISOString())}`
    );

  it("conductor y grifero ven solo id y nombre de los proveedores de ruta activos de su tenant", async () => {
    for (const rol of ["conductor_ruta", "grifero"]) {
      const r = await (await persona(rol)).get(`${base}/grifos/para-formulario`);
      expect(r.status, rol).toBe(200);
      expect(r.body, rol).toEqual([{ id: grifoRuta, nombre: "Grifo Ruta Form" }]);
      const ids = r.body.map((g: { id: number }) => g.id);
      expect(ids).not.toContain(grifoSoloTanque);
      expect(ids).not.toContain(grifoInactivo);
      expect(ids).not.toContain(grifoOtroTenant);
    }
  });

  it("el precio vigente del formulario devuelve solo el precio unitario", async () => {
    const conductor = await persona("conductor_ruta");
    const r = await vigente(conductor, `grifo_id=${grifoRuta}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ precio: { precio_unitario: expect.anything() } });
    expect(Number(r.body.precio.precio_unitario)).toBe(17.5);
  });

  it("sin precio cargado devuelve precio null (se puede registrar con el C.U. a mano)", async () => {
    const conductor = await persona("conductor_ruta");
    const r = await vigente(conductor, `grifo_id=${grifoSoloTanque}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ precio: null });
  });

  it("no ve el precio de un proveedor de otro tenant", async () => {
    await cargarPrecioCombustible(adminOtro, {
      tipo_combustible: "diesel_b5",
      grifo_id: grifoOtroTenant,
      precio_unitario: 99,
    });
    const r = await vigente(await persona("conductor_ruta"), `grifo_id=${grifoOtroTenant}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ precio: null });
  });

  it("el grifero ve el precio de su tanque; el conductor no", async () => {
    const grifero = await vigente(await persona("grifero"), `combustible_id=${tanque}`);
    expect(grifero.status).toBe(200);
    expect(Number(grifero.body.precio.precio_unitario)).toBe(12.25);
    const conductor = await vigente(await persona("conductor_ruta"), `combustible_id=${tanque}`);
    expect(conductor.status).toBe(403);
  });

  it("el formulario no da el precio de un proveedor inactivo ni de uno que no es de ruta", async () => {
    // Por SQL: la API ya no deja cargar precio a un proveedor que no es de
    // ruta, pero un precio viejo de un proveedor que dejó de serlo sí puede
    // existir, y el formulario no debe ofrecerlo.
    for (const id of [grifoInactivo, grifoSoloTanque]) {
      await withTenant(tenantId, (client) =>
        client.query(
          `INSERT INTO combustible_precios (tenant_id, tipo_combustible, grifo_id, precio_unitario, vigente_desde)
           VALUES ($1, 'diesel_b5', $2, 55, now())`,
          [tenantId, id]
        )
      );
    }
    const conductor = await persona("conductor_ruta");
    for (const id of [grifoInactivo, grifoSoloTanque]) {
      const r = await vigente(conductor, `grifo_id=${id}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ precio: null });
    }
  });

  it("un precio anulado no se ofrece: el formulario devuelve el anterior", async () => {
    const nuevo = await cargarPrecioCombustible(admin, {
      tipo_combustible: "diesel_b5",
      grifo_id: grifoRuta,
      precio_unitario: 20,
      vigente_desde: new Date(Date.now() - 1000).toISOString(),
    });
    expect(nuevo.status, JSON.stringify(nuevo.body)).toBe(201);
    const conductor = await persona("conductor_ruta");
    const antes = await vigente(conductor, `grifo_id=${grifoRuta}`);
    expect(Number(antes.body.precio.precio_unitario)).toBe(20);

    const anular = await admin
      .patch(`${base}/precios/${nuevo.body.id}/anular`)
      .send({ motivo: "precio mal cargado" });
    expect(anular.status, JSON.stringify(anular.body)).toBe(200);
    const despues = await vigente(conductor, `grifo_id=${grifoRuta}`);
    expect(Number(despues.body.precio.precio_unitario)).toBe(17.5);
  });

  it("el conductor no obtiene el costo de un tanque con ninguna forma de combustible_id", async () => {
    const conductor = await persona("conductor_ruta");
    const fecha = encodeURIComponent(new Date().toISOString());
    const variantes = [
      `combustible_id=${tanque}`,
      `combustible_id=%20${tanque}`,
      `combustible_id=${tanque}.0`,
      `combustible_id=%2B${tanque}`,
      `combustible_id=${tanque}&combustible_id=${tanque}`,
      `combustible_id[]=${tanque}`,
      `combustible_id[a]=${tanque}`,
      `COMBUSTIBLE_ID=${tanque}`,
      `combustible_id=${tanque}&grifo_id=${grifoRuta}`,
    ];
    for (const q of variantes) {
      const r = await conductor.get(
        `${base}/precios/vigente-formulario?tipo_combustible=diesel_b5&${q}&fecha=${fecha}`
      );
      expect(JSON.stringify(r.body), q).not.toContain("12.25");
    }
  });

  it("entrada mal formada da 400, no 500, en el endpoint del formulario y en el completo", async () => {
    const fecha = encodeURIComponent(new Date().toISOString());
    const malos = [
      `tipo_combustible=diesel_b5&grifo_id=${grifoRuta}&fecha=abc`,
      `tipo_combustible=diesel_b5&grifo_id=${grifoRuta}&fecha=0000-01-01`,
      `tipo_combustible=diesel_b5&grifo_id=${grifoRuta}&fecha=9999-12-31`,
      `tipo_combustible=veneno&grifo_id=${grifoRuta}&fecha=${fecha}`,
      `tipo_combustible=diesel_b5&grifo_id=NaN&fecha=${fecha}`,
      `tipo_combustible=diesel_b5&grifo_id=abc&fecha=${fecha}`,
      `tipo_combustible=diesel_b5&grifo_id=1.5&fecha=${fecha}`,
      `tipo_combustible=diesel_b5&grifo_id=Infinity&fecha=${fecha}`,
      `tipo_combustible=diesel_b5&grifo_id=99999999999999999999&fecha=${fecha}`,
      `tipo_combustible=diesel_b5&combustible_id=2147483648&fecha=${fecha}`,
    ];
    const conductor = await persona("conductor_ruta");
    for (const q of malos) {
      expect((await conductor.get(`${base}/precios/vigente-formulario?${q}`)).status, q).toBe(400);
      expect((await admin.get(`${base}/precios/vigente?${q}`)).status, q).toBe(400);
    }
    // Gemelo legítimo: un id que no existe sigue siendo "sin precio", no un error.
    for (const id of ["0", "-1", "1000"]) {
      const r = await admin.get(
        `${base}/precios/vigente?tipo_combustible=diesel_b5&grifo_id=${id}&fecha=${fecha}`
      );
      expect(r.status, id).toBe(200);
      expect(r.body).toEqual({ precio: null });
    }
    // Y el caso válido sigue dando su precio.
    expect((await vigente(conductor, `grifo_id=${grifoRuta}`)).status).toBe(200);
  });

  it("parámetros inválidos: sin destino o con los dos, 400", async () => {
    const conductor = await persona("conductor_ruta");
    expect((await vigente(conductor, "")).status).toBe(400);
    expect(
      (await vigente(conductor, `grifo_id=${grifoRuta}&combustible_id=${tanque}`)).status
    ).toBe(400);
  });

  it("Lectura y el encargado de urea no entran a ninguno de los dos", async () => {
    for (const rol of ["lectura", "encargado_urea"]) {
      const a = await persona(rol);
      expect((await a.get(`${base}/grifos/para-formulario`)).status, rol).toBe(403);
      expect((await vigente(a, `grifo_id=${grifoRuta}`)).status, rol).toBe(403);
    }
  });

  it("los endpoints completos siguen cerrados para conductor y grifero", async () => {
    for (const rol of ["conductor_ruta", "grifero"]) {
      const a = await persona(rol);
      expect((await a.get(`${base}/grifos`)).status, rol).toBe(403);
      expect(
        (
          await a.get(
            `${base}/precios/vigente?tipo_combustible=diesel_b5&grifo_id=${grifoRuta}&fecha=${encodeURIComponent(new Date().toISOString())}`
          )
        ).status,
        rol
      ).toBe(403);
    }
  });
});
