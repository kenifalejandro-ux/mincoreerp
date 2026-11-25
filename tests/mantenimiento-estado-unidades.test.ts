/** tests/mantenimiento-estado-unidades.test.ts
 *
 * M5: el estado de cada unidad (Detenida / En mantenimiento / Operativa) calculado desde órdenes y checklists,
 * y la autonomía: cada fuente cuenta solo si la persona tiene su módulo.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const PASSWORD = "ClaveDePrueba123";
const CK = "/api/erp/checklists";
const OT = "/api/erp/ordenes_trabajo";
const MANT = "/api/erp/mantenimiento/equipos";
const TODO = ["mantenimiento", "checklists", "ordenes_trabajo"];

describe("Mantenimiento: estado de cada unidad (M5)", () => {
  const empresas: Awaited<ReturnType<typeof crearTenantDePrueba>>[] = [];

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  const empresaCon = async (modulos: string[]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    const habilitar = async (lista: string[]) => {
      const r = await request(app)
        .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
        .set("Authorization", `Bearer ${env.platformAdminToken}`)
        .send({
          configuraciones: MODULOS.map((m) => ({
            modulo: m.id,
            estado: lista.includes(m.id) ? "habilitado" : "deshabilitado",
          })),
        });
      expect(r.status).toBe(200);
      const ag = request.agent(app);
      const login = await ag
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
      expect(login.status).toBe(200);
      return ag;
    };
    return { ag: await habilitar(modulos), habilitar };
  };
  type Agente = Awaited<ReturnType<typeof empresaCon>>["ag"];

  const unidad = async (ag: Agente) => {
    const r = await ag.post(MANT).send({ placa_codigo: idUnico("U").slice(-12), tipo: "volquete" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const estadoDe = async (ag: Agente, id: number) => {
    const r = await ag.get(MANT);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const e = (r.body.equipos as { id: number; estado: string; motivo: string | null }[]).find(
      (x) => x.id === id
    )!;
    return { estado: e.estado, motivo: e.motivo };
  };
  const orden = async (ag: Agente, equipo_id: number, extra: Record<string, unknown> = {}) => {
    const r = await ag.post(OT).send({ equipo_id, titulo: "Revisar faja", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const pasar = (ag: Agente, id: number, estado: string) =>
    ag.patch(`${OT}/${id}/estado`).send({ estado });
  const formato = async (ag: Agente) => {
    const r = await ag.post(`${CK}/plantillas`).send({
      nombre: idUnico("Pre-uso"),
      items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const llenar = async (ag: Agente, plantilla_id: number, equipo_id: number, mala?: string) => {
    const r = await ag.post(CK).send({
      plantilla_id,
      equipo_id,
      items: ["Frenos", "Luces"].map((descripcion) => ({
        descripcion,
        estado: descripcion === mala ? "malo" : "bien",
      })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };

  it("las órdenes mandan: urgente o «no opera» detiene; en progreso, en mantenimiento", async () => {
    const { ag } = await empresaCon(TODO);
    const id = await unidad(ag);
    expect(await estadoDe(ag, id)).toEqual({ estado: "operativa", motivo: null });
    const normal = await orden(ag, id);
    expect((await estadoDe(ag, id)).estado).toBe("operativa");
    await pasar(ag, normal, "en_progreso");
    expect(await estadoDe(ag, id)).toMatchObject({ estado: "en_mantenimiento" });
    const urgente = await orden(ag, id, { prioridad: "urgente", titulo: "Frenos rotos" });
    expect(await estadoDe(ag, id)).toEqual({
      estado: "detenida",
      motivo: `OT #${urgente}: Frenos rotos`,
    });
    await pasar(ag, urgente, "cancelada");
    await pasar(ag, normal, "completada");
    expect((await estadoDe(ag, id)).estado).toBe("operativa");
    await orden(ag, id, { prioridad: "baja", unidad_no_opera: true });
    expect((await estadoDe(ag, id)).estado).toBe("detenida");
  });

  it("falla crítica: detenida hasta cerrar su orden, aunque el checklist siga siendo el último", async () => {
    const { ag } = await empresaCon(TODO);
    const id = await unidad(ag);
    const c = await llenar(ag, await formato(ag), id, "Frenos");
    expect(await estadoDe(ag, id)).toMatchObject({ estado: "detenida" });
    await pasar(ag, c.orden_trabajo_id, "cancelada");
    expect((await estadoDe(ag, id)).estado).toBe("operativa");
  });

  it("falla menor: espera autorización; un checklist limpio posterior la libera", async () => {
    const { ag } = await empresaCon(TODO);
    const id = await unidad(ag);
    const f = await formato(ag);
    await llenar(ag, f, id, "Luces");
    expect(await estadoDe(ag, id)).toEqual({
      estado: "detenida",
      motivo: "Espera autorización: Luces",
    });
    await llenar(ag, f, id);
    expect((await estadoDe(ag, id)).estado).toBe("operativa");
  });

  it("sin Órdenes de trabajo cuenta el checklist; sin Checklists, las órdenes; sin ambos, operativa", async () => {
    const e = await empresaCon(TODO);
    const id = await unidad(e.ag);
    await llenar(e.ag, await formato(e.ag), id, "Frenos");
    const soloChecklists = await e.habilitar(["mantenimiento", "checklists"]);
    expect(await estadoDe(soloChecklists, id)).toEqual({
      estado: "detenida",
      motivo: "Checklist: no sale: Frenos",
    });
    const soloOrdenes = await e.habilitar(["mantenimiento", "ordenes_trabajo"]);
    expect((await estadoDe(soloOrdenes, id)).motivo).toMatch(/^OT #/);
    const solo = await e.habilitar(["mantenimiento"]);
    expect(await estadoDe(solo, id)).toEqual({ estado: "operativa", motivo: null });
  });

  it("negada: detenida; autorizada: operativa, también si dejó una orden para después", async () => {
    const e = await empresaCon(TODO);
    const id = await unidad(e.ag);
    const f = await formato(e.ag);
    // Decide otra persona: el checklist se deja a nombre de quien no es el administrador.
    const decidir = async (autoriza: boolean) => {
      const c = await llenar(e.ag, f, id, "Luces");
      const empresa = empresas[empresas.length - 1];
      await withTenant(empresa.tenant.id, async (cl) => {
        const otro = await cl.query<{ id: string }>(
          `INSERT INTO usuarios (tenant_id, nombre, email, password_hash, rol)
           VALUES ($1, 'Otro', $2, 'x', 'operador') RETURNING id`,
          [empresa.tenant.id, `${idUnico("otro")}@mincoreerp.test`]
        );
        await cl.query("UPDATE checklists SET usuario_id = $1 WHERE id = $2", [
          otro.rows[0].id,
          c.id,
        ]);
      });
      const r = await e.ag
        .patch(`${CK}/${c.id}/salida`)
        .send({ autoriza, motivo: "Revisado", crear_orden: autoriza });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    await decidir(true);
    expect((await estadoDe(e.ag, id)).estado).toBe("operativa");
    const negada = await decidir(false);
    expect(await estadoDe(e.ag, id)).toMatchObject({ estado: "detenida" });
    await pasar(e.ag, negada.orden_trabajo_id, "cancelada");
    expect((await estadoDe(e.ag, id)).estado).toBe("operativa");
  });

  it("la misma crítica repetida sigue a su orden; borrar la orden devuelve la detención", async () => {
    const { ag } = await empresaCon(TODO);
    const id = await unidad(ag);
    const f = await formato(ag);
    const uno = await llenar(ag, f, id, "Frenos");
    await llenar(ag, f, id, "Frenos");
    await pasar(ag, uno.orden_trabajo_id, "cancelada");
    expect((await estadoDe(ag, id)).estado).toBe("operativa");
    expect((await ag.delete(`${OT}/${uno.orden_trabajo_id}`)).status).toBe(200);
    // Sin orden que la explique, vuelve a mandar el último checklist.
    expect((await estadoDe(ag, id)).motivo).toBe("Checklist: no sale: Frenos");
  });

  it("con 40,000 checklists la lista sigue respondiendo rápido", async () => {
    const { ag } = await empresaCon(TODO);
    const id = await unidad(ag);
    await llenar(ag, await formato(ag), id, "Luces");
    const tenant = empresas[empresas.length - 1].tenant.id;
    await withTenant(tenant, (c) =>
      c.query(
        `INSERT INTO checklists (tenant_id, equipo_id, plantilla_id, usuario_id, salida)
         SELECT k.tenant_id, k.equipo_id, k.plantilla_id, k.usuario_id, 'libre'
           FROM checklists k, generate_series(1, 40000) WHERE k.tenant_id = $1`,
        [tenant]
      )
    );
    const inicio = Date.now();
    expect((await estadoDe(ag, id)).estado).toBe("operativa");
    const ms = Date.now() - inicio;
    console.info(`lista con 40k checklists: ${ms} ms`);
    expect(ms).toBeLessThan(2000);
  });

  it("no se cruza entre empresas", async () => {
    const a = await empresaCon(TODO);
    const b = await empresaCon(TODO);
    const deA = await unidad(a.ag);
    const deB = await unidad(b.ag);
    await orden(a.ag, deA, { prioridad: "urgente" });
    expect((await estadoDe(b.ag, deB)).estado).toBe("operativa");
    expect((await b.ag.get(MANT)).body.equipos).toHaveLength(1);
  });
});
