/** tests/checklists-salida-unidades.test.ts
 *
 * Salida de unidades: qué hace cada falla, quién autoriza, órdenes que no se repiten, preguntas críticas
 * obligatorias y la hora que graba «Iniciar».
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/checklists";
const OT = "/api/erp/ordenes_trabajo";
const BEARER = `Bearer ${env.platformAdminToken}`;

type Agente = ReturnType<typeof request.agent>;

describe("Checklists: salida de unidades", () => {
  const empresas: Awaited<ReturnType<typeof crearTenantDePrueba>>[] = [];

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  /** Una empresa con su admin y un segundo usuario (`otro`), para que alguien llene y otro autorice. */
  const empresaCon = async (modulos: string[]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
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
    const admin = request.agent(app);
    const login = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const dni = dniUnico();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Operador", dni, password: PASSWORD, rol: "operador" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    await withTenant(e.tenant.id, (c) =>
      c.query("UPDATE usuarios SET debe_cambiar_password = false WHERE tenant_id = $1", [
        e.tenant.id,
      ])
    );
    const entrar = async () => {
      const ag = request.agent(app);
      const res = await ag
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, identificador: dni, password: PASSWORD });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return ag;
    };
    const otroId = (
      await withTenant(e.tenant.id, (c) =>
        c.query<{ id: string }>("SELECT id FROM usuarios WHERE rol = 'operador'")
      )
    ).rows[0].id;
    return { admin, otro: await entrar(), entrar, otroId, id: e.tenant.id };
  };

  /** La casilla, dada por la misma API que usa Administración → Configuración. */
  const darCasilla = async (admin: Agente, usuarioId: string, pestana: string) => {
    const r = await admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
      modulos: [{ modulo: "checklists", asignado: true, nivel: "operar" }],
      pestanas: [{ modulo: "checklists", pestana, permitido: true }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  const formato = async (ag: Agente) => {
    const r = await ag.post(`${BASE}/plantillas`).send({
      nombre: idUnico("Volquete"),
      items: [
        { descripcion: "Frenos", critica: true },
        { descripcion: "Luces" },
        { descripcion: "Bocina" },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const llenar = (ag: Agente, plantilla_id: number, malas: string[], activo = "Horno 4") =>
    ag.post(BASE).send({
      plantilla_id,
      activo_texto: activo,
      items: ["Frenos", "Luces", "Bocina"].map((descripcion) => ({
        descripcion,
        estado: malas.includes(descripcion) ? "malo" : "bien",
      })),
    });
  const decidir = (ag: Agente, id: number, cuerpo: Record<string, unknown>) =>
    ag.patch(`${BASE}/${id}/salida`).send({ motivo: "Revisado en cancha", ...cuerpo });
  const ordenes = async (ag: Agente) => (await ag.get(OT)).body.data as Record<string, unknown>[];

  it("cada resultado deja su salida; la crítica crea una orden que no deja operar", async () => {
    const e = await empresaCon(["checklists", "ordenes_trabajo"]);
    const f = await formato(e.admin);
    expect((await llenar(e.otro, f, [])).body.salida).toBe("libre");
    expect((await llenar(e.otro, f, ["Luces"])).body.salida).toBe("por_autorizar");
    const critica = await llenar(e.otro, f, ["Frenos"]);
    expect(critica.body.salida).toBe("no_sale");
    expect(await ordenes(e.admin)).toMatchObject([
      { prioridad: "urgente", unidad_no_opera: true, id: critica.body.orden_trabajo_id },
    ]);
    const pendientes = await e.admin.get(`${BASE}?salida=por_autorizar`);
    expect(pendientes.body.data).toHaveLength(1);
  });

  it("la misma falla no repite la orden abierta; otra falla sí; cerrada, vuelve a crearse", async () => {
    const e = await empresaCon(["checklists", "ordenes_trabajo"]);
    const f = await formato(e.admin);
    const uno = await llenar(e.otro, f, ["Frenos"]);
    const dos = await llenar(e.otro, f, ["Frenos"], "  horno 4 ");
    expect(dos.body.orden_trabajo_id).toBe(uno.body.orden_trabajo_id);
    expect(await ordenes(e.admin)).toHaveLength(1);
    expect((await llenar(e.otro, f, ["Frenos"], "Horno 5")).status).toBe(201);
    expect(await ordenes(e.admin)).toHaveLength(2);

    // Falla distinta (menor, rechazada) en Horno 4: orden nueva solo con ella.
    const luces = await llenar(e.otro, f, ["Luces"]);
    const no = await decidir(e.admin, luces.body.id, { autoriza: false });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    const nueva = (await ordenes(e.admin)).find((o) => o.id === no.body.orden_trabajo_id)!;
    expect(nueva).toMatchObject({ prioridad: "alta", unidad_no_opera: true });
    expect(nueva.descripcion).toContain("Luces");
    expect(nueva.descripcion).not.toContain("Frenos");

    await e.admin.patch(`${OT}/${uno.body.orden_trabajo_id}/estado`).send({ estado: "cancelada" });
    const otra = await llenar(e.otro, f, ["Frenos"]);
    expect(otra.body.orden_trabajo_id).not.toBe(uno.body.orden_trabajo_id);
    expect(await ordenes(e.admin)).toHaveLength(4);
  });

  it("autorizar queda con quién y por qué; la orden es opcional", async () => {
    const e = await empresaCon(["checklists", "ordenes_trabajo"]);
    const f = await formato(e.admin);
    const a = await llenar(e.otro, f, ["Luces"]);
    const sin = await decidir(e.admin, a.body.id, { autoriza: true });
    expect(sin.body).toMatchObject({
      salida: "autorizada",
      salida_motivo: "Revisado en cancha",
      orden_trabajo_id: null,
    });
    expect(sin.body.salida_por_nombre).toBeTruthy();
    expect((await decidir(e.admin, a.body.id, { autoriza: false })).status).toBe(409);

    const b = await llenar(e.otro, f, ["Bocina"]);
    const con = await decidir(e.admin, b.body.id, { autoriza: true, crear_orden: true });
    expect(await ordenes(e.admin)).toMatchObject([
      { prioridad: "media", unidad_no_opera: false, id: con.body.orden_trabajo_id },
    ]);
  });

  it("sin permiso 403, el propio 403, sin motivo 400; la casilla habilita a un operador", async () => {
    const e = await empresaCon(["checklists"]);
    const f = await formato(e.admin);
    const delAdmin = await llenar(e.admin, f, ["Luces"]);
    expect((await decidir(e.otro, delAdmin.body.id, { autoriza: true })).status).toBe(403);
    expect((await decidir(e.admin, delAdmin.body.id, { autoriza: true })).status).toBe(403);
    const sinMotivo = await e.admin
      .patch(`${BASE}/${delAdmin.body.id}/salida`)
      .send({ autoriza: true });
    expect(sinMotivo.status).toBe(400);

    await darCasilla(e.admin, e.otroId, "salida:autorizar");
    // Un cambio que solo agrega rige desde la próxima sesión.
    const supervisor = await e.entrar();
    const ok = await decidir(supervisor, delAdmin.body.id, { autoriza: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    // Sin Órdenes de trabajo se decide igual.
    const otra = await llenar(e.admin, f, ["Luces"]);
    const no = await decidir(supervisor, otra.body.id, { autoriza: false });
    expect(no.body).toMatchObject({ salida: "rechazada", orden_trabajo_id: null });
  });

  it("dos decisiones a la vez: una entra; checklists iguales a la vez: una sola orden", async () => {
    const e = await empresaCon(["checklists", "ordenes_trabajo"]);
    const f = await formato(e.admin);
    const c = await llenar(e.otro, f, ["Luces"]);
    const dos = await Promise.all([
      decidir(e.admin, c.body.id, { autoriza: false }),
      decidir(e.admin, c.body.id, { autoriza: false }),
    ]);
    expect(dos.map((r) => r.status).sort()).toEqual([200, 409]);
    const seis = await Promise.all(
      Array.from({ length: 6 }, () => llenar(e.otro, f, ["Frenos"], "Faja"))
    );
    expect(seis.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(seis.map((r) => r.body.orden_trabajo_id)).size).toBe(1);
    expect(await ordenes(e.admin)).toHaveLength(2);
  });

  it("las críticas se responden, salvo con la casilla para omitirlas", async () => {
    const e = await empresaCon(["checklists", "ordenes_trabajo"]);
    const f = await formato(e.admin);
    const sinFrenos = {
      plantilla_id: f,
      activo_texto: "Horno 4",
      items: [{ descripcion: "Luces", estado: "bien" }],
    };
    const falta = await e.otro.post(BASE).send(sinFrenos);
    expect(falta.status).toBe(400);
    expect(falta.body.message).toContain("Frenos");
    // La casilla no nace ni para el admin.
    expect((await e.admin.post(BASE).send(sinFrenos)).status).toBe(400);

    await darCasilla(e.admin, e.otroId, "salida:omitir_criticas");
    const eximido = await e.entrar();
    const ok = await eximido.post(BASE).send({ ...sinFrenos, items: [] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.aviso_registro).toContain("sin responder");
    expect(ok.body.salida).toBe("libre");
  });

  it("negar una salida endurece la orden abierta que ya cubría la falla", async () => {
    const e = await empresaCon(["checklists", "ordenes_trabajo"]);
    const f = await formato(e.admin);
    const lunes = await llenar(e.otro, f, ["Luces"]);
    await decidir(e.admin, lunes.body.id, { autoriza: true, crear_orden: true });
    expect(await ordenes(e.admin)).toMatchObject([{ prioridad: "media", unidad_no_opera: false }]);
    // Autorizar otra vez la misma falla no la cambia.
    const martes = await llenar(e.otro, f, ["Luces"]);
    await decidir(e.admin, martes.body.id, { autoriza: true });
    expect(await ordenes(e.admin)).toMatchObject([{ prioridad: "media", unidad_no_opera: false }]);
    const miercoles = await llenar(e.otro, f, ["Luces"]);
    const no = await decidir(e.admin, miercoles.body.id, { autoriza: false });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(await ordenes(e.admin)).toMatchObject([
      { id: no.body.orden_trabajo_id, prioridad: "alta", unidad_no_opera: true },
    ]);
  });

  it("decisiones y checklists de la misma unidad a la vez: sin 500 ni órdenes repetidas", async () => {
    const e = await empresaCon(["checklists", "ordenes_trabajo", "mantenimiento"]);
    const f = await formato(e.admin);
    const alta = await e.admin
      .post("/api/erp/mantenimiento/equipos")
      .send({ placa_codigo: idUnico("U").slice(-12), tipo: "volquete" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const deLaUnidad = (malas: string[], valor: number) =>
      e.otro.post(BASE).send({
        plantilla_id: f,
        equipo_id: alta.body.id,
        lectura: { valor },
        items: ["Frenos", "Luces", "Bocina"].map((descripcion) => ({
          descripcion,
          estado: malas.includes(descripcion) ? "malo" : "bien",
        })),
      });
    const pendientes = [];
    for (let i = 0; i < 4; i++) pendientes.push((await deLaUnidad(["Luces"], 10)).body.id);
    const r = await Promise.all([
      ...pendientes.map((id) => decidir(e.admin, id, { autoriza: false })),
      ...Array.from({ length: 4 }, () => deLaUnidad(["Frenos"], 20)),
    ]);
    expect(
      r.map((x) => x.status),
      JSON.stringify(r.map((x) => x.body))
    ).toEqual([200, 200, 200, 200, 201, 201, 201, 201]);
    const lista = await ordenes(e.admin);
    expect(lista.map((o) => o.prioridad).sort()).toEqual(["alta", "urgente"]);
  });

  it("no decide lo ajeno, lo que no espera, ni quien solo consulta; id enorme 404", async () => {
    const e = await empresaCon(["checklists"]);
    const ajena = await empresaCon(["checklists"]);
    const f = await formato(e.admin);
    const libre = await llenar(e.otro, f, []);
    const espera = await llenar(e.otro, f, ["Luces"]);
    const critica = await llenar(e.otro, f, ["Frenos"]);
    expect((await decidir(e.admin, libre.body.id, { autoriza: true })).status).toBe(409);
    expect((await decidir(e.admin, critica.body.id, { autoriza: true })).status).toBe(409);
    expect((await decidir(ajena.admin, espera.body.id, { autoriza: true })).status).toBe(404);
    expect((await decidir(e.admin, 99999999999, { autoriza: true })).status).toBe(404);
    expect((await decidir(e.admin, espera.body.id, { autoriza: "si" })).status).toBe(400);
    // La casilla no basta si el módulo está en «Consultas».
    const r = await e.admin.put(`/api/erp/usuarios/${e.otroId}/permisos`).send({
      modulos: [{ modulo: "checklists", asignado: true, nivel: "consultas" }],
      pestanas: [{ modulo: "checklists", pestana: "salida:autorizar", permitido: true }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const delAdmin = await llenar(e.admin, f, ["Luces"]);
    const consulta = await e.entrar();
    expect((await decidir(consulta, delAdmin.body.id, { autoriza: true })).status).toBe(403);
  });

  it("guardar los permisos del administrador no lo exime de las críticas", async () => {
    const e = await empresaCon(["checklists"]);
    const dueno = empresas.find((x) => x.tenant.id === e.id)!.usuario.id;
    const segundo = await e.admin.get(`/api/erp/usuarios/${dueno}/permisos`);
    expect(segundo.status).toBe(200);
    const casillas = (
      segundo.body.pestanas as { modulo: string; pestana: string; permitido: boolean }[]
    ).filter((p) => p.modulo === "checklists");
    expect(casillas).toMatchObject([
      { pestana: "salida:autorizar", permitido: true },
      { pestana: "salida:omitir_criticas", permitido: false },
    ]);
  });

  it("«Iniciar» graba la hora sola y respeta la escrita", async () => {
    const e = await empresaCon(["ordenes_trabajo"]);
    const crear = async (extra = {}) =>
      (await e.admin.post(OT).send({ activo_texto: "Faja", titulo: "Revisar", ...extra })).body.id;
    const sola = await e.admin
      .patch(`${OT}/${await crear()}/estado`)
      .send({ estado: "en_progreso" });
    expect(sola.body.inicio_en).not.toBeNull();
    const escrita = new Date(Date.now() - 7_200_000).toISOString();
    const id = await crear({ inicio_en: escrita });
    const r = await e.admin.patch(`${OT}/${id}/estado`).send({ estado: "en_progreso" });
    expect(r.body.inicio_en).toBe(escrita);
  });

  it("al clonar el respaldo, la orden sigue cubriendo su falla", async () => {
    const e = await empresaCon(["checklists", "ordenes_trabajo"]);
    const f = await formato(e.admin);
    await llenar(e.otro, f, ["Frenos"]);
    const destino = await empresaCon(["checklists", "ordenes_trabajo"]);
    const backup = await request(app)
      .post(`/api/platform/tenants/${e.id}/backups`)
      .set("Authorization", BEARER);
    expect(backup.status).toBe(201);
    const restaurado = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.id, confirmar: true });
    expect(restaurado.status, JSON.stringify(restaurado.body)).toBe(200);
    const copia = await withTenant(destino.id, (c) =>
      c.query(
        `SELECT h.descripcion FROM orden_trabajo_hallazgos h
           JOIN ordenes_trabajo o ON o.id = h.orden_trabajo_id AND o.tenant_id = h.tenant_id
           JOIN checklists k ON k.id = h.checklist_id AND k.tenant_id = h.tenant_id`
      )
    );
    expect(copia.rows).toEqual([{ descripcion: "Frenos" }]);
  });
});
