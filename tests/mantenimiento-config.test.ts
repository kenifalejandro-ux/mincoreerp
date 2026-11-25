/** tests/mantenimiento-config.test.ts
 *
 * M2: reglas y metas del ecosistema «Gestión de mantenimiento», con una empresa que tiene SOLO `mantenimiento`.
 *
 * 1. Sin haber guardado nunca salen los valores por defecto y no se crea ninguna fila.
 * 2. Se guarda solo lo que se manda; lo demás queda como estaba, y los DEFAULT de la migración coinciden con los
 *    que devuelve el servicio.
 * 3. Dos guardados a la vez de campos distintos no se pisan, y queda una sola fila.
 * 4. Fuera de rango, decimales, tipos mal puestos, campos desconocidos o un cuerpo vacío: 400, nunca 500.
 * 5. Solo el admin cambia; operador y Lectura miran. Sin el módulo, 403.
 * 6. Otra empresa no ve ni toca la configuración.
 * 7. La auditoría guarda los nombres de lo que cambió; repetir lo mismo no deja otra fila.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico } from "./helpers";
import { CONFIG_POR_DEFECTO } from "../src/modules/mantenimiento/mantenimiento.service";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const RUTA = "/api/erp/mantenimiento/config";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;

describe("Mantenimiento: reglas y metas (M2)", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;

  const habilitar = async (e: Empresa, modulos: string[]) => {
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
  };
  const entrar = async (e: Empresa) => {
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
  const leer = async (ag: Agente = admin) => {
    const r = await ag.get(RUTA);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as typeof CONFIG_POR_DEFECTO;
  };
  const filas = (e: Empresa) =>
    withTenant(e.tenant.id, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM mantenimiento_config");
      return r.rows[0].n as number;
    });
  const auditorias = async () => {
    const r = await pool.query(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'mantenimiento.config_actualizar' ORDER BY id`,
      [a.tenant.id]
    );
    return r.rows.map((f) => f.detalle as { campos: string[] });
  };

  beforeAll(async () => {
    a = await crearTenantDePrueba(PASSWORD);
    b = await crearTenantDePrueba(PASSWORD);
    empresas.push(a, b);
    await habilitar(a, ["mantenimiento"]);
    await habilitar(b, ["mantenimiento"]);
    admin = await entrar(a);
    adminB = await entrar(b);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("sin haber guardado nunca salen los valores por defecto y no se crea ninguna fila", async () => {
    expect(await leer()).toEqual(CONFIG_POR_DEFECTO);
    expect(CONFIG_POR_DEFECTO).toMatchObject({
      ot_de_hallazgo: true,
      bloquea_sin_iperc: true,
      alerta_repuestos: true,
      exige_conformidad: false,
      meta_disponibilidad: 90,
      meta_preventivo: 90,
      meta_mttr_horas: 24,
      meta_mtbf_horas: 300,
    });
    expect(await filas(a)).toBe(0);
  });

  it("guarda solo lo que se manda y los DEFAULT de la base coinciden con los del servicio", async () => {
    const r = await admin.put(RUTA).send({ meta_disponibilidad: 85 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // El resto de la fila nueva salió de los DEFAULT de la migración.
    expect(r.body).toEqual({ ...CONFIG_POR_DEFECTO, meta_disponibilidad: 85 });
    const otra = await admin.put(RUTA).send({ exige_conformidad: true, meta_mtbf_horas: 500 });
    expect(otra.body).toEqual({
      ...CONFIG_POR_DEFECTO,
      meta_disponibilidad: 85,
      exige_conformidad: true,
      meta_mtbf_horas: 500,
    });
    expect(await leer()).toEqual(otra.body);
    expect(await filas(a)).toBe(1);
  });

  it("dos guardados a la vez de campos distintos no se pisan y queda una sola fila", async () => {
    const [x, y] = await Promise.all([
      adminB.put(RUTA).send({ meta_preventivo: 70 }),
      adminB.put(RUTA).send({ meta_mttr_horas: 12 }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(await leer(adminB)).toMatchObject({ meta_preventivo: 70, meta_mttr_horas: 12 });
    expect(await filas(b)).toBe(1);
  });

  it("un valor inválido o un cuerpo sin cambios da 400 y no toca nada", async () => {
    const antes = await leer();
    const malos: Record<string, unknown>[] = [
      { meta_disponibilidad: 0 },
      { meta_disponibilidad: 101 },
      { meta_preventivo: -1 },
      { meta_mttr_horas: 10_001 },
      { meta_mtbf_horas: 100_001 },
      { meta_mtbf_horas: 1e30 },
      { meta_disponibilidad: 92.5 },
      { meta_disponibilidad: "90" },
      { meta_disponibilidad: null },
      { ot_de_hallazgo: "si" },
      { meta_inventada: 5 },
      { meta_disponibilidad: 80, tenant_id: b.tenant.id },
      {},
    ];
    for (const cuerpo of malos) {
      const r = await admin.put(RUTA).send(cuerpo);
      expect(r.status, JSON.stringify(cuerpo)).toBe(400);
    }
    expect(await leer()).toEqual(antes);
  });

  it("solo el admin cambia; operador y Lectura miran", async () => {
    const operador = await persona("operador");
    const lectura = await persona("lectura");
    for (const ag of [operador, lectura]) {
      expect((await ag.get(RUTA)).status).toBe(200);
      expect((await ag.put(RUTA).send({ meta_disponibilidad: 50 })).status).toBe(403);
    }
    expect((await leer()).meta_disponibilidad).not.toBe(50);
  });

  it("sin el módulo no hay configuración (403)", async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    empresas.push(c);
    await habilitar(c, ["flota"]);
    const ag = await entrar(c);
    expect((await ag.get(RUTA)).status).toBe(403);
    expect((await ag.put(RUTA).send({ meta_disponibilidad: 50 })).status).toBe(403);
  });

  it("cada empresa ve y cambia solo la suya", async () => {
    const deA = await leer();
    await adminB.put(RUTA).send({ meta_disponibilidad: 55 });
    expect(await leer()).toEqual(deA);
    expect((await leer(adminB)).meta_disponibilidad).toBe(55);
  });

  it("la auditoría guarda los nombres de lo que cambió; repetir lo mismo no deja otra fila", async () => {
    const antes = (await auditorias()).length;
    const cuerpo = { alerta_repuestos: false, meta_mttr_horas: 48 };
    expect((await admin.put(RUTA).send(cuerpo)).status).toBe(200);
    expect((await admin.put(RUTA).send(cuerpo)).status).toBe(200);
    const filasAudit = await auditorias();
    expect(filasAudit).toHaveLength(antes + 1);
    expect([...filasAudit.at(-1)!.campos].sort()).toEqual(["alerta_repuestos", "meta_mttr_horas"]);
  });
});
