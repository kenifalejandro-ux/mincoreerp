/** tests/combustible-bandeja-alertas.test.ts
 *
 * La API de la Bandeja: los filtros nuevos de GET /alertas y los contadores
 * de GET /alertas/resumen.
 *
 * Lo que no se puede romper: que un filtro abra una puerta que el alcance
 * cerraba. Cada filtro se prueba también con quien ve UN solo grifo, con su
 * gemelo "sí lo ve" -- un "no lo ve" solo podría ser que la consulta entera
 * devuelve vacío.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";

afterAll(async () => {
  await closeDatabase();
});

type Fila = {
  id: string;
  tipo: string;
  grifo_interno_id: number | null;
  grifo_nombre: string | null;
  revisable: boolean;
  leida_en: string | null;
  resuelta_en: string | null;
};

describe("Bandeja de alertas: filtros y contadores dentro del alcance", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  const jefeA = request.agent(app);
  let grifoA: number;
  let grifoB: number;
  let tanqueA: number;
  let tanqueB: number;
  const ids: Record<string, string> = {};

  async function tanque(grifo: number) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: `Tanque ${grifo}`,
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
    return r.body.id as number;
  }

  /** Una alerta puesta a mano: el trigger de 0097 le pone el grifo del
   *  tanque, igual que a cualquier otra. */
  const alerta = (
    combustibleId: number,
    tipo: string,
    extra: { creadoEn?: string; leida?: boolean; resuelta?: boolean; detalle?: object } = {}
  ) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO combustible_alertas
           (tenant_id, tipo, combustible_id, producto, detalle, creado_en, leida_en, resuelta_en)
         VALUES ($1, $2, $3, 'combustible', $4::jsonb, COALESCE($5::timestamptz, now()),
                 CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END)
         RETURNING id`,
        [
          tenantId,
          tipo,
          combustibleId,
          JSON.stringify(extra.detalle ?? {}),
          extra.creadoEn ?? null,
          extra.leida ?? false,
          extra.resuelta ?? false,
        ]
      );
      return r.rows[0].id;
    });

  const listar = async (ag: ReturnType<typeof request.agent>, query: string) => {
    const r = await ag.get(`/api/erp/combustible/alertas?pageSize=100&${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as Fila[];
  };
  const idsDe = (filas: Fila[]) => filas.map((f) => String(f.id));

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
    tanqueA = await tanque(grifoA);
    tanqueB = await tanque(grifoB);

    // Un operador que ve SOLO el grifo A.
    const email = `jefea-${slug}@test.local`.toLowerCase();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Jefe A", email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    const permisos = (await admin.get(`/api/erp/usuarios/${alta.body.id}/permisos`)).body as {
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
      alertasCorreo: { modulo: string; recibeAlertas: boolean }[];
    };
    const put = await admin.put(`/api/erp/usuarios/${alta.body.id}/permisos`).send({
      modulos: permisos.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.modulo === "combustible" ? true : m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: permisos.alertasCorreo,
      alcanceCombustible: { todo: false, sedes: [], surtidores: [], grifos: [grifoA] },
      motivo: "prueba automatizada: bandeja",
    });
    expect(put.status).toBe(200);
    await jefeA.post("/api/auth/login").send({ tenantSlug: slug, email, password: PASSWORD });

    // A: una sin leer, una leída sin resolver, una resuelta, una de ayer.
    ids.aNueva = await alerta(tanqueA, "descuadre_inventario", {
      detalle: { tanqueNombre: "Cancha Norte" },
    });
    ids.aLeida = await alerta(tanqueA, "nivel_bajo", { leida: true });
    ids.aResuelta = await alerta(tanqueA, "consumo_excedido", { leida: true, resuelta: true });
    ids.aVieja = await alerta(tanqueA, "descuadre_ciclo", {
      creadoEn: "2026-01-15T15:00:00Z",
    });
    // B: solo la ve quien ve toda la empresa.
    ids.bNueva = await alerta(tanqueB, "descuadre_inventario");
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("cada estado trae lo suyo", async () => {
    const sinLeer = idsDe(await listar(admin, "estado=sin_leer"));
    expect(sinLeer).toEqual(expect.arrayContaining([ids.aNueva, ids.bNueva, ids.aVieja]));
    expect(sinLeer).not.toContain(ids.aLeida);

    const pendientes = idsDe(await listar(admin, "estado=pendientes"));
    expect(pendientes).toEqual(expect.arrayContaining([ids.aNueva, ids.aLeida]));
    expect(pendientes).not.toContain(ids.aResuelta);

    const resueltas = idsDe(await listar(admin, "estado=resueltas"));
    expect(resueltas).toContain(ids.aResuelta);
    expect(resueltas).not.toContain(ids.aNueva);
  });

  it("ningún filtro deja ver un grifo fuera del alcance", async () => {
    for (const q of [
      "estado=todas",
      "estado=sin_leer",
      "tipo=descuadre_inventario",
      `grifo_interno_id=${grifoB}`,
      "q=descuadre",
    ]) {
      const vistos = idsDe(await listar(jefeA, q));
      expect(vistos, q).not.toContain(ids.bNueva);
    }
    // El gemelo: lo suyo sí lo ve.
    expect(idsDe(await listar(jefeA, "tipo=descuadre_inventario"))).toContain(ids.aNueva);
  });

  it("filtra por tipo, por grifo y trae el nombre del grifo", async () => {
    const porTipo = await listar(admin, "tipo=descuadre_inventario");
    expect(idsDe(porTipo)).toEqual(expect.arrayContaining([ids.aNueva, ids.bNueva]));
    expect(porTipo.every((f) => f.tipo === "descuadre_inventario")).toBe(true);

    const deB = await listar(admin, `grifo_interno_id=${grifoB}`);
    expect(idsDe(deB)).toEqual([ids.bNueva]);
    expect(deB[0].grifo_nombre).toBe("Punto B");
  });

  it("las fechas son días de Lima, ambos extremos inclusive", async () => {
    // 15:00 UTC del 15 de enero = 10:00 del 15 en Lima.
    expect(idsDe(await listar(admin, "desde=2026-01-15&hasta=2026-01-15"))).toEqual([ids.aVieja]);
    expect(idsDe(await listar(admin, "desde=2026-01-16&hasta=2026-01-16"))).toEqual([]);
    expect(idsDe(await listar(admin, "desde=2026-01-16"))).not.toContain(ids.aVieja);
  });

  it("busca en el detalle sin interpretar comodines", async () => {
    expect(idsDe(await listar(admin, "q=Cancha%20Norte"))).toEqual([ids.aNueva]);
    // Un "%" del usuario es un carácter, no "cualquier cosa".
    expect(idsDe(await listar(admin, "q=%25"))).toEqual([]);
  });

  it("dice qué se puede cerrar a mano: el hueco no, el descuadre sí", async () => {
    const filas = await listar(admin, "estado=todas");
    const nueva = filas.find((f) => String(f.id) === ids.aNueva)!;
    expect(nueva.revisable).toBe(true);
    const hueco = await alerta(tanqueA, "hueco_detectado");
    const conHueco = await listar(admin, "tipo=hueco_detectado");
    expect(conHueco.find((f) => String(f.id) === hueco)!.revisable).toBe(false);
  });

  it("los contadores respetan el alcance y los demás filtros", async () => {
    const todo = await admin.get("/api/erp/combustible/alertas/resumen?tipo=descuadre_inventario");
    expect(todo.status).toBe(200);
    expect(todo.body.total).toBe(2);
    expect(todo.body.sinLeer).toBe(2);

    const soloA = await jefeA.get("/api/erp/combustible/alertas/resumen?tipo=descuadre_inventario");
    expect(soloA.status).toBe(200);
    expect(soloA.body.total).toBe(1);

    const resA = (await jefeA.get("/api/erp/combustible/alertas/resumen")).body;
    expect(resA.resueltas).toBeGreaterThanOrEqual(1);
    expect(resA.pendientes).toBe(resA.total - resA.resueltas);
  });

  it("pide una alerta por su id (la Bandeja la necesita aunque no esté en la página), dentro del alcance", async () => {
    // Llegar desde la campanita: la alerta puede ser más antigua que la página cargada.
    const suya = await listar(jefeA, `id=${ids.aVieja}&estado=todas`);
    expect(idsDe(suya)).toEqual([ids.aVieja]);
    // El filtro por id NO es una puerta al grifo ajeno: el alcance se aplica igual.
    const ajena = await listar(jefeA, `id=${ids.bNueva}&estado=todas`);
    expect(ajena).toEqual([]);
    // El gemelo: quien ve toda la empresa sí la trae.
    expect(idsDe(await listar(admin, `id=${ids.bNueva}&estado=todas`))).toEqual([ids.bNueva]);
  });

  it("un filtro malformado es 400, no una lista vacía", async () => {
    for (const q of [
      "estado=borradas",
      "tipo=DROP%20TABLE",
      "grifo_interno_id=abc",
      "id=abc",
      "desde=15-01-2026",
    ]) {
      const r = await admin.get(`/api/erp/combustible/alertas?${q}`);
      expect(r.status, q).toBe(400);
    }
    const r = await admin.get("/api/erp/combustible/alertas/resumen?estado=borradas");
    expect(r.status).toBe(400);
  });
});

