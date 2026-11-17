/** tests/equipos-autonomia.test.ts
 *
 * Registro de unidades (Flota) funciona solo. Lo que lee de otros módulos —las rutas habituales y
 * el catálogo de lugares, de Viajes; el aviso por correo del consumo y la capacidad, de
 * Combustible— se OMITE sin ese módulo: no falla, no devuelve un 403 y la consulta ni se ejecuta.
 * Lo que se fija:
 *
 * 1. Una empresa con SOLO Flota da de alta, edita, lista, ve el historial y exporta; las rutas
 *    salen vacías y el catálogo de lugares también. Ampliar la capacidad no manda correo.
 * 2. Con Viajes, las rutas sí se ven en la lista y en el historial.
 * 3. Una empresa que PIERDE Viajes deja de ver las rutas, y las filas se conservan: si el módulo
 *    vuelve, reaparecen.
 * 4. Con Combustible, ampliar la capacidad sigue avisando (el correo se arma; sin destinatarios
 *    marcados la lista va vacía, igual que antes).
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const correos: { asunto: string }[] = [];
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(async (args: { asunto: string }) => {
    correos.push({ asunto: args.asunto });
  }),
}));

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("Registro de unidades: autonomía de Flota", () => {
  const empresas: Empresa[] = [];

  /** Una empresa con exactamente esos módulos habilitados. */
  const nueva = async (modulos: string[]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    await ponerModulos(e, modulos);
    return e;
  };
  const ponerModulos = async (e: Empresa, modulos: string[]) => {
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
  // Los módulos del usuario viajan en el JWT: tras cambiarlos hay que entrar de nuevo.
  const sesion = async (e: Empresa) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return agente;
  };
  type Agente = Awaited<ReturnType<typeof sesion>>;

  const lugar = async (admin: Agente, nombre: string) => {
    const r = await admin.post("/api/erp/viajes/lugares").send({ nombre });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };
  const historial = async (admin: Agente, id: number) =>
    (await admin.get(`/api/erp/equipos/${id}/historial`)).body;
  const fila = async (admin: Agente, id: number) =>
    (await admin.get("/api/erp/equipos")).body.data.find((x: { id: number }) => x.id === id);

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("una empresa con SOLO Flota da de alta, edita, lista, ve el historial y exporta, sin rutas ni correos de combustible", async () => {
    correos.length = 0;
    const e = await nueva(["flota"]);
    const admin = await sesion(e);
    // De verdad es solo Flota.
    expect((await admin.get("/api/erp/combustible")).status).toBe(403);
    expect((await admin.get("/api/erp/viajes/lugares")).status).toBe(403);

    const creada = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("AU"),
      tipo: "Volquete",
      tipo_medidor: "horometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: "40000099",
      capacidad_tanque: 100,
      capacidad_tanque_unidad: "L",
    });
    expect(creada.status, JSON.stringify(creada.body)).toBe(201);
    expect(creada.body.rutas).toEqual([]);
    const id = creada.body.id as number;

    // Ampliar la capacidad avisaría a Combustible: sin el módulo no se envía nada y el PUT sale bien.
    const edit = await admin.put(`/api/erp/equipos/${id}`).send({
      placa_codigo: creada.body.placa_codigo,
      tipo: "Volquete",
      // El PUT reemplaza la ficha: el mismo conductor, o se tomaría como quitarlo (pide motivo).
      conductor_nombre: "Juan Pérez",
      conductor_dni: "40000099",
      capacidad_tanque: 500,
      capacidad_tanque_unidad: "L",
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.rutas).toEqual([]);
    expect(correos).toHaveLength(0);

    expect((await fila(admin, id)).rutas).toEqual([]);
    const h = await historial(admin, id);
    expect(h.conductores).toHaveLength(1);
    expect(h.rutas).toEqual([]);
    const lugares = await admin.get("/api/erp/equipos/lugares");
    expect(lugares.status).toBe(200);
    expect(lugares.body).toEqual([]);
    expect((await admin.get("/api/erp/equipos/export/xlsx")).status).toBe(200);
  });

  it("con Viajes las rutas se ven en la lista y en el historial, y el catálogo de lugares aparece", async () => {
    const e = await nueva(["flota", "viajes"]);
    const admin = await sesion(e);
    const lima = await lugar(admin, idUnico("Lima"));
    const ica = await lugar(admin, idUnico("Ica"));

    const creada = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("AV"),
      tipo: "Volquete",
      conductor_nombre: "Ana Ruiz",
      conductor_dni: "40000098",
      rutas: [{ origen_id: lima, destino_id: ica }],
    });
    expect(creada.status, JSON.stringify(creada.body)).toBe(201);
    expect(creada.body.rutas).toHaveLength(1);
    const id = creada.body.id as number;

    expect((await fila(admin, id)).rutas).toHaveLength(1);
    expect((await historial(admin, id)).rutas).toHaveLength(1);
    expect((await admin.get("/api/erp/equipos/lugares")).body.length).toBeGreaterThanOrEqual(2);
  });

  it("si la empresa pierde Viajes, las rutas se omiten pero se conservan: al volver, reaparecen", async () => {
    const e = await nueva(["flota", "viajes"]);
    let admin = await sesion(e);
    const lima = await lugar(admin, idUnico("Lima"));
    const ica = await lugar(admin, idUnico("Ica"));
    const creada = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("AP"),
      tipo: "Volquete",
      conductor_nombre: "Luis Soto",
      conductor_dni: "40000097",
      rutas: [{ origen_id: lima, destino_id: ica }],
    });
    expect(creada.status).toBe(201);
    const id = creada.body.id as number;

    await ponerModulos(e, ["flota"]);
    admin = await sesion(e);
    expect((await fila(admin, id)).rutas).toEqual([]);
    expect((await historial(admin, id)).rutas).toEqual([]);
    expect((await admin.get("/api/erp/equipos/lugares")).body).toEqual([]);

    await ponerModulos(e, ["flota", "viajes"]);
    admin = await sesion(e);
    expect((await fila(admin, id)).rutas).toHaveLength(1);
    expect((await historial(admin, id)).rutas).toHaveLength(1);
  });

  it("con Combustible, ampliar la capacidad sigue avisando", async () => {
    correos.length = 0;
    const e = await nueva(["flota", "combustible"]);
    const admin = await sesion(e);
    const creada = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("AC"),
      tipo: "Volquete",
      capacidad_tanque: 100,
      capacidad_tanque_unidad: "L",
    });
    expect(creada.status, JSON.stringify(creada.body)).toBe(201);
    const edit = await admin.put(`/api/erp/equipos/${creada.body.id}`).send({
      placa_codigo: creada.body.placa_codigo,
      tipo: "Volquete",
      capacidad_tanque: 500,
      capacidad_tanque_unidad: "L",
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(correos.map((c) => c.asunto).join("|")).toMatch(/se amplió el techo diario/);
  });
});
