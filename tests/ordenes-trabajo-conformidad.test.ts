/** tests/ordenes-trabajo-conformidad.test.ts
 *
 * La conformidad de las órdenes (M8, 0210): con la regla encendida, completar no libera la unidad hasta que
 * alguien con la casilla (nunca el mecánico asignado) la dé. */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const PASSWORD = "ClaveDePrueba123";
const OT = "/api/erp/ordenes_trabajo";
const MANT = "/api/erp/mantenimiento";

describe("Órdenes de Trabajo: conformidad", () => {
  const empresas: string[] = [];

  afterAll(async () => {
    for (const id of empresas) await borrarTenantDePrueba(id);
    await closeDatabase();
  });

  const empresaCon = async (modulos: string[]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e.tenant.id);
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
    const admin = request.agent(app);
    const login = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const persona = async (rol: string) => {
      const email = `${idUnico("conf")}@test.local`;
      const alta = await request(app)
        .post(`/api/platform/tenants/${e.tenant.id}/usuarios`)
        .set("Authorization", `Bearer ${env.platformAdminToken}`)
        .send({ nombre: `Persona ${rol}`, email, password: PASSWORD, rol });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
      return { id: alta.body.usuario.id as string, email };
    };
    const entrar = async (email: string) => {
      const ag = request.agent(app);
      const res = await ag
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return ag;
    };
    const darCasilla = async (usuarioId: string, nivel = "operar", asignados = modulos) => {
      const res = await admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
        modulos: modulos.map((modulo) => ({
          modulo,
          asignado: asignados.includes(modulo),
          nivel,
        })),
        pestanas: [{ modulo: "ordenes_trabajo", pestana: "conformidad:dar", permitido: true }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    const tenantId = e.tenant.id as string;
    return { admin, persona, entrar, darCasilla, tenantId };
  };
  type Empresa = Awaited<ReturnType<typeof empresaCon>>;

  const completar = async (e: Empresa, datos: Record<string, unknown> = {}) => {
    const o = await e.admin.post(OT).send({ activo_texto: "Horno 4", titulo: "Frenos", ...datos });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const id = Number(o.body.id);
    for (const estado of ["en_progreso", "completada"]) {
      const r = await e.admin.patch(`${OT}/${id}/estado`).send({ estado });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    return id;
  };
  const regla = async (e: Empresa, exige_conformidad: boolean) =>
    expect((await e.admin.put(`${MANT}/config`).send({ exige_conformidad })).status).toBe(200);

  it("la unidad se libera recién con la conformidad de quien tiene la casilla", async () => {
    const e = await empresaCon(["mantenimiento", "ordenes_trabajo"]);
    const u = await e.admin
      .post(`${MANT}/equipos`)
      .send({ placa_codigo: "CONF-001", tipo: "Volquete" });
    const equipo_id = Number(u.body.id);
    const estado = async () => {
      const r = await e.admin.get(`${MANT}/equipos`);
      return r.body.equipos[0] as { estado: string; motivo: string | null };
    };
    const vieja = await completar(e);
    await regla(e, true);
    const id = await completar(e, { equipo_id, prioridad: "urgente" });

    expect((await estado()).estado).toBe("detenida");
    expect((await estado()).motivo).toContain("falta conformidad");
    const pendientes = await e.admin.get(`${OT}?por_conformar=true`);
    expect((pendientes.body.data as { id: number }[]).map((o) => o.id)).toEqual([id]);
    const centro = await e.admin.get(`${MANT}/resumen`);
    expect(centro.body.ordenes.por_conformar.total).toBe(1);
    expect((await e.admin.get(`${OT}/conformidad/personas`)).body).toEqual({ total: 0 });

    // Ni el administrador la trae por defecto.
    expect((await e.admin.patch(`${OT}/${id}/conformidad`)).status).toBe(403);
    const ssoma = await e.persona("operador");
    await e.darCasilla(ssoma.id);
    expect((await e.admin.get(`${OT}/conformidad/personas`)).body).toEqual({ total: 1 });
    const agente = await e.entrar(ssoma.email);
    expect((await agente.patch(`${OT}/${vieja}/conformidad`)).status).toBe(409);

    const dada = await agente.patch(`${OT}/${id}/conformidad`);
    expect(dada.status, JSON.stringify(dada.body)).toBe(200);
    expect(dada.body.conformidad_por_nombre).toBe("Persona operador");
    expect((await agente.patch(`${OT}/${id}/conformidad`)).body.conformidad_en).toBe(
      dada.body.conformidad_en
    );
    expect((await estado()).estado).toBe("operativa");
    const leida = await e.admin.get(`${OT}/${id}`);
    expect(leida.body).toMatchObject({
      requiere_conformidad: true,
      conformidad_por_nombre: "Persona operador",
    });
  });

  it("el mecánico asignado no se la da; apagar la regla libera; sin Mantenimiento no se exige", async () => {
    const e = await empresaCon(["mantenimiento", "ordenes_trabajo"]);
    await regla(e, true);
    const mismo = await e.persona("operador");
    await e.darCasilla(mismo.id);
    const id = await completar(e, { asignado_a: mismo.id });
    const agente = await e.entrar(mismo.email);
    expect((await agente.patch(`${OT}/${id}/conformidad`)).status).toBe(403);
    await regla(e, false);
    expect((await e.admin.get(`${MANT}/resumen`)).body.ordenes.por_conformar).toBeUndefined();

    const sola = await empresaCon(["ordenes_trabajo"]);
    const suya = await completar(sola);
    expect((await sola.admin.get(`${OT}/${suya}`)).body.requiere_conformidad).toBe(false);
  });

  // ── Ataques (rol QA) ──────────────────────────────────────────────────
  const conformar = (ag: ReturnType<typeof request.agent>, id: number) =>
    ag.patch(`${OT}/${id}/conformidad`);
  const total = async (e: Empresa) =>
    (await e.admin.get(`${OT}/conformidad/personas`)).body.total as number;
  const conRegla = async () => {
    const e = await empresaCon(["mantenimiento", "ordenes_trabajo"]);
    await regla(e, true);
    return e;
  };
  const firmante = async (e: Empresa, nivel = "operar", rol = "operador") => {
    const p = await e.persona(rol);
    await e.darCasilla(p.id, nivel);
    return { ...p, ag: await e.entrar(p.email) };
  };
  const auditorias = async (e: Empresa, id: number) => {
    const r = await withTenant(e.tenantId, (c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'ordenes_trabajo.conformidad'
            AND detalle->>'ordenTrabajoId' = $2`,
        [e.tenantId, String(id)]
      )
    );
    return r.rows[0].n;
  };

  it("otra empresa no la ve ni la firma; sin sesión 401; ids absurdos 404", async () => {
    const e = await conRegla();
    const ajena = await conRegla();
    const id = await completar(e);
    const intruso = await firmante(ajena);
    expect((await conformar(intruso.ag, id)).status).toBe(404);
    expect((await request(app).patch(`${OT}/${id}/conformidad`)).status).toBe(401);
    expect((await conformar(intruso.ag, 999999999)).status).toBe(404);
    expect((await conformar(intruso.ag, 9999999999)).status).toBe(404);
    expect((await total(e)) + (await total(ajena))).toBe(1);
    expect((await e.admin.get(`${OT}/${id}`)).body.conformidad_en).toBeNull();
  });

  it("solo las completadas: abierta, en progreso y cancelada dan 409", async () => {
    const e = await conRegla();
    const f = await firmante(e);
    const o = await e.admin.post(OT).send({ activo_texto: "Faja", titulo: "Rodillo" });
    const id = Number(o.body.id);
    expect((await conformar(f.ag, id)).status).toBe(409);
    await e.admin.patch(`${OT}/${id}/estado`).send({ estado: "en_progreso" });
    expect((await conformar(f.ag, id)).status).toBe(409);
    await e.admin.patch(`${OT}/${id}/estado`).send({ estado: "cancelada" });
    expect((await conformar(f.ag, id)).status).toBe(409);
    const leida = await e.admin.get(`${OT}/${id}`);
    expect(leida.body.requiere_conformidad).toBe(false);
  });

  it("Lectura no firma aunque tenga la casilla, ni cuenta como quien la da", async () => {
    const e = await conRegla();
    const id = await completar(e);
    const mira = await firmante(e, "consultas", "lectura");
    expect((await conformar(mira.ag, id)).status).toBe(403);
    expect(await total(e)).toBe(0);
  });

  it("quien tiene la casilla pero solo consulta, o perdió el módulo, no firma ni cuenta", async () => {
    const e = await conRegla();
    const id = await completar(e);
    const consulta = await firmante(e, "consultas");
    expect((await conformar(consulta.ag, id)).status).toBe(403);
    expect(await total(e), "casilla con el módulo solo en Consultas").toBe(0);
    await e.darCasilla(consulta.id, "operar", ["mantenimiento"]);
    expect((await conformar(await e.entrar(consulta.email), id)).status).toBe(403);
    expect(await total(e), "casilla sin el módulo").toBe(0);
  });

  it("una persona dada de baja deja de contar", async () => {
    const e = await conRegla();
    const f = await firmante(e);
    expect(await total(e)).toBe(1);
    const baja = await request(app)
      .patch(`/api/platform/tenants/${e.tenantId}/usuarios/${f.id}/estado`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ activo: false });
    expect(baja.status).toBe(200);
    expect(await total(e)).toBe(0);
  });

  it("dos firmantes a la vez: firma uno; seis envíos del mismo: un solo registro", async () => {
    const e = await conRegla();
    const a = await firmante(e);
    const b = await firmante(e);
    for (let i = 0; i < 4; i++) {
      const id = await completar(e);
      const r = await Promise.all([conformar(a.ag, id), conformar(b.ag, id)]);
      expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(await auditorias(e, id)).toBe(1);
    }
    const id = await completar(e);
    const seis = await Promise.all(Array.from({ length: 6 }, () => conformar(a.ag, id)));
    expect(seis.map((x) => x.status)).toEqual(Array(6).fill(200));
    expect(new Set(seis.map((x) => x.body.conformidad_en)).size).toBe(1);
    expect(await auditorias(e, id)).toBe(1);
  });

  it("editar la orden cerrada no borra la conformidad ni la pendiente", async () => {
    const e = await conRegla();
    const f = await firmante(e);
    const id = await completar(e);
    const editar = () =>
      e.admin.put(`${OT}/${id}`).send({
        activo_texto: "Horno 4",
        titulo: "Editada",
        tipo: "correctivo",
        prioridad: "baja",
        requiere_conformidad: false,
        conformidad_en: "2026-01-01T00:00:00Z",
      });
    expect((await editar()).status).toBe(200);
    expect((await e.admin.get(`${OT}/${id}`)).body).toMatchObject({
      requiere_conformidad: true,
      conformidad_en: null,
    });
    const dada = await conformar(f.ag, id);
    expect((await editar()).status).toBe(200);
    expect((await e.admin.get(`${OT}/${id}`)).body.conformidad_en).toBe(dada.body.conformidad_en);
  });

  it("otro administrador puede recibir la casilla y firmar", async () => {
    const e = await conRegla();
    const id = await completar(e);
    const otro = await e.persona("admin");
    expect((await conformar(await e.entrar(otro.email), id)).status).toBe(403);
    const permisos = await e.admin.get(`/api/erp/usuarios/${otro.id}/permisos`);
    const casillas = (
      permisos.body.pestanas as { modulo: string; pestana: string; permitido: boolean }[]
    ).map((p) => ({
      modulo: p.modulo,
      pestana: p.pestana,
      permitido: p.pestana === "conformidad:dar" ? true : p.permitido,
    }));
    const r = await e.admin.put(`/api/erp/usuarios/${otro.id}/permisos`).send({
      modulos: ["mantenimiento", "ordenes_trabajo"].map((modulo) => ({
        modulo,
        asignado: true,
        nivel: "operar",
      })),
      pestanas: casillas,
      motivo: "Firma de SSOMA",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await conformar(await e.entrar(otro.email), id)).status).toBe(200);
  });

  it("una pendiente leve deja la unidad en mantenimiento; otra urgente abierta la detiene", async () => {
    const e = await conRegla();
    const u = await e.admin
      .post(`${MANT}/equipos`)
      .send({ placa_codigo: "CONF-002", tipo: "Volquete" });
    const equipo_id = Number(u.body.id);
    const leve = await completar(e, { equipo_id, prioridad: "baja" });
    const unidad = async () => (await e.admin.get(`${MANT}/equipos`)).body.equipos[0];
    expect(await unidad()).toMatchObject({
      estado: "en_mantenimiento",
      motivo: `OT #${leve} (falta conformidad): Frenos`,
    });
    const urgente = await e.admin
      .post(OT)
      .send({ equipo_id, titulo: "Dirección", prioridad: "urgente" });
    expect(await unidad()).toMatchObject({
      estado: "detenida",
      motivo: `OT #${urgente.body.id}: Dirección`,
    });
  });
});
