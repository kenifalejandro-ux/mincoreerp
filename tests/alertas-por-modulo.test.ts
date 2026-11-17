/** tests/alertas-por-modulo.test.ts
 *
 * Cada alerta pertenece a un módulo: Combustible, Urea o Flota (las de viaje: demorado, detenido y
 * creado por el conductor). Combustible y Urea viven en `combustible_alertas` y se leen por
 * `/api/erp/combustible/alertas`; las de viaje viven desde la migración 0188 en `viaje_alertas` y se
 * leen por `/api/erp/viajes/alertas`, con la misma forma. Lo que se fija:
 *
 * 1. Que el reparto de tipos a módulos del cliente y el del servidor coincidan.
 * 2. Que la Bandeja de Combustible NUNCA muestre, cuente, marque como leídas ni deje filtrar alertas de
 *    viaje (ni las filas viejas que la migración copió y no borró), tenga o no la persona `viajes`.
 * 3. Que la Bandeja de Viajes las muestre, cuente y marque como leídas, también en una empresa SIN
 *    Combustible, y que el módulo `viajes` apagado la cierre.
 * 4. Que otra empresa nunca vea las de esta.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { grupoDeAlerta, tiposSinModulo } from "../src/modules/combustible/alertasPorModulo";
import { TIPOS_ALERTA } from "../src/modules/combustible/combustible.repository";
import { MODULOS } from "../src/modules/registry";
import { grupoDeAlerta as grupoDelCliente } from "../client/src/components/combustible/alertasTexto";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const DE_VIAJE = ["viaje_demorado", "viaje_detenido"];
const DE_COMBUSTIBLE = ["tanque_sin_vigilancia", "urea_stock_bajo"];

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("alertas por módulo", () => {
  const empresas: Empresa[] = [];
  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  const sesion = async (e: Empresa, email = e.usuario.email) => {
    const a = request.agent(app);
    await a
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD })
      .expect(200);
    return a;
  };
  const modulos = (e: Empresa, habilitados: (id: string) => boolean) =>
    request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: habilitados(m.id) ? "habilitado" : "deshabilitado",
        })),
      })
      .expect(200);

  /** Una empresa con un viaje, dos alertas de viaje en `viaje_alertas`, una de combustible y una de
   *  urea en `combustible_alertas`, y además dos filas VIEJAS de tipo viaje en `combustible_alertas`
   *  (lo que la migración copia sin borrar). */
  async function empresaConAlertas(sinCombustible = false) {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    if (sinCombustible) await modulos(e, (id) => id !== "combustible");
    const admin = await sesion(e);
    const lugar = async (n: string) =>
      Number((await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico(n) })).body.id);
    const eq = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("AL"),
      tipo: "VOLQUETE",
      conductor_nombre: "Juan Pérez",
      conductor_dni: String(40200000 + Math.floor(Math.random() * 90000)),
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    // Los lugares se piden ANTES: una petición dentro del .send() de otra del mismo agente se pisa.
    const origen = await lugar("Origen");
    const destino = await lugar("Destino");
    const v = await admin.post("/api/erp/viajes").send({
      equipo_id: Number(eq.body.id),
      origen_id: origen,
      destino_id: destino,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const viajeId = Number(v.body.id);
    await withTenant(e.tenant.id, async (c) => {
      for (const tipo of DE_VIAJE) {
        await c.query(
          `INSERT INTO viaje_alertas (tenant_id, tipo, viaje_id, detalle) VALUES ($1, $2, $3, '{}')`,
          [e.tenant.id, tipo, viajeId]
        );
        await c.query(
          `INSERT INTO combustible_alertas (tenant_id, tipo, viaje_id, detalle)
           VALUES ($1, $2, $3, '{}')`,
          [e.tenant.id, tipo, viajeId]
        );
      }
      let n = 1;
      for (const tipo of DE_COMBUSTIBLE) {
        await c.query(
          `INSERT INTO combustible_alertas (tenant_id, tipo, serie_talonario, n_vale, detalle)
           VALUES ($1, $2, 'T', $3, '{}'::jsonb)`,
          [e.tenant.id, tipo, n++]
        );
      }
    });
    return e;
  }
  const tiposDe = async (a: request.Agent, ruta: string, query = "") =>
    ((await a.get(`${ruta}${query}`)).body.data as { tipo: string }[]).map((x) => x.tipo).sort();
  const COMB = "/api/erp/combustible/alertas";
  const VIAJ = "/api/erp/viajes/alertas";

  it("el reparto de tipos a módulos del cliente es el mismo del servidor, para cada tipo de alerta", () => {
    for (const tipo of TIPOS_ALERTA) {
      expect(grupoDelCliente(tipo), tipo).toBe(grupoDeAlerta(tipo));
    }
    expect(grupoDeAlerta("viaje_demorado")).toBe("flota");
    expect(grupoDeAlerta("viaje_creado_por_conductor")).toBe("flota");
    expect(grupoDeAlerta("urea_stock_bajo")).toBe("urea");
    expect(grupoDeAlerta("hueco_detectado")).toBe("combustible");
  });

  it("la Bandeja de Combustible siempre excluye los tipos de viaje, tenga o no la persona `viajes`", () => {
    const flota = ["viaje_demorado", "viaje_detenido", "viaje_creado_por_conductor"];
    expect(tiposSinModulo(["combustible", "viajes"])).toEqual(flota);
    expect(tiposSinModulo(["combustible"])).toEqual(flota);
    expect(tiposSinModulo(undefined)).toEqual(flota); // el correo tampoco los cuenta
  });

  it("Combustible no muestra ni cuenta las alertas de viaje (tampoco las filas viejas) y rechaza modulo=flota", async () => {
    const e = await empresaConAlertas();
    const admin = await sesion(e);
    expect(await tiposDe(admin, COMB)).toEqual([...DE_COMBUSTIBLE].sort());
    expect((await admin.get(`${COMB}/resumen`)).body.total).toBe(2);
    expect(await tiposDe(admin, COMB, "?tipo=viaje_demorado")).toEqual([]);
    expect(await tiposDe(admin, COMB, "?modulo=urea")).toEqual(["urea_stock_bajo"]);
    expect(await tiposDe(admin, COMB, "?modulo=combustible")).toEqual(["tanque_sin_vigilancia"]);
    // Las de viaje ya no son un módulo de esta Bandeja.
    for (const raro of ["flota", "viajes", "FLOTA", "x'--"]) {
      const res = await admin.get(`${COMB}?modulo=${encodeURIComponent(raro)}`);
      expect(res.status, raro).toBe(400);
    }
    expect((await admin.get(`${COMB}?modulo=`)).status).toBe(200); // vacío = sin filtro
  });

  it("marcar leídas en Combustible (todas o por id) no toca las alertas de viaje", async () => {
    const e = await empresaConAlertas();
    const filasViejas = (
      await withTenant(e.tenant.id, (c) =>
        c.query(`SELECT id FROM combustible_alertas WHERE tipo LIKE 'viaje\\_%'`)
      )
    ).rows.map((x) => Number(x.id));
    const admin = await sesion(e);
    expect((await admin.patch(`${COMB}/leidas`).send({ ids: filasViejas })).status).toBe(204);
    expect((await admin.patch(`${COMB}/leidas`).send({})).status).toBe(204);
    const sinLeer = (
      await withTenant(e.tenant.id, (c) =>
        c.query(
          `SELECT (SELECT count(*) FROM viaje_alertas WHERE leida_en IS NULL) AS nuevas,
                  (SELECT count(*) FROM combustible_alertas
                    WHERE tipo LIKE 'viaje\\_%' AND leida_en IS NULL) AS viejas`
        )
      )
    ).rows[0];
    expect(Number(sinLeer.nuevas)).toBe(2); // las de viaje no se tocaron
    expect(Number(sinLeer.viejas)).toBe(2); // ni las filas viejas
  });

  it("la Bandeja de Viajes muestra, cuenta y marca como leídas las alertas de viaje, con la forma de la de Combustible", async () => {
    const e = await empresaConAlertas();
    const admin = await sesion(e);
    expect(await tiposDe(admin, VIAJ)).toEqual([...DE_VIAJE].sort());
    const resumen = (await admin.get(`${VIAJ}/resumen`)).body;
    expect(resumen).toMatchObject({
      total: 2,
      pendientes: 2,
      sinLeer: 2,
      criticasPendientes: 2,
      resueltas: 0,
      congeladas: 0,
      porRevisar: 0,
    });
    const fila = (await admin.get(VIAJ)).body.data[0];
    expect(fila).toMatchObject({ critica: true, revisable: false, congelada_en: null });
    expect(Number(fila.viaje_id)).toBeGreaterThan(0);

    expect(await tiposDe(admin, VIAJ, "?tipo=viaje_demorado")).toEqual(["viaje_demorado"]);
    expect(await tiposDe(admin, VIAJ, "?estado=resueltas")).toEqual([]);
    expect(await tiposDe(admin, VIAJ, "?estado=congeladas")).toEqual([]);
    for (const malo of [
      "estado=rara",
      "id=abc",
      "tipo=A-B",
      "desde=2026-13-45",
      "grifo_interno_id=0",
    ]) {
      expect((await admin.get(`${VIAJ}?${malo}`)).status, malo).toBe(400);
    }

    // Por id marca solo esa; sin ids, las que quedan.
    const unaId = Number(fila.id);
    expect((await admin.patch(`${VIAJ}/leidas`).send({ ids: [unaId] })).status).toBe(204);
    expect((await admin.get(`${VIAJ}/resumen`)).body.sinLeer).toBe(1);
    expect((await admin.patch(`${VIAJ}/leidas`).send({})).status).toBe(204);
    expect((await admin.get(`${VIAJ}/resumen`)).body.sinLeer).toBe(0);
    // Leídas no es resueltas: siguen pendientes.
    expect((await admin.get(`${VIAJ}/resumen`)).body.pendientes).toBe(2);
  });

  it("una empresa SIN Combustible ve sus alertas de viaje por su propia Bandeja", async () => {
    const e = await empresaConAlertas(true);
    const admin = await sesion(e);
    expect((await admin.get(COMB)).status).toBe(403); // de verdad no tiene Combustible
    expect(await tiposDe(admin, VIAJ)).toEqual([...DE_VIAJE].sort());
    expect((await admin.get(`${VIAJ}/resumen`)).body.total).toBe(2);
  });

  it("sin el módulo `viajes` la Bandeja de Viajes está cerrada (403)", async () => {
    const e = await empresaConAlertas();
    await modulos(e, (id) => id !== "viajes");
    const admin = await sesion(e);
    expect((await admin.get(VIAJ)).status).toBe(403);
    expect((await admin.get(`${VIAJ}/resumen`)).status).toBe(403);
    expect((await admin.patch(`${VIAJ}/leidas`).send({})).status).toBe(403);
    // Combustible sigue igual.
    expect(await tiposDe(admin, COMB)).toEqual([...DE_COMBUSTIBLE].sort());
  });

  it("un operador ve las de viaje", async () => {
    const e = await empresaConAlertas();
    const admin = await sesion(e);
    const email = `${idUnico("operador")}@test.local`;
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Operador", email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    const operador = await sesion(e, email);
    expect(await tiposDe(operador, VIAJ)).toEqual([...DE_VIAJE].sort());
  });

  it("las alertas de viaje de otra empresa nunca aparecen", async () => {
    const a = await empresaConAlertas();
    const b = await empresaConAlertas();
    const adminA = await sesion(a);
    const idsDeB = (
      await withTenant(b.tenant.id, (c) => c.query(`SELECT id FROM viaje_alertas`))
    ).rows.map((x) => Number(x.id));
    const vistasPorA = ((await adminA.get(VIAJ)).body.data as { id: number }[]).map((x) =>
      Number(x.id)
    );
    expect(vistasPorA.some((id) => idsDeB.includes(id))).toBe(false);
    expect(
      (await adminA.get(`${VIAJ}?id=${idsDeB[0]}&estado=todas`)).body.data as unknown[]
    ).toHaveLength(0);
  });
});
