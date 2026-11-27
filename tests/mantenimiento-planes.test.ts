/** tests/mantenimiento-planes.test.ts
 *
 * M9: planes de mantenimiento preventivo, con empresas que tienen SOLO `mantenimiento`.
 *
 * 1. Se crea, se lista, se edita y se quita un plan; los tipos sin plan salen de los equipos registrados.
 * 2. El tipo se compara sin mayúsculas ni espacios de más (también los espacios raros que trae un Excel).
 * 3. El aviso «Próximo»: 10 % si no viene al crear, siempre menor que el intervalo y obligatorio al editar.
 * 4. Datos absurdos: 400, nunca 500, y no queda nada guardado.
 * 5. Carreras: dos altas del mismo tipo, dos ediciones sobre la misma versión y el tope de planes.
 * 6. Admin y operador escriben; Lectura mira; sin el módulo o sin sesión no entra; otra empresa no ve ni toca.
 * 7. La auditoría guarda solo el id, y lo rechazado no deja rastro.
 * 8. El respaldo copia el plan tal cual a otra empresa.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico } from "./helpers";
import { MAX_PLANES_POR_EMPRESA } from "../src/modules/mantenimiento/mantenimiento.planes";
import { MODULOS } from "../src/modules/registry";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const RUTA = "/api/erp/mantenimiento/planes";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;
interface PlanLeido extends Record<string, unknown> {
  id: number;
  tipo_equipo: string;
  aviso_antes: number;
  version: number;
  equipos: number;
}

const planDe = (tipo = "Volquete") => ({
  tipo_equipo: tipo,
  medida: "horometro",
  intervalo: 250,
  ciclo: [1, 2, 1, 3],
  niveles: {
    "1": { tareas: ["Cambio de aceite", "Engrase"], repuestos: ["Filtro de aceite"] },
    "2": { tareas: ["Filtro hidráulico"] },
    "3": { tareas: ["Revisión mayor"], repuestos: [] },
  },
});

describe("Mantenimiento: planes del preventivo (M9)", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;

  const nueva = async (modulos = ["mantenimiento"]) => {
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
  const listar = async (ag: Agente = admin) => {
    const r = await ag.get(RUTA);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { planes: PlanLeido[]; tiposSinPlan: { tipo: string; equipos: number }[] };
  };
  const crear = async (cuerpo: object = planDe(), ag: Agente = admin) => {
    const r = await ag.post(RUTA).send(cuerpo);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as PlanLeido;
  };
  const equipo = async (placa: string, tipo: string) => {
    const r = await admin
      .post("/api/erp/mantenimiento/equipos")
      .send({ placa_codigo: placa, tipo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const auditorias = async (e: Empresa) => {
    const r = await pool.query(
      `SELECT accion, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion LIKE 'mantenimiento.plan%' ORDER BY id`,
      [e.tenant.id]
    );
    return r.rows as { accion: string; detalle: Record<string, unknown> }[];
  };
  const vaciar = (e: Empresa) =>
    withTenant(e.tenant.id, (c) => c.query("DELETE FROM mantenimiento_planes"));

  beforeAll(async () => {
    a = await nueva();
    b = await nueva();
    admin = await entrar(a);
    adminB = await entrar(b);
  });

  beforeEach(async () => {
    await vaciar(a);
    await vaciar(b);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("crea, lista, edita y quita un plan, y cuenta los equipos de su tipo", async () => {
    await equipo("V-01", "Volquete");
    await equipo("V-02", "VOLQUETE");
    await equipo("H-01", "Horno");
    expect(await listar()).toEqual({
      planes: [],
      tiposSinPlan: [
        { tipo: "Horno", equipos: 1 },
        { tipo: expect.stringMatching(/^volquete$/i), equipos: 2 },
      ],
    });

    const creado = await crear();
    expect(creado).toMatchObject({
      tipo_equipo: "Volquete",
      medida: "horometro",
      intervalo: 250,
      aviso_antes: 25,
      ciclo: [1, 2, 1, 3],
      version: 1,
      equipos: 2,
      niveles: { "2": { tareas: ["Filtro hidráulico"], repuestos: [] } },
    });
    expect((await listar()).tiposSinPlan).toEqual([{ tipo: "Horno", equipos: 1 }]);

    const editado = await admin.put(`${RUTA}/${creado.id}`).send({
      ...planDe(),
      medida: "odometro",
      intervalo: 5000,
      aviso_antes: 0,
      ciclo: [1],
      niveles: { "1": { tareas: ["Solo esto"] } },
      version: 1,
    });
    expect(editado.status, JSON.stringify(editado.body)).toBe(200);
    expect(editado.body).toMatchObject({ version: 2, aviso_antes: 0, ciclo: [1], equipos: 2 });
    expect(Object.keys(editado.body.niveles)).toEqual(["1"]);
    expect((await listar()).planes).toEqual([editado.body]);

    expect((await admin.delete(`${RUTA}/${creado.id}`)).status).toBe(200);
    expect((await admin.delete(`${RUTA}/${creado.id}`)).status).toBe(404);
    expect((await listar()).planes).toEqual([]);
  });

  it.each([
    ["espacios y mayúsculas", "  camión   GRÚA ", "Camión Grúa"],
    ["espacio duro de Excel", "Cargador Frontal", "Cargador Frontal"],
    ["espacio ancho", "Faja Móvil", "Faja Móvil"],
  ])("el plan reconoce el tipo del equipo: %s", async (_caso, delEquipo, delPlan) => {
    const placa = `T-${dniUnico()}`;
    await equipo(placa, delEquipo);
    // Los equipos de los casos anteriores siguen ahí: el de este caso es el único de su tipo.
    const antes = (await listar()).tiposSinPlan.map((t) => t.tipo);
    const creado = await crear(planDe(delPlan));
    expect.soft(creado.equipos, "equipos que usan el plan").toBe(1);
    const despues = (await listar()).tiposSinPlan.map((t) => t.tipo);
    expect.soft(despues.length, "tipos que siguen sin plan").toBe(antes.length - 1);
  });

  it("el aviso por defecto es el 10 % y siempre queda por debajo del intervalo", async () => {
    for (const [intervalo, aviso] of [
      [1, 0],
      [5, 1],
      [15, 2],
      [1_000_000, 100_000],
    ]) {
      const p = await crear({ ...planDe(`Tipo ${intervalo}`), intervalo });
      expect(p.aviso_antes, `intervalo ${intervalo}`).toBe(aviso);
    }
    const elegido = await crear({ ...planDe("Elegido"), aviso_antes: 249 });
    expect(elegido.aviso_antes).toBe(249);
    // Al editar es obligatorio: omitirlo no puede borrar el elegido.
    const sin = await admin.put(`${RUTA}/${elegido.id}`).send({ ...planDe("Elegido"), version: 1 });
    expect(sin.status).toBe(400);
  });

  it("un plan inválido da 400, nunca 500, y no se guarda nada", async () => {
    const base = planDe();
    const nivel = { tareas: ["x"] };
    const uno = (n: object) => ({ ...base, ciclo: [1], niveles: { "1": n } });
    const malos: Record<string, unknown>[] = [
      {},
      { ...base, tipo_equipo: "" },
      { ...base, tipo_equipo: "   " },
      { ...base, tipo_equipo: "x".repeat(61) },
      { ...base, tipo_equipo: 5 },
      { ...base, medida: "horas" },
      { ...base, intervalo: 0 },
      { ...base, intervalo: -250 },
      { ...base, intervalo: 2.5 },
      { ...base, intervalo: "250" },
      { ...base, intervalo: 1_000_001 },
      { ...base, intervalo: 1e30 },
      { ...base, aviso_antes: 250 },
      { ...base, aviso_antes: -1 },
      { ...base, aviso_antes: null },
      { ...base, ciclo: [] },
      { ...base, ciclo: [0] },
      { ...base, ciclo: [4] },
      { ...base, ciclo: ["1"] },
      { ...base, ciclo: Array(13).fill(1), niveles: { "1": nivel } },
      { ...base, ciclo: [1] },
      { ...base, niveles: { "1": nivel } },
      { ...base, niveles: [] },
      uno({ tareas: [] }),
      uno({ tareas: ["  "] }),
      uno({ tareas: ["x".repeat(161)] }),
      uno({ tareas: Array(41).fill("x") }),
      uno({ tareas: ["x"], stock: 3 }),
      { ...base, ciclo: [1], niveles: { "1": nivel, "4": nivel } },
      { ...base, tenant_id: b.tenant.id },
      { ...base, version: 1 },
    ];
    const fallos: string[] = [];
    for (const cuerpo of malos) {
      const r = await admin.post(RUTA).send(cuerpo);
      if (r.status !== 400) fallos.push(`${r.status} ${JSON.stringify(cuerpo).slice(0, 130)}`);
      await vaciar(a);
    }
    expect(fallos).toEqual([]);
  });

  it("los caracteres invisibles se limpian al guardar", async () => {
    const creado = await crear({
      ...planDe("Vol\u0000quete\t8x4"),
      ciclo: [1],
      niveles: { "1": { tareas: ["Cambio\u0000de\naceite"], repuestos: ["Filtro\u007f"] } },
    });
    expect(creado).toMatchObject({
      tipo_equipo: "Vol quete 8x4",
      niveles: { "1": { tareas: ["Cambio de aceite"], repuestos: ["Filtro"] } },
    });
  });

  it("una edición con versión o id absurdos se rechaza sin 500", async () => {
    const p = await crear();
    const fallos: string[] = [];
    for (const version of [0, -1, 1.5, "1", null, 2_147_483_648, 9_007_199_254_740_991, 1e30]) {
      const r = await admin.put(`${RUTA}/${p.id}`).send({ ...planDe(), aviso_antes: 5, version });
      if (r.status !== 400 && r.status !== 409) fallos.push(`version ${version}: ${r.status}`);
    }
    const cuerpo = { ...planDe(), aviso_antes: 5, version: 1 };
    for (const id of ["0", "999999999", "9007199254740991", "99999999999999999999", "abc", "-1"]) {
      const put = await admin.put(`${RUTA}/${id}`).send(cuerpo);
      const del = await admin.delete(`${RUTA}/${id}`);
      if (put.status !== 404 || del.status !== 404) {
        fallos.push(`id ${id}: PUT ${put.status} DELETE ${del.status}`);
      }
    }
    expect(fallos).toEqual([]);
    expect((await listar()).planes).toHaveLength(1);
  });

  it("no hay dos planes del mismo tipo, ni al crear ni al cambiar el tipo", async () => {
    await crear();
    const repetido = await admin.post(RUTA).send(planDe(" VOLQUETE "));
    expect(repetido.status).toBe(409);
    expect(JSON.stringify(repetido.body)).toContain("Ya hay un plan");
    const otro = await crear(planDe("Horno"));
    const choque = await admin
      .put(`${RUTA}/${otro.id}`)
      .send({ ...planDe("volquete"), aviso_antes: 5, version: 1 });
    expect(choque.status).toBe(409);
    expect((await listar()).planes.map((p) => p.tipo_equipo)).toEqual(["Horno", "Volquete"]);
  });

  it("de varias altas a la vez del mismo tipo queda una sola", async () => {
    const r = await Promise.all(Array.from({ length: 5 }, () => admin.post(RUTA).send(planDe())));
    expect(r.map((x) => x.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect((await listar()).planes).toHaveLength(1);
  });

  it("de varias ediciones a la vez sobre la misma versión entra una sola", async () => {
    const p = await crear();
    const r = await Promise.all(
      [10, 20, 30, 40, 50].map((aviso_antes) =>
        admin.put(`${RUTA}/${p.id}`).send({ ...planDe(), aviso_antes, version: 1 })
      )
    );
    expect(r.map((x) => x.status).sort()).toEqual([200, 409, 409, 409, 409]);
    const [quedo] = (await listar()).planes;
    expect(quedo.version).toBe(2);
    expect(quedo.aviso_antes).toBe(r.find((x) => x.status === 200)!.body.aviso_antes);
    const vieja = await admin
      .put(`${RUTA}/${p.id}`)
      .send({ ...planDe(), aviso_antes: 5, version: 1 });
    expect(vieja.status).toBe(409);
  });

  it("el tope de planes por empresa se respeta aunque lleguen varios a la vez", async () => {
    await withTenant(a.tenant.id, (c) =>
      c.query(
        `INSERT INTO mantenimiento_planes
           (tenant_id, tipo_equipo, medida, intervalo, aviso_antes, ciclo, niveles)
         SELECT $1, 'Relleno ' || n, 'horometro', 250, 25, '{1}',
                '{"1":{"tareas":["x"],"repuestos":[]}}'
           FROM generate_series(1, $2::int) n`,
        [a.tenant.id, MAX_PLANES_POR_EMPRESA - 1]
      )
    );
    const r = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => admin.post(RUTA).send(planDe(`Nuevo ${n}`)))
    );
    expect(r.every((x) => x.status === 201 || x.status === 409)).toBe(true);
    expect((await listar()).planes).toHaveLength(MAX_PLANES_POR_EMPRESA);
  });

  it("admin y operador escriben; Lectura solo mira; sin sesión no entra", async () => {
    const operador = await persona("operador");
    const lectura = await persona("lectura");
    const p = await crear(planDe("Del operador"), operador);
    const cuerpo = { ...planDe("Del operador"), aviso_antes: 5, version: 1 };
    expect((await lectura.get(RUTA)).status).toBe(200);
    expect((await lectura.post(RUTA).send(planDe("Lectura"))).status).toBe(403);
    expect((await lectura.put(`${RUTA}/${p.id}`).send(cuerpo)).status).toBe(403);
    expect((await lectura.delete(`${RUTA}/${p.id}`)).status).toBe(403);
    expect((await request(app).get(RUTA)).status).toBe(401);
    expect((await operador.put(`${RUTA}/${p.id}`).send(cuerpo)).status).toBe(200);
    expect((await operador.delete(`${RUTA}/${p.id}`)).status).toBe(200);
  });

  it("una empresa sin el módulo no entra", async () => {
    const sin = await nueva(["documentos"]);
    const ag = await entrar(sin);
    expect((await ag.get(RUTA)).status).toBe(403);
    expect((await ag.post(RUTA).send(planDe())).status).toBe(403);
  });

  it("otra empresa no ve, no edita ni quita, y puede tener el mismo tipo", async () => {
    const p = await crear();
    const deB = await listar(adminB);
    expect(deB).toEqual({ planes: [], tiposSinPlan: [] });
    const cuerpo = { ...planDe(), aviso_antes: 5, version: 1 };
    expect((await adminB.put(`${RUTA}/${p.id}`).send(cuerpo)).status).toBe(404);
    expect((await adminB.delete(`${RUTA}/${p.id}`)).status).toBe(404);
    const propio = await crear(planDe(), adminB);
    expect(propio.equipos).toBe(0);
    expect((await listar()).planes).toHaveLength(1);
  });

  it("la auditoría guarda solo el id y lo rechazado no deja rastro", async () => {
    const c = await nueva();
    const ag = await entrar(c);
    const p = await crear(planDe(), ag);
    await ag.post(RUTA).send(planDe());
    await ag.post(RUTA).send({});
    const cuerpo = { ...planDe(), aviso_antes: 5, version: 1 };
    await ag.put(`${RUTA}/${p.id}`).send(cuerpo);
    await ag.put(`${RUTA}/${p.id}`).send(cuerpo);
    await ag.delete(`${RUTA}/${p.id}`);
    await ag.delete(`${RUTA}/${p.id}`);
    expect(await auditorias(c)).toEqual(
      ["crear", "actualizar", "quitar"].map((x) => ({
        accion: `mantenimiento.plan_${x}`,
        detalle: { planId: p.id },
      }))
    );
  });

  it("al clonar el respaldo, el plan llega igual a la otra empresa", async () => {
    const original = await crear();
    const destino = await nueva();
    const backup = await request(app)
      .post(`/api/platform/tenants/${a.tenant.id}/backups`)
      .set("Authorization", BEARER);
    expect(backup.status, JSON.stringify(backup.body)).toBe(201);
    const restaurado = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.tenant.id, confirmar: true });
    expect(restaurado.status, JSON.stringify(restaurado.body)).toBe(200);
    const copia = await withTenant(destino.tenant.id, (c) =>
      c.query(
        `SELECT tipo_equipo, medida, intervalo, aviso_antes, ciclo::int[] AS ciclo, niveles, version
           FROM mantenimiento_planes`
      )
    );
    const { id: _id, equipos: _equipos, ...esperado } = original;
    expect(copia.rows).toEqual([esperado]);
  });
});
