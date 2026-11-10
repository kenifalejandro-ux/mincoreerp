/** tests/viajes-alcance.test.ts
 *
 * La lista y el detalle de Viajes respetan el grifo de la unidad: quien tiene alcance a un grifo
 * ve solo los viajes de sus unidades; el viaje de otro grifo responde 404 (como si no existiera);
 * el admin ve todo. (Una unidad sin grifo no puede existir: la base lo impide.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

const PASSWORD = "ClaveDePrueba123";
const H = 3_600_000;
const T0 = Date.now() - 50 * H;

describe("viajes: alcance por grifo", () => {
  let tenantId: string;
  let admin: Agente;
  let lector: Agente;
  let seq = 0;
  const viaje: Record<"a" | "b", number> = { a: 0, b: 0 };

  beforeAll(async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    tenantId = e.tenant.id;
    admin = request.agent(app);
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD })
      .expect(200);

    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    const grifoA = sedes[0].grifos[0].id as number;
    const grifoB = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: "Grifo B" })
    ).body.id as number;
    const lugar = async () =>
      Number((await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("L") })).body.id);
    const [o, d] = [await lugar(), await lugar()];

    const nuevo = async (grifo: number) => {
      const eq = await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("V"),
        tipo: "VOLQUETE",
        tipo_medidor: "odometro",
        conductor_nombre: "Juan Pérez",
        conductor_dni: String(43000000 + seq++),
        grifo_interno_id: grifo,
      });
      expect(eq.status, JSON.stringify(eq.body)).toBe(201);
      const v = await admin
        .post("/api/erp/viajes")
        .send({ equipo_id: eq.body.id, paradas: [o, d], inicio_en: new Date(T0).toISOString() });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      return { equipo: Number(eq.body.id), viaje: Number(v.body.id) };
    };
    viaje.a = (await nuevo(grifoA)).viaje;
    viaje.b = (await nuevo(grifoB)).viaje;

    const dni = String(86900000 + Math.floor(Math.random() * 90000));
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Lector", dni, password: PASSWORD, rol: "lectura" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const p = await admin.put(`/api/erp/usuarios/${alta.body.id}/permisos`).send({
      modulos: [],
      alcanceCombustible: { todo: false, sedes: [], grifos: [grifoA], surtidores: [] },
      motivo: "Solo el grifo A",
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    lector = request.agent(app);
    await lector
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, identificador: dni, password: PASSWORD })
      .expect(200);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const ids = (r: request.Response) => (r.body.data as { id: number }[]).map((v) => Number(v.id));

  it("el admin ve los dos viajes", async () => {
    const r = await admin.get("/api/erp/viajes");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ids(r)).toEqual(expect.arrayContaining([viaje.a, viaje.b]));
  });

  it("el lector con alcance al grifo A ve solo el viaje de ese grifo", async () => {
    const r = await lector.get("/api/erp/viajes");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ids(r)).toEqual([viaje.a]);
  });

  it("el detalle del viaje de otro grifo es un 404", async () => {
    for (const id of [viaje.b]) {
      const r = await lector.get(`/api/erp/viajes/${id}`);
      expect(r.status, `viaje ${id}`).toBe(404);
    }
    expect((await lector.get(`/api/erp/viajes/${viaje.a}`)).status).toBe(200);
    // El admin sí abre cualquiera.
    for (const id of [viaje.a, viaje.b]) {
      expect((await admin.get(`/api/erp/viajes/${id}`)).status, `viaje ${id}`).toBe(200);
    }
  });
});
