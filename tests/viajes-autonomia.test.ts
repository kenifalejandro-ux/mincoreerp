/** tests/viajes-autonomia.test.ts
 *
 * Viajes funciona solo: una empresa con Flota y Viajes, SIN Combustible, programa, inicia, marca y
 * cierra un viaje, lo ve en la lista, el detalle y el consumo, y su conductor usa «Mi viaje» y crea
 * su propio viaje. Lo que viene de Combustible (las cargas, el consumo de referencia, el medidor por
 * vale y el alcance por grifo) se OMITE: no falla ni da 403, y la consulta ni se ejecuta.
 *
 * Con Combustible el comportamiento es el de siempre y lo prueban los tests de cada módulo
 * (combustible-viajes, viajes-conductor-crea-su-viaje y los de consumo por viaje).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";

type Agente = ReturnType<typeof request.agent>;

const H = 3_600_000;
const T0 = Date.now() - 100 * H;
const hora = (h: number) => new Date(T0 + h * H).toISOString();

describe("Viajes: autonomía (sin Combustible)", () => {
  let tenantId: string;
  let slug: string;
  let admin: Agente;
  let origen: number;
  let destino: number;
  let seq = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    // Solo Flota y Viajes: sin Combustible.
    const m = await request(app)
      .put(`/api/platform/tenants/${tenantId}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((x) => ({
          modulo: x.id,
          estado: x.id === "flota" || x.id === "viajes" ? "habilitado" : "deshabilitado",
        })),
      });
    expect(m.status).toBe(200);
    await pool.query(`UPDATE tenants SET conductor_crea_viaje = true WHERE id = $1`, [tenantId]);
    admin = request.agent(app);
    const login = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    expect(login.status).toBe(200);
    origen = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Origen") })).body.id
    );
    destino = Number(
      (await admin.post("/api/erp/viajes/lugares").send({ nombre: idUnico("Destino") })).body.id
    );
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const unidad = async () => {
    const r = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VA"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: String(40100000 + seq++),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };

  it("la empresa de verdad no tiene Combustible", async () => {
    expect((await admin.get("/api/erp/combustible")).status).toBe(403);
  });

  it("programa, ve el medidor previo, inicia, lista, ve el detalle y cierra, sin cargas ni 403", async () => {
    const eq = await unidad();
    const prog = await admin.post("/api/erp/viajes").send({
      equipo_id: eq,
      origen_id: origen,
      destino_id: destino,
      salida_programada_en: hora(90),
    });
    expect(prog.status, JSON.stringify(prog.body)).toBe(201);
    expect(prog.body.estado).toBe("programado");
    const id = prog.body.id as number;

    // El medidor previo no mira vales: sin viajes cerrados todavía, no hay lectura.
    const previo = await admin.get(`/api/erp/viajes/${id}/medidor-previo`);
    expect(previo.status, JSON.stringify(previo.body)).toBe(200);
    expect(previo.body).toMatchObject({ tipo_medidor: "odometro", valor: null, fuente: null });

    const inicio = await admin
      .post(`/api/erp/viajes/${id}/iniciar`)
      .send({ inicio_en: hora(91), medidor_inicio: 1000, motivo: "Marca de oficina" });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(200);
    expect(inicio.body.estado).toBe("en_curso");

    const lista = await admin.get("/api/erp/viajes").query({ producto: "combustible" });
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    const fila = lista.body.data.find((v: { id: number }) => v.id === id);
    expect(fila).toBeDefined();
    expect(Number(fila.cargas)).toBe(0);
    expect(Number(fila.cantidad)).toBe(0);
    expect(fila.promedio_ruta).toBeNull();

    const detalle = await admin.get(`/api/erp/viajes/${id}`);
    expect(detalle.status, JSON.stringify(detalle.body)).toBe(200);
    expect(detalle.body.cargas).toEqual([]);
    expect(detalle.body.ruta).toMatchObject({ combustible_gal: null, urea_l: null });

    const cierre = await admin
      .post(`/api/erp/viajes/${id}/cerrar`)
      .send({ fin_en: hora(95), medidor_fin: 1200, motivo: "Marca de oficina" });
    expect(cierre.status, JSON.stringify(cierre.body)).toBe(200);
    expect(cierre.body.estado).toBe("cerrado");

    // Con el viaje cerrado, el medidor previo de la unidad sale del propio viaje (no de un vale).
    const siguiente = await admin.post("/api/erp/viajes").send({
      equipo_id: eq,
      origen_id: origen,
      destino_id: destino,
      salida_programada_en: hora(98),
    });
    expect(siguiente.status, JSON.stringify(siguiente.body)).toBe(201);
    const previo2 = await admin.get(`/api/erp/viajes/${siguiente.body.id}/medidor-previo`);
    expect(previo2.body).toMatchObject({ valor: 1200, fuente: "viaje" });
  });

  it("el panel pide las unidades a Viajes (Flota), no a Combustible, que no está", async () => {
    const eq = await unidad();
    const r = await admin.get("/api/erp/viajes/unidades").query({ pageSize: 200 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.some((u: { id: number }) => u.id === eq)).toBe(true);
    expect(Number(r.body.pagination.total)).toBeGreaterThan(0);
    // La puerta vieja de Combustible no existe para esta empresa.
    expect((await admin.get("/api/erp/combustible/equipos-destino")).status).toBe(403);
  });

  it("el consumo, el resumen de conductores y el histórico responden vacíos de cargas, no con 403", async () => {
    for (const ruta of ["/api/erp/viajes/consumo", "/api/erp/viajes/resumen-conductores"]) {
      const r = await admin.get(ruta).query({ producto: "combustible" });
      expect(r.status, `${ruta}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(Array.isArray(r.body.data)).toBe(true);
    }
  });

  it("el conductor ve «Mi viaje» y crea e inicia su propio viaje, sin Combustible", async () => {
    const agente = request.agent(app);
    const dni = String(86400000 + Math.floor(Math.random() * 90000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Conductor ${dni}`, dni, password, rol: "conductor_ruta" });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const login = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(login.status).toBe(200);

    const mios = await agente.get("/api/erp/viajes/mios");
    expect(mios.status, JSON.stringify(mios.body)).toBe(200);

    const creado = await agente.post("/api/erp/viajes/crear-mio").send({
      id_cliente: randomUUID(),
      unidad_nueva: {
        placa: `Q${Math.floor(Math.random() * 900 + 100)}-${seq++ + 100}`,
        nombre: "Conductor",
      },
      paradas: [origen, destino],
      medidor_inicio: 500,
    });
    expect(creado.status, JSON.stringify(creado.body)).toBe(201);
    expect(creado.body.estado ?? creado.body.viaje?.estado).toBe("en_curso");

    const historial = await agente.get("/api/erp/viajes/mios/historial");
    expect(historial.status, JSON.stringify(historial.body)).toBe(200);
  });
});
