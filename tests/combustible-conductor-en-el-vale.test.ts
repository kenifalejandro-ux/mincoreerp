/** tests/combustible-conductor-en-el-vale.test.ts
 *
 * Kenif, mirando el formulario de Equipos: *"acá debemos dar de alta a cada
 * conductor con su nombre y apellido para tenerlo mapeado la cantidad de
 * combustible que consume"*.
 *
 * El vale de papel del cliente YA trae la columna CONDUCTOR (TURNO, UNIDAD,
 * PLACA, CONDUCTOR, H.ABST, OROMETRO, PRODUCTO, GALONES, C.U). El sistema
 * nunca la guardó: se tipeaba en el papel y se perdía al cargar el vale.
 *
 * LO QUE ESTE ARCHIVO FIJA es por qué el dato va en los DOS lados. Los
 * conductores rotan, y si el nombre viviera solo en el equipo, el día que la
 * unidad cambia de chofer TODO el consumo histórico se reatribuiría al chofer
 * nuevo -- el reporte mentiría y no habría forma de notarlo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("combustible: el conductor queda estampado en el vale (migración 0083)", () => {
  let tenantId: string;
  let tq: number;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  let seq = 0;
  const serie = () => `C${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: c.tenant.slug, email: c.usuario.email, password });
    const t = await ag.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "T",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 50000,
      nivel_actual: 40000,
      nivel_minimo: 1000,
      modo_vigilancia: "sin_vigilar",
    });
    tq = t.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const crearEquipo = (extra: Record<string, unknown> = {}) =>
    ag.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      ...extra,
    });

  const despachar = (equipoId: number, cantidad = 300) =>
    ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipoId,
      serie_talonario: serie(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16,
      despachado_en: new Date().toISOString(),
    });

  const editarEquipo = (id: number, extra: Record<string, unknown>) =>
    ag.put(`/api/erp/equipos/${id}`).send({
      placa_codigo: idUnico("VQ"),
      tipo: "Volquete",
      activo: true,
      ...extra,
    });

  // ── El alta ───────────────────────────────────────────────────────────

  it("el equipo guarda el conductor asignado", async () => {
    const r = await crearEquipo({ conductor_nombre: "Juan Pérez", conductor_dni: "12345678" });
    expect(r.status).toBe(201);
    expect(r.body.conductor_nombre).toBe("Juan Pérez");
    expect(r.body.conductor_dni).toBe("12345678");
  });

  it("el conductor es OPCIONAL: un equipo sin chofer asignado se crea igual", async () => {
    const r = await crearEquipo();
    expect(r.status).toBe(201);
    expect(r.body.conductor_nombre).toBeNull();
  });

  // ── La copia al vale ──────────────────────────────────────────────────

  it("el vale se lleva una COPIA del conductor, sin que nadie la tipee", async () => {
    const eq = await crearEquipo({ conductor_nombre: "Juan Pérez", conductor_dni: "12345678" });
    const d = await despachar(eq.body.id);
    expect(d.status).toBe(201);
    expect(d.body.conductor_nombre).toBe("Juan Pérez");
    expect(d.body.conductor_dni).toBe("12345678");
  });

  it("CAMBIAR DE CHOFER NO REESCRIBE EL HISTORIAL — el punto de todo esto", async () => {
    // Juan carga 800 L. Después la unidad pasa a Pedro. Si el nombre viviera
    // solo en el equipo, esos 800 L pasarían a figurar como de Pedro.
    const eq = await crearEquipo({ conductor_nombre: "Juan Pérez", conductor_dni: "12345678" });
    const valeDeJuan = await despachar(eq.body.id, 800);
    expect(valeDeJuan.body.conductor_nombre).toBe("Juan Pérez");

    const cambio = await editarEquipo(eq.body.id, {
      conductor_nombre: "Pedro Ramírez",
      conductor_dni: "87654321",
    });
    expect(cambio.status).toBe(200);
    expect(cambio.body.conductor_nombre).toBe("Pedro Ramírez");

    // El vale viejo sigue diciendo Juan.
    const hist = await ag.get("/api/erp/combustible/despachos").query({ pageSize: 100 });
    const suyo = (hist.body.data as { id: number; conductor_nombre: string | null }[]).find(
      (v) => v.id === valeDeJuan.body.id
    );
    expect(suyo!.conductor_nombre).toBe("Juan Pérez");

    // Y el siguiente ya dice Pedro.
    const valeDePedro = await despachar(eq.body.id, 400);
    expect(valeDePedro.body.conductor_nombre).toBe("Pedro Ramírez");
  });

  it("un equipo sin conductor deja el vale en NULL, no en vacío inventado", async () => {
    const eq = await crearEquipo();
    const d = await despachar(eq.body.id);
    expect(d.status).toBe(201);
    expect(d.body.conductor_nombre).toBeNull();
    expect(d.body.conductor_dni).toBeNull();
  });

  it("un despacho a PLANTA no tiene equipo, y por lo tanto no tiene conductor", async () => {
    const r = await ag.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "planta",
      serie_talonario: serie(),
      n_vale: 1,
      cantidad: 500,
      lectura_contometro: 500,
      costo_unitario: 16,
      despachado_en: new Date().toISOString(),
    });
    expect(r.status).toBe(201);
    expect(r.body.conductor_nombre).toBeNull();
  });

  // ── El reporte que motivó todo ────────────────────────────────────────

  it("se puede sumar el consumo por conductor, y el kardex lo muestra", async () => {
    const eq = await crearEquipo({ conductor_nombre: "Ana Torres", conductor_dni: "45678912" });
    await despachar(eq.body.id, 250);
    await despachar(eq.body.id, 350);

    const hist = await ag.get("/api/erp/combustible/despachos").query({ pageSize: 200 });
    const deAna = (hist.body.data as { conductor_dni: string | null; cantidad: string }[]).filter(
      (v) => v.conductor_dni === "45678912"
    );
    expect(deAna).toHaveLength(2);
    expect(deAna.reduce((a, v) => a + Number(v.cantidad), 0)).toBe(600);
  });
});
