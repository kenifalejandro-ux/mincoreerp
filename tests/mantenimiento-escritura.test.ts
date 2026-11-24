/** tests/mantenimiento-escritura.test.ts
 *
 * Ecosistema «Gestión de mantenimiento», etapa 2 de M1: alta, edición y baja de equipos, y las áreas.
 *
 * 1. Con SOLO `mantenimiento`: alta con y sin área; un reintento con el mismo `cliente_uuid` no duplica.
 * 2. Validaciones: placa y tipo obligatorios, lectura no negativa, medidor y propiedad conocidos, área ajena.
 * 3. Placa repetida entre equipos activos (sin mirar mayúsculas) es 409; quitar un equipo libera su placa.
 * 4. Editar cambia lo que se manda; quitar pide motivo y el equipo sale de la lista.
 * 5. Áreas: alta, nombre repetido es 409, con equipos no se quita (409), sin equipos sí.
 * 6. Permisos: admin y operador escriben, Lectura solo mira; otra empresa no ve ni toca nada.
 * 7. Auditoría: quién, qué ids y los campos cambiados, sin los valores; quitar guarda el motivo.
 */
import { randomUUID } from "node:crypto";

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import { fijarCuotaTenant } from "../src/server/services/platformCuotas.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

describe("Mantenimiento: equipos y áreas (escritura)", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;
  let operador: Agente;
  let lectura: Agente;

  const habilitar = async (e: Empresa) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "mantenimiento" ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const entrarAdmin = async (e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const persona = async (rol: string) => {
    const dni = dniUnico();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password: PASSWORD, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, identificador: dni, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const equipo = (extra: Record<string, unknown> = {}) => ({
    placa_codigo: `PL-${randomUUID().slice(0, 6).toUpperCase()}`,
    tipo: "Volquete",
    marca: "VOLVO",
    medidor: "horometro",
    lectura: 1200.5,
    propiedad: "propia",
    ...extra,
  });
  const crear = (ag: Agente, extra: Record<string, unknown> = {}) =>
    ag.post("/api/erp/mantenimiento/equipos").send(equipo(extra));
  const lista = async (ag: Agente = admin) =>
    (await ag.get("/api/erp/mantenimiento/equipos")).body.equipos as {
      id: number;
      placa_codigo: string;
      area: string | null;
    }[];

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await habilitar(a);
    await habilitar(b);
    admin = await entrarAdmin(a);
    adminB = await entrarAdmin(b);
    operador = await persona("operador");
    lectura = await persona("lectura");
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("alta de un equipo con solo Mantenimiento, con y sin área", async () => {
    const area = await admin.post("/api/erp/mantenimiento/areas").send({ nombre: "Cantera" });
    expect(area.status, JSON.stringify(area.body)).toBe(201);
    const con = await crear(admin, { placa_codigo: "AKM-739", area_id: area.body.id });
    expect(con.status, JSON.stringify(con.body)).toBe(201);
    expect(con.body).toMatchObject({
      placa_codigo: "AKM-739",
      tipo: "Volquete",
      area: "Cantera",
      lectura: 1200.5,
      por_completar: false,
    });
    const sin = await crear(admin, { placa_codigo: "CEB-860", marca: "", modelo: undefined });
    expect(sin.status).toBe(201);
    expect(sin.body).toMatchObject({ area: null, area_id: null, marca: null, modelo: null });
    expect((await lista()).map((e) => e.placa_codigo)).toEqual(
      expect.arrayContaining(["AKM-739", "CEB-860"])
    );
  });

  it("un reintento con el mismo cliente_uuid no duplica el equipo", async () => {
    const cliente_uuid = randomUUID();
    const placa = `UUID-${randomUUID().slice(0, 4).toUpperCase()}`;
    const primero = await crear(admin, { cliente_uuid, placa_codigo: placa });
    const segundo = await crear(admin, { cliente_uuid, placa_codigo: placa });
    expect(primero.status).toBe(201);
    expect(segundo.status).toBe(200);
    expect(segundo.body.id).toBe(primero.body.id);
    expect((await lista()).filter((e) => e.placa_codigo === placa)).toHaveLength(1);
  });

  it("validaciones: placa y tipo obligatorios, lectura no negativa, valores conocidos", async () => {
    expect((await crear(admin, { placa_codigo: "  " })).status).toBe(400);
    expect((await crear(admin, { tipo: "" })).status).toBe(400);
    expect((await crear(admin, { lectura: -1 })).status).toBe(400);
    expect((await crear(admin, { medidor: "pies" })).status).toBe(400);
    expect((await crear(admin, { propiedad: "prestada" })).status).toBe(400);
    expect((await crear(admin, { area_id: 99999999 })).status).toBe(400);
  });

  it("una placa repetida es 409 sin mirar mayúsculas, y quitar el equipo la libera", async () => {
    const placa = `DUP-${randomUUID().slice(0, 4).toUpperCase()}`;
    const original = await crear(admin, { placa_codigo: placa });
    expect(original.status).toBe(201);
    const repetida = await crear(admin, { placa_codigo: placa.toLowerCase() });
    expect(repetida.status).toBe(409);
    expect(repetida.body.message ?? repetida.body.error).toMatch(/Ya hay un equipo/);
    const quitar = await admin
      .patch(`/api/erp/mantenimiento/equipos/${original.body.id}/quitar`)
      .send({ motivo: "Se vendió" });
    expect(quitar.status, JSON.stringify(quitar.body)).toBe(200);
    expect((await crear(admin, { placa_codigo: placa })).status).toBe(201);
  });

  it("editar cambia lo que se manda; no se puede tomar la placa de otro equipo", async () => {
    const uno = (await crear(admin)).body;
    const otro = (await crear(admin)).body;
    const editado = await admin
      .put(`/api/erp/mantenimiento/equipos/${uno.id}`)
      .send(equipo({ placa_codigo: uno.placa_codigo, tipo: "Camión", lectura: 3000 }));
    expect(editado.status, JSON.stringify(editado.body)).toBe(200);
    // La lectura NO se edita aquí (se registra con las reglas de las lecturas): se ignora.
    expect(editado.body).toMatchObject({ tipo: "Camión", lectura: 1200.5 });
    const choque = await admin
      .put(`/api/erp/mantenimiento/equipos/${uno.id}`)
      .send(equipo({ placa_codigo: otro.placa_codigo }));
    expect(choque.status).toBe(409);
    // Con su propia placa no choca consigo mismo.
    const igual = await admin
      .put(`/api/erp/mantenimiento/equipos/${uno.id}`)
      .send(equipo({ placa_codigo: uno.placa_codigo }));
    expect(igual.status).toBe(200);
    expect((await admin.put("/api/erp/mantenimiento/equipos/99999999").send(equipo())).status).toBe(
      404
    );
  });

  it("quitar pide el motivo y el equipo sale de la lista", async () => {
    const e = (await crear(admin)).body;
    const ruta = `/api/erp/mantenimiento/equipos/${e.id}/quitar`;
    expect((await admin.patch(ruta).send({})).status).toBe(400);
    expect((await admin.patch(ruta).send({ motivo: "ab" })).status).toBe(400);
    expect((await admin.patch(ruta).send({ motivo: "Dado de baja" })).status).toBe(200);
    expect((await lista()).some((x) => x.id === e.id)).toBe(false);
    expect((await admin.patch(ruta).send({ motivo: "Otra vez" })).status).toBe(404);
  });

  it("áreas: alta, nombre repetido es 409, con equipos no se quita y sin equipos sí", async () => {
    const nombre = `Taller ${randomUUID().slice(0, 4)}`;
    const area = await admin.post("/api/erp/mantenimiento/areas").send({ nombre });
    expect(area.status).toBe(201);
    expect(
      (await admin.post("/api/erp/mantenimiento/areas").send({ nombre: nombre.toUpperCase() }))
        .status
    ).toBe(409);
    expect((await admin.post("/api/erp/mantenimiento/areas").send({ nombre: " " })).status).toBe(
      400
    );
    const e = (await crear(admin, { area_id: area.body.id })).body;

    const conteo = (await admin.get("/api/erp/mantenimiento/areas")).body as {
      id: number;
      equipos: number;
    }[];
    expect(conteo.find((x) => x.id === area.body.id)!.equipos).toBe(1);

    const bloqueado = await admin.delete(`/api/erp/mantenimiento/areas/${area.body.id}`);
    expect(bloqueado.status).toBe(409);
    expect(bloqueado.body.message ?? bloqueado.body.error).toMatch(/1 equipo/);

    await admin
      .put(`/api/erp/mantenimiento/equipos/${e.id}`)
      .send(equipo({ placa_codigo: e.placa_codigo, area_id: null }));
    expect((await admin.delete(`/api/erp/mantenimiento/areas/${area.body.id}`)).status).toBe(200);
    expect((await admin.delete(`/api/erp/mantenimiento/areas/${area.body.id}`)).status).toBe(404);
  });

  it("permisos: el operador escribe, Lectura solo mira", async () => {
    expect((await crear(operador)).status).toBe(201);
    expect(
      (
        await operador
          .post("/api/erp/mantenimiento/areas")
          .send({ nombre: `Op ${randomUUID().slice(0, 4)}` })
      ).status
    ).toBe(201);
    expect((await lectura.get("/api/erp/mantenimiento/equipos")).status).toBe(200);
    expect((await crear(lectura)).status).toBe(403);
    expect((await lectura.post("/api/erp/mantenimiento/areas").send({ nombre: "No" })).status).toBe(
      403
    );
  });

  it("otra empresa no ve ni toca los equipos y áreas de la primera", async () => {
    const e = (await crear(admin)).body;
    const area = (
      await admin
        .post("/api/erp/mantenimiento/areas")
        .send({ nombre: `Solo A ${randomUUID().slice(0, 4)}` })
    ).body;
    expect(await lista(adminB)).toEqual([]);
    expect((await adminB.get("/api/erp/mantenimiento/areas")).body).toEqual([]);
    expect((await adminB.put(`/api/erp/mantenimiento/equipos/${e.id}`).send(equipo())).status).toBe(
      404
    );
    expect(
      (
        await adminB
          .patch(`/api/erp/mantenimiento/equipos/${e.id}/quitar`)
          .send({ motivo: "Intento" })
      ).status
    ).toBe(404);
    expect((await adminB.delete(`/api/erp/mantenimiento/areas/${area.id}`)).status).toBe(404);
    // Ni usar un área de A al crear un equipo en B.
    expect((await crear(adminB, { area_id: area.id })).status).toBe(400);
    expect((await lista()).some((x) => x.id === e.id)).toBe(true);
  });

  it("auditoría: quién y qué ids, sin los valores; quitar guarda el motivo", async () => {
    const placa = `AUD-${randomUUID().slice(0, 4).toUpperCase()}`;
    const e = (await crear(admin, { placa_codigo: placa, marca: "MARCA-SECRETA" })).body;
    await admin
      .put(`/api/erp/mantenimiento/equipos/${e.id}`)
      .send(equipo({ placa_codigo: placa, marca: "MARCA-SECRETA", tipo: "Cargador", lectura: 77 }));
    await admin
      .patch(`/api/erp/mantenimiento/equipos/${e.id}/quitar`)
      .send({ motivo: "Chatarra por accidente" });
    const r = await pool.query<{ accion: string; detalle: Record<string, unknown> }>(
      `SELECT accion, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion LIKE 'mantenimiento.%' AND (detalle->>'equipoId')::int = $2
        ORDER BY id`,
      [a.tenant.id, e.id]
    );
    expect(r.rows.map((x) => x.accion)).toEqual([
      "mantenimiento.equipo_crear",
      "mantenimiento.equipo_actualizar",
      "mantenimiento.equipo_quitar",
    ]);
    expect(r.rows[1].detalle.campos).toEqual(["tipo"]);
    expect(r.rows[2].detalle.motivo).toBe("Chatarra por accidente");
    const texto = JSON.stringify(r.rows);
    expect(texto).not.toContain("MARCA-SECRETA");
    expect(texto).not.toContain(placa);
  });

  it("volver a registrar la placa de un equipo quitado lo reactiva: es la misma unidad y conserva su historial", async () => {
    const placa = `REA-${randomUUID().slice(0, 4).toUpperCase()}`;
    const original = (await crear(admin, { placa_codigo: placa, lectura: 100 })).body;
    await admin
      .patch(`/api/erp/mantenimiento/equipos/${original.id}/quitar`)
      .send({ motivo: "Se vendió" });
    const otra = await crear(admin, { placa_codigo: placa, tipo: "Camión", lectura: 999 });
    expect(otra.status, JSON.stringify(otra.body)).toBe(201);
    expect(otra.body.id).toBe(original.id);
    expect(otra.body.tipo).toBe("Camión");
    // No se escribe una lectura nueva: manda la que tenía (la unidad ya tiene su historial).
    expect(otra.body.lectura).toBe(100);
    const filas = await withTenant(a.tenant.id, (cl) =>
      cl.query(
        "SELECT count(*)::int AS n FROM equipos WHERE tenant_id = $1 AND placa_codigo = $2",
        [a.tenant.id, placa]
      )
    );
    expect(filas.rows[0].n).toBe(1);
  });

  it("los equipos de Mantenimiento cuentan contra el tope de unidades de la empresa", async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    await habilitar(e);
    await fijarCuotaTenant(e.tenant.id, "mantenimiento_equipos", 2);
    const ag = await entrarAdmin(e);
    expect((await crear(ag)).status).toBe(201);
    expect((await crear(ag)).status).toBe(201);
    const rechazado = await crear(ag);
    expect(rechazado.status).toBe(403);
    expect(rechazado.body.error).toBe("cuota_excedida");
    expect(rechazado.body.recurso).toBe("mantenimiento_equipos");
    // Importar cuenta una unidad por fila: con el tope lleno, no entra ninguna.
    const importar = await ag
      .post("/api/erp/mantenimiento/equipos/bulk")
      .send([{ placa_codigo: "BULK-1", tipo: "Volquete" }]);
    expect(importar.status).toBe(403);
    // Las áreas no crecen ese recurso: se pueden crear con el tope lleno.
    expect((await ag.post("/api/erp/mantenimiento/areas").send({ nombre: "Taller" })).status).toBe(
      201
    );
  });

  it("hay un solo maestro: un equipo creado en Mantenimiento lo ve «Registro de unidades» (Flota) y al revés", async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: ["mantenimiento", "flota"].includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
    const ag = await entrarAdmin(e);
    const desdeMantenimiento = await crear(ag, { placa_codigo: "UNA-1", tipo: "Volquete" });
    expect(desdeMantenimiento.status).toBe(201);
    const enFlota = await ag.get("/api/erp/equipos");
    expect(enFlota.status, JSON.stringify(enFlota.body)).toBe(200);
    const filasFlota = (enFlota.body.data ?? enFlota.body) as { placa_codigo: string }[];
    expect(filasFlota.map((f) => f.placa_codigo)).toContain("UNA-1");

    const desdeFlota = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: "OTRA-2", tipo: "Camioneta" });
    expect(desdeFlota.status, JSON.stringify(desdeFlota.body)).toBe(201);
    expect(
      (await ag.get("/api/erp/mantenimiento/equipos")).body.equipos.map(
        (f: { placa_codigo: string }) => f.placa_codigo
      )
    ).toEqual(expect.arrayContaining(["UNA-1", "OTRA-2"]));
  });
});