describe("Bandeja de alertas: auditoría adversaria", () => {
  let tenantA: string;
  let tenantB: string;
  const adminA = request.agent(app);
  const adminB = request.agent(app);
  let alertaDeA: string;

  // Cada empresa lleva SU marca: con la misma en las dos, "no la encontró B"
  // no se distingue de "B encontró la suya".
  const alerta = (tenantId: string, combustibleId: number, marca: string) =>
    withTenant(tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO combustible_alertas (tenant_id, tipo, combustible_id, producto, detalle)
         VALUES ($1, 'descuadre_inventario', $2, 'combustible', jsonb_build_object('secreto', $3::text))
         RETURNING id`,
        [tenantId, combustibleId, marca]
      );
      return r.rows[0].id;
    });

  async function tanqueDe(agente: ReturnType<typeof request.agent>) {
    const sedes = (await agente.get("/api/erp/sedes")).body.sedes;
    const r = await agente.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: sedes[0].grifos[0].id,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  beforeAll(async () => {
    const a = await crearTenantDePrueba(PASSWORD);
    const b = await crearTenantDePrueba(PASSWORD);
    tenantA = a.tenant.id;
    tenantB = b.tenant.id;
    await adminA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: a.usuario.email, password: PASSWORD });
    await adminB
      .post("/api/auth/login")
      .send({ tenantSlug: b.tenant.slug, email: b.usuario.email, password: PASSWORD });
    alertaDeA = await alerta(tenantA, await tanqueDe(adminA), "marca-solo-de-A");
    await alerta(tenantB, await tanqueDe(adminB), "marca-solo-de-B");
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantA);
    await borrarTenantDePrueba(tenantB);
  });

  it("otra empresa no ve la alerta ni por id, ni por búsqueda, ni en los contadores", async () => {
    const porId = await adminB.get(`/api/erp/combustible/alertas?id=${alertaDeA}&estado=todas`);
    expect(porId.status).toBe(200);
    expect(porId.body.data).toEqual([]);

    const porTexto = await adminB.get(
      "/api/erp/combustible/alertas?q=marca-solo-de-A&estado=todas"
    );
    expect(porTexto.body.data).toEqual([]);

    // El gemelo: la dueña sí la ve por esas mismas vías.
    const suya = await adminA.get(`/api/erp/combustible/alertas?id=${alertaDeA}&estado=todas`);
    expect(suya.body.data).toHaveLength(1);
    expect(
      (await adminA.get("/api/erp/combustible/alertas?q=marca-solo-de-A")).body.data
    ).toHaveLength(1);

    const resumenB = (await adminB.get("/api/erp/combustible/alertas/resumen")).body;
    expect(resumenB.total).toBe(1);
  });

  it("la búsqueda trata todo como texto: comillas, comodines y barras no rompen la consulta", async () => {
    for (const q of ["'; DROP TABLE combustible_alertas;--", "\\", "100%", "_", "a\\%b", '"x"']) {
      const r = await adminA.get(`/api/erp/combustible/alertas?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      const c = await adminA.get(`/api/erp/combustible/alertas/resumen?q=${encodeURIComponent(q)}`);
      expect(c.status, q).toBe(200);
    }
    // La tabla sigue ahí.
    expect((await adminA.get("/api/erp/combustible/alertas")).body.data.length).toBeGreaterThan(0);
  });

  it("las fechas válidas pasan, bisiestas incluidas, y las imposibles son 400", async () => {
    // El lado que faltaba: una validación que rechaza TODO también "pasa" los 400.
    for (const q of [
      "desde=2028-02-29",
      "hasta=2026-12-31",
      "desde=2026-01-01&hasta=2026-01-01",
      "desde=2024-02-29",
    ]) {
      const r = await adminA.get(`/api/erp/combustible/alertas?${q}`);
      expect(r.status, q).toBe(200);
    }
    for (const q of [
      "desde=2026-02-31",
      "hasta=2026-13-01",
      "desde=2026-00-10",
      "hasta=2026-04-31",
      "desde=2026-03-00",
      "desde=2027-02-29", // 2027 no es bisiesto
      "desde=2100-02-29", // ni 2100 (divisible por 100 y no por 400)
      "hasta=2026-1-5",
      "desde=hoy",
    ]) {
      const r = await adminA.get(`/api/erp/combustible/alertas?${q}`);
      expect(r.status, q).toBe(400);
    }
  });

  it("un id fuera de rango no revienta", async () => {
    for (const id of ["0", "-3", "1.5", "99999999999999999999", "1e3"]) {
      const r = await adminA.get(`/api/erp/combustible/alertas?id=${id}`);
      expect([200, 400], id).toContain(r.status);
    }
  });
});
