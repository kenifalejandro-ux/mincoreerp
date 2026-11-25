/** tests/checklists-no-apta-orden-lectura.test.ts
 *
 * E5-2: falla en un punto crítico → «no apta» + orden de trabajo automática; lectura del medidor opcional.
 *
 * 1. El resultado lo decide el servidor con la versión del formato usada.
 * 2. La orden solo nace con falla crítica, con Órdenes de trabajo y con la regla de Mantenimiento encendida.
 * 3. El reintento del mismo envío no duplica checklist, orden ni lectura.
 * 4. Una lectura rechazada no hace perder el checklist.
 */
import { randomUUID } from "node:crypto";

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import { fijarCuotaTenant } from "../src/server/services/platformCuotas.service";

const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/checklists";

describe("Checklists: no apta, orden automática y lectura (E5-2)", () => {
  const empresas: Awaited<ReturnType<typeof crearTenantDePrueba>>[] = [];

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  const empresaCon = async (modulos: string[]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: modulos.includes(m.id) ? "habilitado" : "deshabilitado",
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
  type Agente = Awaited<ReturnType<typeof empresaCon>>;

  const formato = async (ag: Agente) => {
    const r = await ag.post(`${BASE}/plantillas`).send({
      nombre: idUnico("Volquete"),
      items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const unidad = async (ag: Agente) => {
    const r = await ag
      .post("/api/erp/mantenimiento/equipos")
      .send({ placa_codigo: idUnico("U").slice(-12), tipo: "volquete" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const llenado = (
    plantilla_id: number,
    malo: "Frenos" | "Luces" | null,
    extra: Record<string, unknown> = {}
  ) => ({
    plantilla_id,
    activo_texto: "Horno 4",
    items: ["Frenos", "Luces"].map((descripcion) => ({
      descripcion,
      estado: descripcion === malo ? "malo" : "bien",
    })),
    ...extra,
  });
  const ordenes = async (ag: Agente) => {
    const r = await ag.get("/api/erp/ordenes_trabajo");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as Record<string, unknown>[];
  };

  it("falla crítica: no apta y una sola orden urgente, aun con reenvío", async () => {
    const ag = await empresaCon(["checklists", "ordenes_trabajo"]);
    const id = await formato(ag);
    const cuerpo = llenado(id, "Frenos", { cliente_uuid: randomUUID() });

    const primero = await ag.post(BASE).send(cuerpo);
    expect(primero.status, JSON.stringify(primero.body)).toBe(201);
    expect(primero.body.resultado).toBe("no_apta");
    const segundo = await ag.post(BASE).send(cuerpo);
    expect(segundo.status).toBe(200);
    expect(segundo.body.orden_trabajo_id).toBe(primero.body.orden_trabajo_id);

    const lista = await ordenes(ag);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      id: primero.body.orden_trabajo_id,
      origen: "checklist",
      checklist_id: primero.body.id,
      prioridad: "urgente",
      tipo: "correctivo",
      activo_texto: "Horno 4",
    });

    // Borrar el checklist deja la orden, sin el enlace.
    expect((await ag.delete(`${BASE}/${primero.body.id}`)).status).toBe(200);
    expect((await ordenes(ag))[0]).toMatchObject({ origen: "checklist", checklist_id: null });
  });

  it("falla no crítica o sin fallas: sin orden; el dispositivo no decide qué es crítico", async () => {
    const ag = await empresaCon(["checklists", "ordenes_trabajo"]);
    const id = await formato(ag);
    const observado = await ag.post(BASE).send(llenado(id, "Luces"));
    expect(observado.body.resultado).toBe("observado");
    expect((await ag.post(BASE).send(llenado(id, null))).body.resultado).toBe("bien");

    const mintiendo = llenado(id, "Frenos");
    mintiendo.items = mintiendo.items.map((i) => ({ ...i, critica: false }));
    expect((await ag.post(BASE).send(mintiendo)).body.resultado).toBe("no_apta");
    expect(await ordenes(ag)).toHaveLength(1);
  });

  it("vale la versión con que se llenó, no la vigente", async () => {
    const ag = await empresaCon(["checklists"]);
    const id = await formato(ag);
    const editar = await ag.put(`${BASE}/plantillas/${id}`).send({
      version_base: 1,
      cambio: "Frenos deja de ser crítico",
      nombre: "Volquete",
      items: [{ descripcion: "Frenos" }, { descripcion: "Luces" }],
    });
    expect(editar.status, JSON.stringify(editar.body)).toBe(200);
    const vieja = await ag.post(BASE).send(llenado(id, "Frenos", { plantilla_version: 1 }));
    expect(vieja.body.resultado).toBe("no_apta");
    const nueva = await ag.post(BASE).send(llenado(id, "Frenos"));
    expect(nueva.body.resultado).toBe("observado");
  });

  it("sin Órdenes de trabajo: no apta y sin orden", async () => {
    const ag = await empresaCon(["checklists"]);
    const id = await formato(ag);
    const r = await ag.post(BASE).send(llenado(id, "Frenos"));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ resultado: "no_apta", orden_trabajo_id: null });
  });

  it("con la cuota de órdenes llena, la orden crítica se crea igual; la manual no", async () => {
    const ag = await empresaCon(["checklists", "ordenes_trabajo"]);
    const empresa = empresas[empresas.length - 1].tenant.id;
    await fijarCuotaTenant(empresa, "ordenes_trabajo", 0);
    const id = await formato(ag);
    const r = await ag.post(BASE).send(llenado(id, "Frenos"));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.orden_trabajo_id).toEqual(expect.any(Number));
    const manual = await ag
      .post("/api/erp/ordenes_trabajo")
      .send({ activo_texto: "Horno 4", titulo: "Revisar", tipo: "correctivo", prioridad: "alta" });
    expect(manual.status, JSON.stringify(manual.body)).toBe(403);
    expect(await ordenes(ag)).toHaveLength(1);
  });

  it("la regla de Mantenimiento apagada no genera la orden", async () => {
    const ag = await empresaCon(["checklists", "ordenes_trabajo", "mantenimiento"]);
    const regla = await ag.put("/api/erp/mantenimiento/config").send({ ot_de_hallazgo: false });
    expect(regla.status, JSON.stringify(regla.body)).toBe(200);
    const id = await formato(ag);
    const r = await ag.post(BASE).send(llenado(id, "Frenos"));
    expect(r.body).toMatchObject({ resultado: "no_apta", orden_trabajo_id: null });
    expect(await ordenes(ag)).toHaveLength(0);
  });

  it("la lectura queda con origen «checklist» una sola vez; si retrocede, el checklist se guarda con aviso", async () => {
    const ag = await empresaCon(["checklists", "mantenimiento"]);
    const id = await formato(ag);
    const equipo_id = await unidad(ag);
    const cuerpo = llenado(id, null, {
      equipo_id,
      cliente_uuid: randomUUID(),
      lectura: { valor: 500 },
    });
    const ok = await ag.post(BASE).send(cuerpo);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ lectura_valor: 500, aviso_registro: null });
    expect((await ag.post(BASE).send(cuerpo)).status).toBe(200);

    const menor = await ag
      .post(BASE)
      .send(llenado(id, null, { equipo_id, lectura: { valor: 100 } }));
    expect(menor.status, JSON.stringify(menor.body)).toBe(201);
    expect(menor.body.aviso_registro).toContain("menor");
    expect((await ag.get(`${BASE}/${menor.body.id}`)).body.aviso_registro).toContain("menor");

    const empresa = empresas[empresas.length - 1].tenant.id;
    const filas = await withTenant(empresa, (c) =>
      c.query("SELECT valor::float8 AS valor, origen FROM equipo_lecturas WHERE equipo_id = $1", [
        equipo_id,
      ])
    );
    expect(filas.rows).toEqual([{ valor: 500, origen: "checklist" }]);
  });

  it("un reloj adelantado no hace perder el checklist; la lista muestra la orden", async () => {
    const ag = await empresaCon(["checklists", "mantenimiento", "ordenes_trabajo"]);
    const id = await formato(ag);
    const equipo_id = await unidad(ag);
    const leido_en = new Date(Date.now() + 3_600_000).toISOString();
    const r = await ag
      .post(BASE)
      .send(llenado(id, "Frenos", { equipo_id, lectura: { valor: 7, leido_en } }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.aviso_registro).toBeNull();
    const lista = await ag.get(BASE);
    expect(lista.body.data[0].orden_trabajo_id).toBe(r.body.orden_trabajo_id);
  });

  const empresaActual = () => empresas[empresas.length - 1].tenant.id;
  const contar = async (tabla: "checklists" | "ordenes_trabajo" | "equipo_lecturas") =>
    (
      await withTenant(empresaActual(), (c) =>
        c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`)
      )
    ).rows[0].n;

  it("varios envíos a la vez de la misma unidad: entran todos, sin bloqueo mutuo", async () => {
    const ag = await empresaCon(["checklists", "mantenimiento", "ordenes_trabajo"]);
    const id = await formato(ag);
    const equipo_id = await unidad(ag);
    for (let ronda = 1; ronda <= 3; ronda++) {
      const respuestas = await Promise.all(
        Array.from({ length: 6 }, () =>
          ag.post(BASE).send(llenado(id, "Frenos", { equipo_id, lectura: { valor: ronda * 10 } }))
        )
      );
      expect(
        respuestas.map((r) => r.status),
        JSON.stringify(respuestas.map((r) => r.body))
      ).toEqual(Array(6).fill(201));
    }
    expect(await contar("checklists")).toBe(18);
    expect(await contar("ordenes_trabajo")).toBe(18);
  });

  it("el mismo envío repetido a la vez crea un checklist, una orden y una lectura", async () => {
    const ag = await empresaCon(["checklists", "mantenimiento", "ordenes_trabajo"]);
    const id = await formato(ag);
    const equipo_id = await unidad(ag);
    const antes = await contar("equipo_lecturas");
    const cuerpo = llenado(id, "Frenos", {
      equipo_id,
      lectura: { valor: 50 },
      cliente_uuid: randomUUID(),
    });
    const respuestas = await Promise.all(
      Array.from({ length: 5 }, () => ag.post(BASE).send(cuerpo))
    );
    expect(respuestas.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await contar("checklists")).toBe(1);
    expect(await contar("ordenes_trabajo")).toBe(1);
    expect((await contar("equipo_lecturas")) - antes).toBe(1);
  });

  it("con la cuota de lecturas llena, el checklist entra con aviso", async () => {
    const ag = await empresaCon(["checklists", "mantenimiento"]);
    const id = await formato(ag);
    const equipo_id = await unidad(ag);
    await fijarCuotaTenant(empresaActual(), "equipo_lecturas", 0);
    const r = await ag.post(BASE).send(llenado(id, null, { equipo_id, lectura: { valor: 5 } }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.aviso_registro).toContain("límite de lecturas");
    expect(await contar("equipo_lecturas")).toBe(0);
  });

  it("al clonar el respaldo a otra empresa, la orden apunta al checklist copiado", async () => {
    const ag = await empresaCon(["checklists", "ordenes_trabajo"]);
    const origen = empresaActual();
    const id = await formato(ag);
    const llenadoEnOrigen = await ag.post(BASE).send(llenado(id, "Frenos"));
    expect(llenadoEnOrigen.status).toBe(201);
    const destino = await crearTenantDePrueba(PASSWORD);
    empresas.push(destino);
    const bearer = `Bearer ${env.platformAdminToken}`;
    const backup = await request(app)
      .post(`/api/platform/tenants/${origen}/backups`)
      .set("Authorization", bearer);
    expect(backup.status, JSON.stringify(backup.body)).toBe(201);
    const restaurado = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", bearer)
      .send({ targetTenantId: destino.tenant.id, confirmar: true });
    expect(restaurado.status, JSON.stringify(restaurado.body)).toBe(200);
    const copia = await withTenant(destino.tenant.id, (c) =>
      c.query(
        `SELECT o.origen, c.resultado, i.critica
           FROM ordenes_trabajo o
           JOIN checklists c ON c.id = o.checklist_id AND c.tenant_id = o.tenant_id
           JOIN checklist_items i ON i.checklist_id = c.id AND i.descripcion = 'Frenos'`
      )
    );
    expect(copia.rows).toEqual([{ origen: "checklist", resultado: "no_apta", critica: true }]);
    const ids = await withTenant(destino.tenant.id, (c) =>
      c.query<{ checklist_id: number }>("SELECT checklist_id FROM ordenes_trabajo")
    );
    expect(ids.rows[0].checklist_id).not.toBe(llenadoEnOrigen.body.id);
  });

  it("unidad sin medidor: aviso; lectura sin unidad: 400; unidad ajena: 400", async () => {
    const otra = await empresaCon(["checklists", "mantenimiento"]);
    const ajena = await unidad(otra);
    const ag = await empresaCon(["checklists", "mantenimiento", "ordenes_trabajo"]);
    const id = await formato(ag);
    const sinTipo = await unidad(ag);
    // Mantenimiento siempre pone un medidor; una unidad antigua de Flota puede no tenerlo.
    const empresa = empresas[empresas.length - 1].tenant.id;
    await withTenant(empresa, (c) =>
      c.query("UPDATE equipos SET tipo_medidor = NULL WHERE id = $1", [sinTipo])
    );
    const sinMedidor = await ag
      .post(BASE)
      .send(llenado(id, null, { equipo_id: sinTipo, lectura: { valor: 5 } }));
    expect(sinMedidor.status, JSON.stringify(sinMedidor.body)).toBe(201);
    expect(sinMedidor.body.aviso_registro).toContain("medidor");

    expect((await ag.post(BASE).send(llenado(id, null, { lectura: { valor: 5 } }))).status).toBe(
      400
    );
    const robo = await ag.post(BASE).send(llenado(id, "Frenos", { equipo_id: ajena }));
    expect(robo.status, JSON.stringify(robo.body)).toBe(400);
    expect(await ordenes(ag)).toHaveLength(0);
  });
});
