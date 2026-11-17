/** tests/ordenes-trabajo-autonomia.test.ts
 *
 * Órdenes de Trabajo funciona solo. La unidad es de OTRO módulo (Flota) y es opcional: la orden se
 * identifica por la unidad, por un texto libre («Horno 4, faja transportadora») o por las dos
 * (migración 0190). Sin Flota no se lee la tabla `equipos`: no hay 403 ni pantalla rota, solo se
 * omite esa parte. Lo que se fija:
 *
 * 1. Una empresa con SOLO Órdenes de Trabajo crea, lista, abre y avanza órdenes por texto, sin
 *    acceso a Flota.
 * 2. Sin unidad ni texto → 400 (no 500); un texto de puros espacios cuenta como vacío.
 * 3. Sin Flota, mandar `equipo_id` → 400 (se rechaza, no se ignora en silencio); el filtro
 *    `?equipo_id=` del listado se ignora sin error.
 * 4. El reintento por `cliente_uuid` no duplica, tampoco cuando la orden es solo de texto.
 * 5. Con Flota la unidad sigue funcionando; el texto es opcional y puede ir junto con ella, y el
 *    filtro por equipo sigue filtrando.
 * 6. Una empresa que PIERDE Flota deja de ver la placa de las órdenes viejas (la fila conserva la
 *    unidad); si el módulo vuelve, reaparece.
 * 7. Editar (PUT): el texto se puede corregir, la unidad no cambia, y una orden SIN unidad no puede
 *    quedarse sin texto (400, no 500 por el CHECK).
 * 8. La base misma rechaza una orden sin unidad y sin texto (CHECK de la migración 0190).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("Órdenes de Trabajo: autonomía de la unidad", () => {
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

  const listado = async (admin: Agente, query = "") => {
    const r = await admin.get(`/api/erp/ordenes_trabajo?pageSize=100${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as {
      id: number;
      equipo_id: number | null;
      placa_codigo: string | null;
      activo_texto: string | null;
      estado: string;
    }[];
  };
  const putCompleto = (titulo: string, extra: Record<string, unknown> = {}) => ({
    titulo,
    tipo: "correctivo",
    prioridad: "media",
    ...extra,
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("una empresa con SOLO Órdenes de Trabajo crea, lista, abre y avanza órdenes por texto, sin tocar Flota", async () => {
    const e = await nueva(["ordenes_trabajo"]);
    const admin = await sesion(e);
    // De verdad es solo Órdenes de Trabajo.
    expect((await admin.get("/api/erp/equipos")).status).toBe(403);

    const creada = await admin.post("/api/erp/ordenes_trabajo").send({
      activo_texto: "Horno 4, faja transportadora",
      titulo: "Cambiar rodillos de la faja",
    });
    expect(creada.status, JSON.stringify(creada.body)).toBe(201);
    expect(creada.body.equipo_id).toBeNull();
    expect(creada.body.activo_texto).toBe("Horno 4, faja transportadora");
    expect(creada.body.estado).toBe("abierta");

    const filas = await listado(admin);
    const mia = filas.find((o) => o.id === creada.body.id);
    expect(mia).toMatchObject({
      equipo_id: null,
      placa_codigo: null,
      activo_texto: "Horno 4, faja transportadora",
    });

    const detalle = await admin.get(`/api/erp/ordenes_trabajo/${creada.body.id}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body).toMatchObject({
      placa_codigo: null,
      activo_texto: "Horno 4, faja transportadora",
    });

    // La máquina de estados no depende de que haya unidad.
    const iniciada = await admin
      .patch(`/api/erp/ordenes_trabajo/${creada.body.id}/estado`)
      .send({ estado: "en_progreso" });
    expect(iniciada.status, JSON.stringify(iniciada.body)).toBe(200);
    expect(iniciada.body.estado).toBe("en_progreso");
  });

  it("sin unidad ni texto responde 400, y un texto de puros espacios cuenta como vacío", async () => {
    const e = await nueva(["ordenes_trabajo"]);
    const admin = await sesion(e);

    const nada = await admin.post("/api/erp/ordenes_trabajo").send({ titulo: "Sin activo" });
    expect(nada.status).toBe(400);

    const espacios = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ activo_texto: "   ", titulo: "Solo espacios" });
    expect(espacios.status).toBe(400);

    // Texto demasiado largo: 400, no 500 por el VARCHAR(150).
    const largo = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ activo_texto: "x".repeat(151), titulo: "Texto largo" });
    expect(largo.status).toBe(400);

    expect(await listado(admin)).toHaveLength(0);
  });

  it("sin Flota, mandar equipo_id se rechaza con un 400 claro y no se crea nada; el filtro por equipo se ignora", async () => {
    const e = await nueva(["ordenes_trabajo"]);
    const admin = await sesion(e);

    const r = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: 1, activo_texto: "Horno 4", titulo: "Con unidad sin Flota" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Registro de unidades/);
    expect(await listado(admin)).toHaveLength(0);

    const propia = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ activo_texto: "Campamento", titulo: "Fuga de agua" });
    expect(propia.status).toBe(201);
    // El filtro `?equipo_id=` no rompe (ni da 403/500) ni oculta lo que hay: sin Flota se ignora.
    expect(await listado(admin, "&equipo_id=1")).toHaveLength(1);
  });

  it("el reintento con el mismo cliente_uuid no duplica, tampoco en una orden solo de texto", async () => {
    const e = await nueva(["ordenes_trabajo"]);
    const admin = await sesion(e);
    const cuerpo = {
      cliente_uuid: crypto.randomUUID(),
      activo_texto: "Compresor 2",
      titulo: "Revisar presión",
    };

    const primero = await admin.post("/api/erp/ordenes_trabajo").send(cuerpo);
    expect(primero.status, JSON.stringify(primero.body)).toBe(201);
    const reintento = await admin.post("/api/erp/ordenes_trabajo").send(cuerpo);
    expect(reintento.status, JSON.stringify(reintento.body)).toBeLessThan(300);
    expect(reintento.body.id).toBe(primero.body.id);
    expect(reintento.body.activo_texto).toBe("Compresor 2");
    expect(await listado(admin)).toHaveLength(1);
  });

  it("con Flota la unidad sigue funcionando, y puede ir sola, con texto, o el texto solo; el filtro por equipo filtra", async () => {
    const e = await nueva(["flota", "ordenes_trabajo"]);
    const admin = await sesion(e);
    const placa = idUnico("OT");
    const equipo = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: placa, tipo: "Volquete" });
    expect(equipo.status, JSON.stringify(equipo.body)).toBe(201);
    const equipoId = Number(equipo.body.id);

    const soloUnidad = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Cambio de aceite" });
    expect(soloUnidad.status, JSON.stringify(soloUnidad.body)).toBe(201);

    const unidadYTexto = await admin.post("/api/erp/ordenes_trabajo").send({
      equipo_id: equipoId,
      activo_texto: "Tolva trasera",
      titulo: "Soldar la tolva",
    });
    expect(unidadYTexto.status).toBe(201);

    const soloTexto = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ activo_texto: "Horno 4", titulo: "Cambiar faja" });
    expect(soloTexto.status).toBe(201);

    const filas = await listado(admin);
    const por = (id: number) => filas.find((o) => o.id === id);
    expect(por(soloUnidad.body.id)).toMatchObject({
      equipo_id: equipoId,
      placa_codigo: placa,
      activo_texto: null,
    });
    expect(por(unidadYTexto.body.id)).toMatchObject({
      placa_codigo: placa,
      activo_texto: "Tolva trasera",
    });
    expect(por(soloTexto.body.id)).toMatchObject({ equipo_id: null, placa_codigo: null });

    // El filtro por equipo sigue funcionando con Flota: solo las dos órdenes de la unidad.
    const delEquipo = await listado(admin, `&equipo_id=${equipoId}`);
    expect(delEquipo.map((o) => o.id).sort()).toEqual(
      [soloUnidad.body.id, unidadYTexto.body.id].sort()
    );

    const detalle = await admin.get(`/api/erp/ordenes_trabajo/${soloUnidad.body.id}`);
    expect(detalle.body.placa_codigo).toBe(placa);
  });

  it("una empresa que pierde Flota deja de ver la placa, conserva la unidad, y la recupera si vuelve", async () => {
    const e = await nueva(["flota", "ordenes_trabajo"]);
    let admin = await sesion(e);
    const placa = idUnico("OT");
    const equipo = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: placa, tipo: "Volquete" });
    const equipoId = Number(equipo.body.id);
    const creada = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, titulo: "Revisar frenos" });
    expect(creada.status).toBe(201);

    await ponerModulos(e, ["ordenes_trabajo"]);
    admin = await sesion(e);
    const sinFlota = (await listado(admin)).find((o) => o.id === creada.body.id);
    expect(sinFlota).toMatchObject({ equipo_id: equipoId, placa_codigo: null, activo_texto: null });
    const detalleSinFlota = await admin.get(`/api/erp/ordenes_trabajo/${creada.body.id}`);
    expect(detalleSinFlota.status).toBe(200);
    expect(detalleSinFlota.body.placa_codigo).toBeNull();

    await ponerModulos(e, ["flota", "ordenes_trabajo"]);
    admin = await sesion(e);
    const conFlota = (await listado(admin)).find((o) => o.id === creada.body.id);
    expect(conFlota?.placa_codigo).toBe(placa);
  });

  it("editar: el texto se corrige, la unidad no cambia, y una orden sin unidad no puede quedarse sin texto", async () => {
    const e = await nueva(["flota", "ordenes_trabajo"]);
    const admin = await sesion(e);
    const placa = idUnico("OT");
    const equipo = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: placa, tipo: "Volquete" });
    const equipoId = Number(equipo.body.id);

    // Orden SIN unidad: el texto se puede corregir, pero no borrar.
    const sinUnidad = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ activo_texto: "Horno 4", titulo: "Cambiar faja" });
    expect(sinUnidad.status).toBe(201);

    const corregida = await admin
      .put(`/api/erp/ordenes_trabajo/${sinUnidad.body.id}`)
      .send(putCompleto("Cambiar faja", { activo_texto: "Horno 5" }));
    expect(corregida.status, JSON.stringify(corregida.body)).toBe(200);
    expect(corregida.body.activo_texto).toBe("Horno 5");

    const sinTexto = await admin
      .put(`/api/erp/ordenes_trabajo/${sinUnidad.body.id}`)
      .send(putCompleto("Cambiar faja"));
    expect(sinTexto.status).toBe(400);
    const soloEspacios = await admin
      .put(`/api/erp/ordenes_trabajo/${sinUnidad.body.id}`)
      .send(putCompleto("Cambiar faja", { activo_texto: "   " }));
    expect(soloEspacios.status).toBe(400);
    // Lo rechazado no tocó la fila.
    const intacta = await admin.get(`/api/erp/ordenes_trabajo/${sinUnidad.body.id}`);
    expect(intacta.body.activo_texto).toBe("Horno 5");

    // Orden CON unidad: el PUT sin texto es válido y la unidad no se mueve.
    const conUnidad = await admin
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipoId, activo_texto: "Tolva", titulo: "Soldar" });
    expect(conUnidad.status).toBe(201);
    const editada = await admin
      .put(`/api/erp/ordenes_trabajo/${conUnidad.body.id}`)
      .send(putCompleto("Soldar tolva", { prioridad: "alta" }));
    expect(editada.status, JSON.stringify(editada.body)).toBe(200);
    expect(editada.body.activo_texto).toBeNull();
    expect(editada.body.equipo_id).toBe(equipoId);
    expect(editada.body.titulo).toBe("Soldar tolva");
  });

  it("la base rechaza una orden sin unidad y sin texto (CHECK de la migración 0190)", async () => {
    const e = await nueva(["ordenes_trabajo"]);

    const insertar = (activoTexto: string | null) =>
      withTenant(e.tenant.id, (client) =>
        client.query(
          `INSERT INTO ordenes_trabajo (tenant_id, equipo_id, activo_texto, titulo, creado_por)
           VALUES ($1, NULL, $2, 'Orden de prueba', $3)`,
          [e.tenant.id, activoTexto, e.usuario.id]
        )
      );

    await expect(insertar(null)).rejects.toMatchObject({ code: "23514" });
    await expect(insertar("   ")).rejects.toMatchObject({ code: "23514" });
    await expect(insertar("Horno 4")).resolves.toBeDefined();
  });
});
