/** tests/combustible-alertas-enrutadas-auditoria.test.ts
 *
 * AUDITORÍA ADVERSARIA del enrutamiento de alertas por alcance (PR 1).
 * Auditó un modelo distinto al que implementó (Sonnet 5.5 sobre Opus 5).
 *
 * Cada test afirma el comportamiento CORRECTO. Si falla, es un hallazgo: el
 * cambio dejó visible o accionable algo que el alcance dice que no se debe.
 * Método de siempre: cada "no pudo" con su gemelo "sí pudo" en lo propio.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";
import { grifoDeAlertas } from "../src/modules/combustible/alcance";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";

const correos: { destinatarios: { email: string }[]; asunto: string }[] = [];
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(async (a: { destinatarios: { email: string }[]; asunto: string }) => {
    correos.push({ destinatarios: a.destinatarios, asunto: a.asunto });
  }),
}));

const PASSWORD = "ClaveDePrueba123";

afterAll(async () => {
  await closeDatabase();
});

describe("auditoría: grifoDeAlertas (casos de borde)", () => {
  it("un lote de un solo grifo enruta a ese grifo", () => {
    expect(grifoDeAlertas([{ grifo_interno_id: 7 }, { grifo_interno_id: 7 }])).toBe(7);
  });
  it("un lote que abarca dos grifos avisa a toda la empresa (no deja a nadie sin su aviso)", () => {
    expect(grifoDeAlertas([{ grifo_interno_id: 7 }, { grifo_interno_id: 8 }])).toBeNull();
  });
  it("un lote vacío o sin grifo es de la empresa entera", () => {
    expect(grifoDeAlertas([])).toBeNull();
    expect(grifoDeAlertas([{ grifo_interno_id: null }])).toBeNull();
  });
  it("un lote MEZCLADO (una alerta con grifo y otra sin) NO debe esconder la alerta de empresa", () => {
    // Una alerta sin grifo es "de todos". Si el lote comparte una sola lista
    // de destinatarios, enrutarlo al único grifo presente deja a los demás sin
    // el aviso de la alerta que sí era suya. Lo seguro es null.
    expect(grifoDeAlertas([{ grifo_interno_id: 7 }, { grifo_interno_id: null }])).toBeNull();
  });
});

describe("auditoría: lo que el alcance ya esconde no debe seguir accionable", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let grifoA: number;
  let grifoB: number;
  let tanqueA: number;
  let tanqueB: number;
  let nombreA: string;
  let nombreB: string;
  let jefeA: { id: string; email: string };
  let jefeB: { id: string; email: string };
  let jefeTodo: { id: string; email: string };
  const agenteA = request.agent(app);

  const permisosDe = async (id: string) =>
    (await admin.get(`/api/erp/usuarios/${id}/permisos`)).body as {
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
      alertasCorreo: { modulo: string; recibeAlertas: boolean }[];
    };

  async function persona(nombre: string, alcance?: { grifos?: number[]; surtidores?: number[] }) {
    const email = `${nombre}-${slug}@test.local`.toLowerCase();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre, email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    const act = await permisosDe(alta.body.id);
    const r = await admin.put(`/api/erp/usuarios/${alta.body.id}/permisos`).send({
      modulos: act.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.modulo === "combustible" ? true : m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: act.alertasCorreo.map((a) => ({
        modulo: a.modulo,
        recibeAlertas: a.modulo === "combustible" ? true : a.recibeAlertas,
      })),
      alcanceCombustible: alcance
        ? { todo: false, sedes: [], grifos: [], surtidores: [], ...alcance }
        : { todo: true, sedes: [], grifos: [], surtidores: [] },
      motivo: "prueba automatizada: auditoría del enrutamiento",
    });
    expect(r.status).toBe(200);
    return { id: alta.body.id as string, email };
  }

  async function tanque(grifo: number, nombre: string) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: nombre,
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: grifo,
    });
    expect(r.status).toBe(201);
    return { id: r.body.id as number, surtidor: r.body.surtidores[0].id as number };
  }

  /** Una alerta REVISABLE (sobredespacho) sobre un tanque; el trigger le pone el grifo. */
  const alerta = (combustibleId: number) =>
    withTenant(tenantId, async (c) => {
      const r = await c.query<{ id: string; grifo_interno_id: number | null }>(
        `INSERT INTO combustible_alertas (tenant_id, tipo, combustible_id, producto, detalle)
         VALUES ($1, 'sobredespacho', $2, 'combustible', '{}'::jsonb)
         RETURNING id, grifo_interno_id`,
        [tenantId, combustibleId]
      );
      return r.rows[0];
    });

  const estado = (id: string) =>
    withTenant(tenantId, async (c) => {
      const r = await c.query<{ leida_en: Date | null; resuelta_en: Date | null }>(
        `SELECT leida_en, resuelta_en FROM combustible_alertas WHERE id = $1`,
        [id]
      );
      return r.rows[0];
    });

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password: PASSWORD });
    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    grifoA = sedes[0].grifos[0].id;
    grifoB = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: "Punto B" })
    ).body.id;
    nombreA = idUnico("TanqueA");
    nombreB = idUnico("TanqueB");
    tanqueA = (await tanque(grifoA, nombreA)).id;
    tanqueB = (await tanque(grifoB, nombreB)).id;
    jefeA = await persona("jefeA", { grifos: [grifoA] });
    jefeB = await persona("jefeB", { grifos: [grifoB] });
    jefeTodo = await persona("jefeTodo");
    await agenteA
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: jefeA.email, password: PASSWORD });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("marcar como leída por id una alerta de otro grifo no la marca", async () => {
    const propia = await alerta(tanqueA);
    const ajena = await alerta(tanqueB);
    const r = await agenteA
      .patch("/api/erp/combustible/alertas/leidas")
      .send({ ids: [Number(propia.id), Number(ajena.id)] });
    expect(r.status).toBe(204);
    expect((await estado(propia.id)).leida_en).not.toBeNull(); // gemelo
    expect((await estado(ajena.id)).leida_en).toBeNull(); // el ataque
  });

  it("cerrar a mano por id una alerta de OTRO grifo da 404 y no la cierra", async () => {
    const propia = await alerta(tanqueA);
    const ajena = await alerta(tanqueB);
    const motivo = { motivo: "prueba automatizada: cierre cruzado entre grifos" };

    const mia = await agenteA
      .patch(`/api/erp/combustible/alertas/${propia.id}/resolver`)
      .send(motivo);
    expect(mia.status).toBe(200); // gemelo: lo propio sí se cierra

    const cruzada = await agenteA
      .patch(`/api/erp/combustible/alertas/${ajena.id}/resolver`)
      .send(motivo);
    expect(cruzada.status).toBe(404);
    expect((await estado(ajena.id)).resuelta_en).toBeNull();
  });

  it("una alerta de otro grifo, ya congelada, tampoco aparece en /anomalias", async () => {
    const propia = await alerta(tanqueA);
    const ajena = await alerta(tanqueB);
    // Envejecer las alertas más allá de la ventana de gracia y correr el worker:
    // es el camino real por el que una alerta pasa a anomalía permanente.
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_alertas SET creado_en = now() - interval '90 days' WHERE id = ANY($1::bigint[])`,
        [[propia.id, ajena.id]]
      )
    );
    await correrConciliacion(tenantId);

    const r = await agenteA.get("/api/erp/combustible/anomalias?page_size=100");
    expect(r.status).toBe(200);
    const ids = (r.body.data as { alerta_id: string | null }[]).map((x) => String(x.alerta_id));
    expect(ids).toContain(String(propia.id)); // gemelo: la propia se ve
    expect(ids).not.toContain(String(ajena.id)); // la ajena, no
  });

  it("el worker enruta el correo de 'tanque sin medir' POR TANQUE, no a todos", async () => {
    for (const tq of [tanqueA, tanqueB]) {
      const l = await admin
        .post("/api/erp/combustible/lecturas")
        .send({ combustible_id: tq, nivel: 9000 });
      expect(l.status).toBe(201);
    }
    await withTenant(tenantId, (c) =>
      c.query(
        `UPDATE combustible_lecturas SET leido_en = now() - interval '10 days'
          WHERE combustible_id = ANY($1::int[])`,
        [[tanqueA, tanqueB]]
      )
    );
    correos.length = 0;
    await correrConciliacion(tenantId);

    const paraA = correos.find((c) => c.asunto.includes(nombreA));
    const paraB = correos.find((c) => c.asunto.includes(nombreB));
    expect(paraA, "no salió el correo del tanque A").toBeDefined();
    expect(paraB, "no salió el correo del tanque B").toBeDefined();
    const aMail = paraA!.destinatarios.map((d) => d.email);
    const bMail = paraB!.destinatarios.map((d) => d.email);
    expect(aMail).toContain(jefeA.email);
    expect(aMail).toContain(jefeTodo.email);
    expect(aMail).not.toContain(jefeB.email);
    expect(bMail).toContain(jefeB.email);
    expect(bMail).toContain(jefeTodo.email);
    expect(bMail).not.toContain(jefeA.email);
  });

  it("quien tiene SOLO un surtidor ve las alertas de SUS vales y de ningún otro", async () => {
    // Su alcance de vales incluye ese surtidor (filtroVale): si el panel le
    // esconde la alerta del vale que él mismo cargó, ve el hecho pero no su
    // alerta. Y el gemelo negativo: lo que no pasó por su surtidor, no.
    const tq = await tanque(grifoB, idUnico("TanqueS"));
    const eq = (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("ES"), tipo: "Volquete", grifo_interno_id: grifoB })
    ).body.id;
    const vale = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq.id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: eq,
      serie_talonario: `S${Date.now().toString(36).slice(-6)}`,
      n_vale: 1,
      cantidad: 100,
      lectura_contometro: 100,
      costo_unitario: 16,
      despachado_en: new Date().toISOString(),
    });
    expect(vale.status).toBe(201);
    const solo = await persona("soloSurtidor", { surtidores: [tq.surtidor] });
    const ag = request.agent(app);
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: solo.email, password: PASSWORD });
    const suya = await withTenant(tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO combustible_alertas (tenant_id, tipo, despacho_id, producto, detalle)
         VALUES ($1, 'sobredespacho', $2, 'combustible', '{}'::jsonb) RETURNING id`,
        [tenantId, vale.body.id]
      );
      return r.rows[0];
    });
    const ajena = await alerta(tanqueB);
    const r = await ag.get("/api/erp/combustible/alertas?page_size=100");
    expect(r.status).toBe(200);
    const ids = (r.body.data as { id: string }[]).map((x) => String(x.id));
    expect(ids).toContain(String(suya.id));
    expect(ids).not.toContain(String(ajena.id));
  });
});

