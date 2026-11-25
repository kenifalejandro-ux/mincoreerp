/** tests/maestro-unidades-sin-flota.test.ts
 *
 * Las unidades (`equipos`) son un maestro único: las mantiene Flota (Registro de unidades) o
 * Mantenimiento. Checklists, Órdenes de trabajo e IPERC las ofrecen para elegir si la persona tiene
 * CUALQUIERA de los dos módulos, no solo Flota. Lo que se fija:
 *
 * 1. Con Mantenimiento y SIN Flota, `GET /<módulo>/unidades` lista las unidades de Mantenimiento
 *    (solo id, placa y tipo) y un checklist y una orden de trabajo se pueden crear con esa unidad.
 * 2. Sin ninguno de los dos módulos la lista sale vacía (200, no 403) y mandar `equipo_id` da 400.
 * 3. Con Flota todo sigue igual.
 * 4. Una unidad quitada en Mantenimiento deja de ofrecerse; la lista no trae datos del conductor.
 * 5. Otra empresa no ve estas unidades.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("el maestro de unidades llega a Checklists, Órdenes de trabajo e IPERC sin Flota", () => {
  const empresas: Empresa[] = [];

  const nueva = async (modulos: string[]) => {
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
    return e;
  };
  // Los módulos del usuario viajan en el JWT: se entra después de fijar los módulos.
  const sesion = async (e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  type Agente = Awaited<ReturnType<typeof sesion>>;

  const unidadDeMantenimiento = async (ag: Agente) => {
    const placa = `MU-${randomUUID().slice(0, 6).toUpperCase()}`;
    const r = await ag.post("/api/erp/mantenimiento/equipos").send({
      placa_codigo: placa,
      tipo: "Volquete",
      medidor: "horometro",
      lectura: 100,
      propiedad: "propia",
      conductor_nombre: "No debe salir",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: Number(r.body.id), placa };
  };
  const unidadesDe = async (ag: Agente, modulo: string) => {
    const r = await ag.get(`/api/erp/${modulo}/unidades?page=1&pageSize=200`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as { id: number; placa_codigo: string; tipo: string }[];
  };
  const plantilla = async (ag: Agente) => {
    const r = await ag.post("/api/erp/checklists/plantillas").send({
      nombre: idUnico("Pre-uso"),
      items: [{ descripcion: "Frenos" }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("con Mantenimiento y sin Flota se listan y se eligen las unidades en los tres módulos", async () => {
    const e = await nueva(["mantenimiento", "checklists", "ordenes_trabajo", "iperc"]);
    const ag = await sesion(e);
    // De verdad no tiene Flota: su lista de equipos no existe para esta persona.
    expect((await ag.get("/api/erp/equipos")).status).toBe(403);
    const u = await unidadDeMantenimiento(ag);

    for (const modulo of ["checklists", "ordenes_trabajo", "iperc"]) {
      const lista = await unidadesDe(ag, modulo);
      const mia = lista.find((x) => x.id === u.id);
      expect(mia, `${modulo} no ofrece la unidad`).toBeDefined();
      // Solo lo necesario para elegir: nada del conductor ni de medidores.
      expect(Object.keys(mia!).sort()).toEqual(["id", "placa_codigo", "tipo"]);
    }

    const plantillaId = await plantilla(ag);
    const checklist = await ag.post("/api/erp/checklists").send({
      plantilla_id: plantillaId,
      equipo_id: u.id,
      items: [{ descripcion: "Frenos", estado: "bien" }],
    });
    expect(checklist.status, JSON.stringify(checklist.body)).toBe(201);
    expect(checklist.body.equipo_id).toBe(u.id);
    const detalle = await ag.get(`/api/erp/checklists/${checklist.body.id}`);
    expect(detalle.body.placa_codigo).toBe(u.placa);

    const orden = await ag
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: u.id, titulo: "Cambiar frenos" });
    expect(orden.status, JSON.stringify(orden.body)).toBe(201);
    expect(orden.body.equipo_id).toBe(u.id);
    const ordenes = await ag.get("/api/erp/ordenes_trabajo");
    expect(
      ordenes.body.data.find((o: { id: number }) => o.id === orden.body.id)?.placa_codigo
    ).toBe(u.placa);
  });

  it("sin ningún módulo de unidades la lista sale vacía (no 403) y elegir una unidad da 400", async () => {
    const e = await nueva(["checklists", "ordenes_trabajo", "iperc"]);
    const ag = await sesion(e);
    for (const modulo of ["checklists", "ordenes_trabajo", "iperc"]) {
      expect(await unidadesDe(ag, modulo)).toEqual([]);
    }
    const plantillaId = await plantilla(ag);
    const checklist = await ag.post("/api/erp/checklists").send({
      plantilla_id: plantillaId,
      equipo_id: 1,
      items: [{ descripcion: "Frenos", estado: "bien" }],
    });
    expect(checklist.status).toBe(400);
    const orden = await ag.post("/api/erp/ordenes_trabajo").send({ equipo_id: 1, titulo: "X" });
    expect(orden.status).toBe(400);
  });

  it("con Flota las unidades se siguen ofreciendo en los tres módulos", async () => {
    const e = await nueva(["flota", "checklists", "ordenes_trabajo", "iperc"]);
    const ag = await sesion(e);
    const placa = `FL-${randomUUID().slice(0, 6).toUpperCase()}`;
    const alta = await ag
      .post("/api/erp/equipos")
      .send({ placa_codigo: placa, tipo: "Camión", marca: "VOLVO" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    for (const modulo of ["checklists", "ordenes_trabajo", "iperc"]) {
      const lista = await unidadesDe(ag, modulo);
      expect(lista.map((x) => x.placa_codigo)).toContain(placa);
    }
  });

  it("una unidad quitada en Mantenimiento deja de ofrecerse", async () => {
    const e = await nueva(["mantenimiento", "checklists"]);
    const ag = await sesion(e);
    const u = await unidadDeMantenimiento(ag);
    expect((await unidadesDe(ag, "checklists")).map((x) => x.id)).toContain(u.id);
    const quitar = await ag
      .patch(`/api/erp/mantenimiento/equipos/${u.id}/quitar`)
      .send({ motivo: "Vendido" });
    expect(quitar.status, JSON.stringify(quitar.body)).toBe(200);
    expect((await unidadesDe(ag, "checklists")).map((x) => x.id)).not.toContain(u.id);
  });

  it("llegan todas las unidades, también pasadas las 200 de una página", async () => {
    const e = await nueva(["mantenimiento", "checklists", "ordenes_trabajo", "iperc"]);
    const ag = await sesion(e);
    await withTenant(e.tenant.id, (client) =>
      client.query(
        `INSERT INTO equipos (tenant_id, placa_codigo, tipo)
         SELECT $1, 'MAS-' || lpad(n::text, 4, '0'), 'Volquete' FROM generate_series(1, 230) n`,
        [e.tenant.id]
      )
    );
    for (const modulo of ["checklists", "ordenes_trabajo", "iperc"]) {
      const lista = await unidadesDe(ag, modulo);
      expect(lista, modulo).toHaveLength(230);
      expect(lista.at(-1)?.placa_codigo).toBe("MAS-0230");
    }
  });

  it("otra empresa no ve las unidades de la primera", async () => {
    const a = await nueva(["mantenimiento", "checklists"]);
    const b = await nueva(["mantenimiento", "checklists"]);
    const agA = await sesion(a);
    const agB = await sesion(b);
    const u = await unidadDeMantenimiento(agA);
    expect((await unidadesDe(agA, "checklists")).map((x) => x.id)).toContain(u.id);
    expect((await unidadesDe(agB, "checklists")).map((x) => x.id)).not.toContain(u.id);
  });
});
