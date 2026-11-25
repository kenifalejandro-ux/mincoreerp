/** tests/ordenes-trabajo-horas-tareas.test.ts
 *
 * E5-5: hora de inicio y cierre escritas a mano (la oficina, también después), duración calculada, «la unidad no
 * puede operar» y tareas de la orden. Empresa con SOLO Órdenes de trabajo.
 */
import { randomUUID } from "node:crypto";

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { fijarCuotaTenant } from "../src/server/services/platformCuotas.service";
import { MODULOS } from "../src/modules/registry";

const PASSWORD = "ClaveDePrueba123";
const BASE = "/api/erp/ordenes_trabajo";
const BEARER = `Bearer ${env.platformAdminToken}`;
/** Hace `h` horas, redondeado al minuto para que la duración sea exacta. */
const hace = (h: number) =>
  new Date(Math.floor(Date.now() / 60_000) * 60_000 - h * 3_600_000).toISOString();

describe("Órdenes de trabajo: horas, unidad no operativa y tareas (E5-5)", () => {
  const empresas: Awaited<ReturnType<typeof crearTenantDePrueba>>[] = [];

  const nueva = async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: m.id === "ordenes_trabajo" ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
    const ag = request.agent(app);
    const login = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { ag, id: e.tenant.id };
  };
  let a: Awaited<ReturnType<typeof nueva>>;
  let b: Awaited<ReturnType<typeof nueva>>;

  beforeAll(async () => {
    a = await nueva();
    b = await nueva();
  });
  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  const crear = async (extra: Record<string, unknown> = {}) => {
    const r = await a.ag.post(BASE).send({ activo_texto: "Horno 4", titulo: "Frenos", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const ver = async (id: number) => (await a.ag.get(`${BASE}/${id}`)).body;
  /** El PUT exige los campos de siempre. */
  const editar = (id: number, extra: Record<string, unknown>) =>
    a.ag.put(`${BASE}/${id}`).send({
      titulo: "Frenos",
      activo_texto: "Horno 4",
      tipo: "correctivo",
      prioridad: "media",
      ...extra,
    });
  const estado = (id: number, cuerpo: Record<string, unknown>) =>
    a.ag.patch(`${BASE}/${id}/estado`).send(cuerpo);
  const tareas = (id: number, cuerpo: Record<string, unknown>) =>
    a.ag.patch(`${BASE}/${id}/tareas`).send(cuerpo);

  it("se crea con tareas y marca; el reenvío no las duplica", async () => {
    const cuerpo = {
      cliente_uuid: randomUUID(),
      unidad_no_opera: true,
      tareas: [{ descripcion: "Desmontar" }, { descripcion: "Probar", hecha: true }],
    };
    const orden = await crear(cuerpo);
    expect(orden.unidad_no_opera).toBe(true);
    const otra = await a.ag
      .post(BASE)
      .send({ activo_texto: "Horno 4", titulo: "Frenos", ...cuerpo });
    expect(otra.status).toBe(200);
    expect(otra.body.tareas.map((t: { descripcion: string }) => t.descripcion)).toEqual([
      "Desmontar",
      "Probar",
    ]);
    const lista = await a.ag.get(BASE);
    expect(lista.body.data.find((o: { id: number }) => o.id === orden.id)).toMatchObject({
      tareas_total: 2,
      tareas_hechas: 1,
      unidad_no_opera: true,
      duracion_minutos: null,
    });
  });

  it("la oficina anota inicio y cierre pasados; la duración se calcula", async () => {
    const { id } = await crear();
    const iniciar = await estado(id, { estado: "en_progreso", inicio_en: hace(5) });
    expect(iniciar.status, JSON.stringify(iniciar.body)).toBe(200);
    const cerrar = await estado(id, { estado: "completada", fecha_cierre: hace(2) });
    expect(cerrar.status, JSON.stringify(cerrar.body)).toBe(200);
    expect(cerrar.body.duracion_minutos).toBe(180);

    // Corregir después; reasignar o editar sin las horas no las borra.
    expect((await editar(id, { inicio_en: hace(4) })).status).toBe(200);
    expect((await editar(id, {})).status).toBe(200);
    expect((await ver(id)).duracion_minutos).toBe(120);
    expect((await editar(id, { fecha_cierre: hace(1) })).body.id).toBe(id);
    expect((await ver(id)).duracion_minutos).toBe(180);
    expect((await editar(id, { inicio_en: null })).status).toBe(200);
    expect(await ver(id)).toMatchObject({ inicio_en: null, duracion_minutos: null });

    // Queda quién cambió las horas y cómo estaban antes.
    const rastro = await pool.query(
      `SELECT detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND accion = 'ordenes_trabajo.actualizar' AND detalle::text LIKE '%antes%'`,
      [a.id]
    );
    expect(rastro.rows.length).toBe(3);
  });

  it("sin hora de cierre anotada, vale la del momento", async () => {
    const { id } = await crear({ inicio_en: hace(1) });
    await estado(id, { estado: "en_progreso" });
    const cerrar = await estado(id, { estado: "completada" });
    expect(cerrar.body.duracion_minutos).toBeGreaterThanOrEqual(60);
    expect(cerrar.body.duracion_minutos).toBeLessThan(63);
  });

  it("rechaza horas futuras, cruzadas, mal escritas y el cierre de una orden abierta", async () => {
    const { id } = await crear({ inicio_en: hace(2) });
    const futura = new Date(Date.now() + 3_600_000).toISOString();
    expect((await editar(id, { inicio_en: futura })).status).toBe(400);
    expect((await editar(id, { inicio_en: "ayer" })).status).toBe(400);
    expect((await editar(id, { fecha_cierre: hace(1) })).status).toBe(400);
    expect((await estado(id, { estado: "en_progreso", fecha_cierre: hace(1) })).status).toBe(400);
    await estado(id, { estado: "en_progreso" });
    const cruzada = await estado(id, { estado: "completada", fecha_cierre: hace(3) });
    expect(cruzada.status, JSON.stringify(cruzada.body)).toBe(400);
    expect((await ver(id)).estado).toBe("en_progreso");
    await estado(id, { estado: "completada" });
    expect((await editar(id, { inicio_en: hace(0), fecha_cierre: hace(1) })).status).toBe(400);
  });

  it("agrega, marca y quita tareas, con tope, también con la cuota de órdenes llena", async () => {
    const { id } = await crear({ tareas: [{ descripcion: "Uno" }] });
    await fijarCuotaTenant(a.id, "ordenes_trabajo", 0);
    const r = await tareas(id, { agregar: [{ descripcion: "Dos" }, { descripcion: "Tres" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await fijarCuotaTenant(a.id, "ordenes_trabajo", undefined);
    const [uno, dos] = r.body.tareas;
    const cambio = await tareas(id, { marcar: [{ id: uno.id, hecha: true }], quitar: [dos.id] });
    expect(cambio.body.tareas).toMatchObject([
      { descripcion: "Uno", hecha: true },
      { descripcion: "Tres", hecha: false },
    ]);
    const muchas = Array.from({ length: 49 }, (_, i) => ({ descripcion: `T${i}` }));
    expect((await tareas(id, { agregar: muchas })).status).toBe(400);
    expect((await ver(id)).tareas).toHaveLength(2);
    expect((await tareas(id, { agregar: [{ descripcion: "  " }] })).status).toBe(400);
  });

  it("no toca tareas ni órdenes ajenas, y borrar la orden se lleva las suyas", async () => {
    const mia = await crear({ tareas: [{ descripcion: "Mía" }] });
    const otra = await crear();
    const idTarea = mia.tareas[0].id;
    expect((await tareas(otra.id, { marcar: [{ id: idTarea, hecha: true }] })).status).toBe(404);
    await tareas(otra.id, { quitar: [idTarea] });
    const ajena = await b.ag.patch(`${BASE}/${mia.id}/tareas`).send({ quitar: [idTarea] });
    expect(ajena.status).toBe(404);
    expect((await ver(mia.id)).tareas).toMatchObject([{ hecha: false }]);

    expect((await a.ag.delete(`${BASE}/${mia.id}`)).status).toBe(200);
    const quedan = await withTenant(a.id, (c) =>
      c.query("SELECT 1 FROM orden_trabajo_tareas WHERE orden_trabajo_id = $1", [mia.id])
    );
    expect(quedan.rows).toHaveLength(0);
  });

  it("varias personas a la vez: el tope de tareas se respeta y no hay errores 500", async () => {
    const { id } = await crear();
    const diez = Array.from({ length: 10 }, (_, i) => ({ descripcion: `A${i}` }));
    const r = await Promise.all(Array.from({ length: 8 }, () => tareas(id, { agregar: diez })));
    expect(r.map((x) => x.status).sort()).toEqual([200, 200, 200, 200, 200, 400, 400, 400]);
    expect((await ver(id)).tareas).toHaveLength(50);
  });

  it("dos cierres a la vez: uno entra y el otro recibe 409; horas y tareas a la vez no chocan", async () => {
    const { id } = await crear({ inicio_en: hace(5), tareas: [{ descripcion: "Una" }] });
    await estado(id, { estado: "en_progreso" });
    const tarea = (await ver(id)).tareas[0].id;
    const r = await Promise.all([
      estado(id, { estado: "completada", fecha_cierre: hace(2) }),
      estado(id, { estado: "cancelada", fecha_cierre: hace(1) }),
    ]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    const juntos = await Promise.all([
      editar(id, { inicio_en: hace(4) }),
      editar(id, { fecha_cierre: hace(3) }),
      tareas(id, { marcar: [{ id: tarea, hecha: true }] }),
      tareas(id, { agregar: [{ descripcion: "Dos" }] }),
    ]);
    expect(juntos.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect((await ver(id)).duracion_minutos).toBe(60);
  });

  it("el mismo envío repetido a la vez crea una sola orden con sus tareas", async () => {
    const cuerpo = {
      cliente_uuid: randomUUID(),
      activo_texto: "Horno 4",
      titulo: "Repetida",
      tareas: [{ descripcion: "Una" }],
    };
    const r = await Promise.all(Array.from({ length: 5 }, () => a.ag.post(BASE).send(cuerpo)));
    expect(r.map((x) => x.status).sort()).toEqual([200, 200, 200, 200, 201]);
    const n = await withTenant(a.id, (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM orden_trabajo_tareas t
           JOIN ordenes_trabajo o ON o.id = t.orden_trabajo_id WHERE o.titulo = 'Repetida'`
      )
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("al crear, un reloj adelantado no hace perder la orden: la hora se descarta", async () => {
    const futura = new Date(Date.now() + 3_600_000).toISOString();
    const orden = await crear({ inicio_en: futura, tareas: [{ descripcion: "Una" }] });
    expect(orden.inicio_en).toBeNull();
    expect(orden.tareas).toHaveLength(1);
  });

  it("años absurdos y números fuera de rango dan 400 o 404, nunca 500", async () => {
    const { id } = await crear();
    for (const hora of ["0000-01-01T00:00:00Z", "0202-05-05T10:00:00Z"]) {
      expect((await editar(id, { inicio_en: hora })).status, hora).toBe(400);
    }
    const grande = await a.ag.patch(`${BASE}/99999999999/tareas`).send({ quitar: [1] });
    expect(grande.status, JSON.stringify(grande.body)).toBe(404);
  });

  it("el perfil Lectura ve las horas y las tareas pero no cambia nada", async () => {
    const { id } = await crear({ tareas: [{ descripcion: "Una" }] });
    const dueno = empresas.find((e) => e.tenant.id === a.id)!;
    await withTenant(a.id, (c) =>
      c.query("UPDATE usuarios SET rol = 'lectura' WHERE id = $1", [dueno.usuario.id])
    );
    const ag = request.agent(app);
    const login = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: dueno.tenant.slug, email: dueno.usuario.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect((await ag.get(`${BASE}/${id}`)).body.tareas).toHaveLength(1);
    const intentos = [
      await ag.patch(`${BASE}/${id}/tareas`).send({ agregar: [{ descripcion: "X" }] }),
      await ag.put(`${BASE}/${id}`).send({ titulo: "X", tipo: "correctivo", prioridad: "baja" }),
      await ag.patch(`${BASE}/${id}/estado`).send({ estado: "en_progreso" }),
    ];
    expect(intentos.map((x) => x.status)).toEqual([403, 403, 403]);
    await withTenant(a.id, (c) =>
      c.query("UPDATE usuarios SET rol = 'admin' WHERE id = $1", [dueno.usuario.id])
    );
  });

  it("al clonar el respaldo, las tareas apuntan a la orden copiada", async () => {
    await crear({ titulo: "Respaldo", tareas: [{ descripcion: "Copiada", hecha: true }] });
    const destino = await nueva();
    const backup = await request(app)
      .post(`/api/platform/tenants/${a.id}/backups`)
      .set("Authorization", BEARER);
    expect(backup.status, JSON.stringify(backup.body)).toBe(201);
    const restaurado = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.id, confirmar: true });
    expect(restaurado.status, JSON.stringify(restaurado.body)).toBe(200);
    const copia = await withTenant(destino.id, (c) =>
      c.query(
        `SELECT t.descripcion, t.hecha FROM orden_trabajo_tareas t
           JOIN ordenes_trabajo o ON o.id = t.orden_trabajo_id AND o.tenant_id = t.tenant_id
          WHERE o.titulo = 'Respaldo'`
      )
    );
    expect(copia.rows).toEqual([{ descripcion: "Copiada", hecha: true }]);
  });
});