describe("auditoría: otra empresa no toca las alertas de esta", () => {
  let aId: string;
  let bId: string;
  const adminB = request.agent(app);
  let alertaDeA: string;

  beforeAll(async () => {
    const a = await crearTenantDePrueba(PASSWORD);
    const b = await crearTenantDePrueba(PASSWORD);
    aId = a.tenant.id;
    bId = b.tenant.id;
    const adminA = request.agent(app);
    await adminA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: a.usuario.email, password: PASSWORD });
    await adminB
      .post("/api/auth/login")
      .send({ tenantSlug: b.tenant.slug, email: b.usuario.email, password: PASSWORD });
    const grifo = (await adminA.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
    const tq = await adminA.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: grifo,
    });
    alertaDeA = await withTenant(aId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO combustible_alertas (tenant_id, tipo, combustible_id, producto, detalle)
         VALUES ($1, 'sobredespacho', $2, 'combustible', '{}'::jsonb) RETURNING id`,
        [aId, tq.body.id]
      );
      return r.rows[0].id;
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(aId);
    await borrarTenantDePrueba(bId);
  });

  it("el admin de otra empresa no puede cerrar ni marcar la alerta ajena", async () => {
    const cerrar = await adminB
      .patch(`/api/erp/combustible/alertas/${alertaDeA}/resolver`)
      .send({ motivo: "prueba automatizada: cierre desde otra empresa" });
    expect(cerrar.status).toBe(404);
    await adminB.patch("/api/erp/combustible/alertas/leidas").send({ ids: [Number(alertaDeA)] });
    const fila = await withTenant(aId, async (c) => {
      const r = await c.query(
        `SELECT leida_en, resuelta_en FROM combustible_alertas WHERE id = $1`,
        [alertaDeA]
      );
      return r.rows[0];
    });
    expect(fila.leida_en).toBeNull();
    expect(fila.resuelta_en).toBeNull();
    const lista = await adminB.get("/api/erp/combustible/alertas?page_size=100");
    expect((lista.body.data as { id: string }[]).map((x) => String(x.id))).not.toContain(alertaDeA);
  });
});
