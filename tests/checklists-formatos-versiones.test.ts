/** tests/checklists-formatos-versiones.test.ts
 *
 * E5-1: formatos de checklist editables, con versiones y puntos críticos, en una empresa con SOLO `checklists`.
 *
 * 1. Editar crea una versión con su «qué cambió»; la versión original queda guardada.
 * 2. Un checklist ya llenado no cambia; uno llenado sin señal con una versión anterior se acepta y la recuerda.
 * 3. Volver a una versión crea otra; no reescribe la historia.
 * 4. Dos ediciones sobre la misma versión: una gana y la otra recibe 409.
 * 5. Desactivar; borrar un formato con checklists llenados da 409, no 500.
 * 6. Permisos, validaciones y aislamiento entre empresas.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/checklists";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;
interface Item {
  descripcion: string;
  critica: boolean;
}

describe("Checklists: versiones de formato y puntos críticos (E5-1)", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let admin: Agente;
  let adminB: Agente;

  const nueva = async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "checklists" ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
    const ag = request.agent(app);
    const login = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { e, ag };
  };
  const crear = async (ag: Agente = admin) => {
    const r = await ag.post(`${BASE}/plantillas`).send({
      nombre: idUnico("Volquete"),
      items: [{ descripcion: "Frenos", critica: true }, { descripcion: "Luces" }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: Number(r.body.id), nombre: r.body.nombre as string };
  };
  const ver = async (id: number, ag: Agente = admin) =>
    (await ag.get(`${BASE}/plantillas/${id}`)).body as {
      version: number;
      activa: boolean;
      nombre: string;
      items: Item[];
    };
  const versiones = async (id: number) => {
    const r = await admin.get(`${BASE}/plantillas/${id}/versiones`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { version: number; cambio: string | null; items: Item[] }[];
  };
  const edicion = (nombre: string, extra: Record<string, unknown> = {}) => ({
    version_base: 1,
    cambio: "Se agrega la bocina",
    nombre,
    items: [
      { descripcion: "Frenos", critica: true },
      { descripcion: "Luces", critica: false },
      { descripcion: "Bocina", critica: true },
    ],
    ...extra,
  });
  const llenar = (plantillaId: number, extra: Record<string, unknown> = {}) =>
    admin.post(BASE).send({
      plantilla_id: plantillaId,
      activo_texto: "Horno 4",
      items: [{ descripcion: "Frenos", estado: "bien" }],
      ...extra,
    });

  beforeAll(async () => {
    const x = await nueva();
    const y = await nueva();
    a = x.e;
    admin = x.ag;
    adminB = y.ag;
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("un formato nuevo es la versión 1, activa, con sus puntos críticos", async () => {
    const { id } = await crear();
    const f = await ver(id);
    expect(f).toMatchObject({ version: 1, activa: true });
    expect(f.items.map((i) => i.critica)).toEqual([true, false]);
    expect(await versiones(id)).toMatchObject([{ version: 1, cambio: null }]);
  });

  it("editar crea una versión con su cambio y guarda la original", async () => {
    const { id, nombre } = await crear();
    const r = await admin.put(`${BASE}/plantillas/${id}`).send(edicion(nombre));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id, version: 2 });
    const f = await ver(id);
    expect(f.version).toBe(2);
    expect(f.items.map((i) => i.descripcion)).toEqual(["Frenos", "Luces", "Bocina"]);
    const v = await versiones(id);
    expect(v.map((x) => x.version)).toEqual([2, 1]);
    expect(v[0].cambio).toBe("Se agrega la bocina");
    expect(v[1].items).toEqual([
      { descripcion: "Frenos", critica: true },
      { descripcion: "Luces", critica: false },
    ]);
  });

  it("lo ya llenado no cambia, y lo llenado sin señal con la versión anterior se acepta y la recuerda", async () => {
    const { id, nombre } = await crear();
    const antes = await llenar(id);
    expect(antes.status, JSON.stringify(antes.body)).toBe(201);
    expect(antes.body.plantilla_version).toBe(1);
    await admin.put(`${BASE}/plantillas/${id}`).send(edicion(nombre));

    const viejo = await llenar(id, { plantilla_version: 1 });
    expect(viejo.status, JSON.stringify(viejo.body)).toBe(201);
    expect(viejo.body.plantilla_version).toBe(1);
    // La versión 2 agrega una pregunta crítica: ahora hay que responderla.
    expect((await llenar(id)).status).toBe(400);
    const completo = {
      items: ["Frenos", "Bocina"].map((descripcion) => ({ descripcion, estado: "bien" })),
    };
    expect((await llenar(id, completo)).body.plantilla_version).toBe(2);
    // Una versión que todavía no existe no se anota.
    const futura = await llenar(id, { ...completo, plantilla_version: 99 });
    expect(futura.body.plantilla_version).toBe(2);

    const detalle = await admin.get(`${BASE}/${antes.body.id}`);
    expect(detalle.body.plantilla_version).toBe(1);
    expect(detalle.body.items).toHaveLength(1);
  });

  it("volver a una versión crea otra y no reescribe la historia", async () => {
    const { id, nombre } = await crear();
    await admin.put(`${BASE}/plantillas/${id}`).send(edicion(nombre));
    const r = await admin
      .post(`${BASE}/plantillas/${id}/versiones/1/restaurar`)
      .send({ version_base: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.version).toBe(3);
    expect((await ver(id)).items.map((i) => i.descripcion)).toEqual(["Frenos", "Luces"]);
    const v = await versiones(id);
    expect(v.map((x) => x.version)).toEqual([3, 2, 1]);
    expect(v[0].cambio).toBe("Vuelve a la versión 1");
    const ruta = `${BASE}/plantillas/${id}/versiones`;
    expect((await admin.post(`${ruta}/9/restaurar`).send({ version_base: 3 })).status).toBe(404);
    expect((await admin.post(`${ruta}/3/restaurar`).send({ version_base: 3 })).status).toBe(400);
    expect((await admin.post(`${ruta}/1/restaurar`).send({ version_base: 2 })).status).toBe(409);
  });

  it("dos ediciones sobre la misma versión: una gana y la otra recibe 409", async () => {
    const { id, nombre } = await crear();
    const [x, y] = await Promise.all([
      admin.put(`${BASE}/plantillas/${id}`).send(edicion(nombre, { cambio: "Cambio de Ana" })),
      admin.put(`${BASE}/plantillas/${id}`).send(edicion(nombre, { cambio: "Cambio de Luis" })),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await versiones(id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it("se desactiva y se activa; con checklists llenados no se borra (409), sin ellos sí", async () => {
    const { id } = await crear();
    const off = await admin.patch(`${BASE}/plantillas/${id}/estado`).send({ activa: false });
    expect(off.status).toBe(200);
    expect(off.body.activa).toBe(false);
    // Un envío que venía sin señal con ese formato no se pierde.
    expect((await llenar(id)).status).toBe(201);
    const borrar = await admin.delete(`${BASE}/plantillas/${id}`);
    expect(borrar.status, JSON.stringify(borrar.body)).toBe(409);

    const otro = await crear();
    await admin.put(`${BASE}/plantillas/${otro.id}`).send(edicion(otro.nombre));
    expect((await admin.delete(`${BASE}/plantillas/${otro.id}`)).status).toBe(200);
  });

  it("valida el cuerpo, respeta los perfiles y no cruza empresas", async () => {
    const { id, nombre } = await crear();
    const ruta = `${BASE}/plantillas/${id}`;
    for (const malo of [
      edicion(nombre, { cambio: "  " }),
      edicion(nombre, { items: [] }),
      edicion(nombre, { version_base: 0 }),
      edicion(nombre, { items: [{ descripcion: "X", critica: "si" }] }),
    ]) {
      expect((await admin.put(ruta).send(malo)).status).toBe(400);
    }
    const dni = dniUnico();
    await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Lectura", dni, password: PASSWORD, rol: "lectura" });
    const lectura = request.agent(app);
    await lectura
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, identificador: dni, password: PASSWORD });
    expect((await lectura.get(`${ruta}/versiones`)).status).toBe(200);
    expect((await lectura.put(ruta).send(edicion(nombre))).status).toBe(403);
    expect((await lectura.patch(`${ruta}/estado`).send({ activa: false })).status).toBe(403);

    expect((await adminB.get(`${ruta}/versiones`)).status).toBe(404);
    expect((await adminB.put(ruta).send(edicion(nombre))).status).toBe(404);
    expect((await adminB.patch(`${ruta}/estado`).send({ activa: false })).status).toBe(404);
    expect(await ver(id)).toMatchObject({ version: 1, activa: true });
  });
});
