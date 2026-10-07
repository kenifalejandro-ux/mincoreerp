/** tests/combustible-viajes.test.ts
 *
 * Viajes (migración 0123): A → B de una unidad. Las cargas se derivan por
 * unidad + ventana [inicio − margen, fin]; se ataca la API para ver que una
 * carga no cae en dos viajes, que los viajes no se traslapan, que todo cambio
 * pide motivo y que otro tenant no ve nada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

type Agente = ReturnType<typeof request.agent>;

const H = 3_600_000;
const T0 = Date.now() - 200 * H;
const hora = (h: number) => new Date(T0 + h * H).toISOString();
const serieUnica = () => `S${Math.floor(Math.random() * 1e8).toString(36)}`;

describe("combustible: viajes y consumo por viaje (0123)", () => {
  const tenants: string[] = [];
  let slug: string;
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let huamachuco: number;
  let bambamarca: number;
  let tanque: number;
  let grifoUrea: number;
  let seq = 0;

  async function conRol(rol: string): Promise<Agente> {
    const agente = request.agent(app);
    const dni = String(86100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return agente;
  }

  /** Un conductor de ruta con su DNI: el viaje le aparece por ese DNI. */
  async function conductor(): Promise<{ agente: Agente; dni: string }> {
    const agente = request.agent(app);
    const dni = String(85100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Conductor ${dni}`, dni, password, rol: "conductor_ruta" });
    expect(alta.status).toBe(201);
    await agente.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    return { agente, dni };
  }

  const lugar = async (nombre: string) =>
    Number((await admin.post("/api/erp/combustible/lugares").send({ nombre })).body.id);

  const unidad = async () => {
    const r = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("VQ"),
      tipo: "VOLQUETE",
      tipo_medidor: "odometro",
      conductor_nombre: "Juan Pérez",
      conductor_dni: "40000001",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number(r.body.id);
  };

  const viaje = (equipo_id: number, extra: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/viajes").send({
      equipo_id,
      origen_id: huamachuco,
      destino_id: bambamarca,
      inicio_en: hora(0),
      ...extra,
    });

  const cargar = (equipo_id: number, cantidad: number, h: number) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanque,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad,
      lectura_contometro: cantidad,
      costo_unitario: 16.8,
      despachado_en: hora(h),
    });

  const consumo = async (equipo_id: number, producto = "combustible", agente = admin) =>
    agente.get("/api/erp/combustible/viajes/consumo").query({ equipo_id, producto });

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenants.push(creado.tenant.id);
    slug = creado.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: creado.usuario.email, password });
    huamachuco = await lugar(idUnico("Huamachuco"));
    bambamarca = await lugar(idUnico("Bambamarca"));
    const tq = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque Huamachuco",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 9000,
      requiere_documento: false,
    });
    expect(tq.status, JSON.stringify(tq.body)).toBe(201);
    tanque = tq.body.id;
    grifoUrea = (
      await admin.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("UREA"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;
  });

  afterAll(async () => {
    for (const t of tenants) await borrarTenantDePrueba(t);
    await closeDatabase();
  });

  it("un lugar repetido (sin importar mayúsculas) da 409", async () => {
    const nombre = idUnico("Cajamarca");
    expect((await admin.post("/api/erp/combustible/lugares").send({ nombre })).status).toBe(201);
    const otra = await admin
      .post("/api/erp/combustible/lugares")
      .send({ nombre: ` ${nombre.toUpperCase()} ` });
    expect(otra.status).toBe(409);
  });

  it("toma la carga de antes de salir y las de ruta, no la de después de llegar; urea aparte", async () => {
    const eq = await unidad();
    const v = await viaje(eq, { fin_en: hora(8), medidor_inicio: 1000, medidor_fin: 1400 });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.estado).toBe("cerrado");
    // Sin conductor en el alta, se copia el de la unidad.
    expect(v.body.conductor_nombre).toBe("Juan Pérez");

    expect((await cargar(eq, 50, -2)).status).toBe(201); // antes de salir (margen 6 h)
    expect((await cargar(eq, 30, 4)).status).toBe(201); // en ruta
    expect((await cargar(eq, 99, 9)).status).toBe(201); // después de llegar
    expect((await cargar(eq, 77, -7)).status).toBe(201); // fuera del margen
    const u = await admin.post("/api/erp/combustible/despachos").send({
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifoUrea,
      tipo_destino: "equipo",
      equipo_id: eq,
      serie_talonario: serieUnica(),
      n_vale: 1,
      presentacion: "bolsa",
      cantidad_bultos: 2,
      despachado_en: hora(3),
    });
    expect(u.status, JSON.stringify(u.body)).toBe(201);

    const fila = (await consumo(eq)).body.data[0];
    expect(Number(fila.cargas)).toBe(2);
    expect(Number(fila.cantidad)).toBeCloseTo(80, 2);
    expect(Number(fila.recorrido)).toBe(400);

    const urea = (await consumo(eq, "urea")).body.data[0];
    expect(Number(urea.cargas)).toBe(1);

    const det = await admin.get(`/api/erp/combustible/viajes/${v.body.id}`);
    expect(det.status).toBe(200);
    expect(det.body.cargas.map((c: { producto: string }) => c.producto).sort()).toEqual([
      "combustible",
      "combustible",
      "urea",
    ]);
  });

  it("el margen previo no invade el viaje anterior: una carga no cae en dos viajes", async () => {
    const eq = await unidad();
    expect((await viaje(eq, { inicio_en: hora(20), fin_en: hora(24) })).status).toBe(201);
    // Vuelta: sale 1 h después de llegar; el margen de 6 h tocaría la ida.
    const vuelta = await viaje(eq, {
      origen_id: bambamarca,
      destino_id: huamachuco,
      inicio_en: hora(25),
      fin_en: hora(30),
    });
    expect(vuelta.status).toBe(201);
    expect((await cargar(eq, 40, 22)).status).toBe(201); // ida
    expect((await cargar(eq, 25, 24.5)).status).toBe(201); // entre viajes -> vuelta
    const filas = (await consumo(eq)).body.data as { numero: number; cargas: string }[];
    const porNumero = Object.fromEntries(filas.map((f) => [f.numero, Number(f.cargas)]));
    expect(porNumero[vuelta.body.numero]).toBe(1);
    expect(filas.reduce((s, f) => s + Number(f.cargas), 0)).toBe(2);
  });

  it("numera correlativo, rechaza traslapes y un segundo viaje en curso", async () => {
    const eq = await unidad();
    const a = await viaje(eq, { inicio_en: hora(40), fin_en: hora(45) });
    const b = await viaje(eq, { inicio_en: hora(50) });
    expect(b.status).toBe(201);
    expect(b.body.numero).toBe(a.body.numero + 1);
    expect(b.body.estado).toBe("en_curso");
    expect((await viaje(eq, { inicio_en: hora(44), fin_en: hora(46) })).status).toBe(409);
    expect((await viaje(eq, { inicio_en: hora(60) })).status).toBe(409);

    const cierre = await admin
      .post(`/api/erp/combustible/viajes/${b.body.id}/cerrar`)
      .send({ fin_en: hora(55), motivo: "Marca de oficina" });
    expect(cierre.status).toBe(200);
    expect(cierre.body.estado).toBe("cerrado");
    expect(
      (
        await admin
          .post(`/api/erp/combustible/viajes/${b.body.id}/cerrar`)
          .send({ fin_en: hora(56), motivo: "Marca de oficina" })
      ).status
    ).toBe(409);
  });

  it("valida origen ≠ destino, llegada posterior a salida y medidores", async () => {
    const eq = await unidad();
    expect((await viaje(eq, { destino_id: huamachuco })).status).toBe(400);
    expect((await viaje(eq, { inicio_en: hora(70), fin_en: hora(69) })).status).toBe(400);
    expect(
      (await viaje(eq, { inicio_en: hora(70), medidor_inicio: 500, medidor_fin: 400 })).status
    ).toBe(400);
  });

  it("editar y anular piden motivo; el anulado sale del consumo y ya no se toca", async () => {
    const eq = await unidad();
    const v = (await viaje(eq, { inicio_en: hora(80), fin_en: hora(85) })).body;
    const url = `/api/erp/combustible/viajes/${v.id}`;

    expect((await admin.put(url).send({ cuenta_como: 0.5 })).status).toBe(400);
    const ed = await admin.put(url).send({ cuenta_como: 0.5, motivo: "Ida y vuelta es uno" });
    expect(ed.status).toBe(200);
    expect(Number(ed.body.cuenta_como)).toBe(0.5);
    // Un viaje cerrado no se reabre borrándole la llegada.
    expect((await admin.put(url).send({ fin_en: null, motivo: "reabrir" })).status).toBe(400);

    expect((await admin.post(`${url}/anular`).send({})).status).toBe(400);
    expect((await admin.post(`${url}/anular`).send({ motivo: "Duplicado" })).status).toBe(200);
    expect((await consumo(eq)).body.data).toHaveLength(0);
    expect((await admin.put(url).send({ cuenta_como: 1, motivo: "x".repeat(5) })).status).toBe(409);
    // Anulado, deja libre el hueco: se puede volver a registrar.
    expect((await viaje(eq, { inicio_en: hora(80), fin_en: hora(85) })).status).toBe(201);
  });

  const programar = (equipo_id: number, extra: Record<string, unknown> = {}) =>
    admin.post("/api/erp/combustible/viajes").send({
      equipo_id,
      origen_id: huamachuco,
      destino_id: bambamarca,
      ...extra,
    });
  const url = (id: number | string, accion = "") => `/api/erp/combustible/viajes/${id}${accion}`;

  it("un viaje programado no tiene salida, no cuenta cargas y no acepta medidores", async () => {
    const eq = await unidad();
    const p = await programar(eq);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body.estado).toBe("programado");
    expect(p.body.inicio_en).toBeNull();
    expect((await cargar(eq, 50, 0)).status).toBe(201);
    const fila = (await consumo(eq)).body.data[0];
    expect(Number(fila.cargas)).toBe(0);
    expect((await programar(eq, { medidor_inicio: 10 })).status).toBe(400);
    expect(
      (await admin.put(url(p.body.id)).send({ inicio_en: hora(1), motivo: "x".repeat(4) })).status
    ).toBe(400);
    expect((await admin.post(url(p.body.id, "/cerrar")).send({})).status).toBe(409);
  });

  it("iniciar: la hora la pone el servidor, pide medidor y no admite uno menor al previo", async () => {
    const eq = await unidad();
    // Viaje anterior cerrado con llegada a 5000 km: es el medidor previo.
    const anterior = await viaje(eq, {
      inicio_en: hora(110),
      fin_en: hora(115),
      medidor_inicio: 4700,
      medidor_fin: 5000,
    });
    expect(anterior.status).toBe(201);
    const p = (await programar(eq)).body;

    const previo = await admin.get(url(p.id, "/medidor-previo"));
    expect(previo.body).toMatchObject({ tipo_medidor: "odometro", valor: 5000, fuente: "viaje" });

    expect((await admin.post(url(p.id, "/iniciar")).send({})).status).toBe(400);
    expect((await admin.post(url(p.id, "/iniciar")).send({ medidor_inicio: 4999 })).status).toBe(
      400
    );
    expect(
      (await admin.post(url(p.id, "/iniciar")).send({ medidor_inicio: 5010, inicio_en: hora(120) }))
        .status
    ).toBe(400); // hora a mano sin motivo

    const antes = Date.now();
    const ini = await admin.post(url(p.id, "/iniciar")).send({ medidor_inicio: 5012.5 });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    expect(ini.body.estado).toBe("en_curso");
    expect(Math.abs(Date.parse(ini.body.inicio_en) - antes)).toBeLessThan(10_000);
    expect(Number(ini.body.medidor_previo)).toBe(5000);
    expect(Number(ini.body.recorrido_sin_viaje)).toBeCloseTo(12.5, 1);
    expect((await admin.post(url(p.id, "/iniciar")).send({ medidor_inicio: 5020 })).status).toBe(
      409
    );

    // Cerrar: sin hora la pone el servidor; con medidor de salida, el de llegada es obligatorio.
    expect((await admin.post(url(p.id, "/cerrar")).send({})).status).toBe(400);
    expect((await admin.post(url(p.id, "/cerrar")).send({ medidor_fin: 5000 })).status).toBe(400);
    const fin = await admin.post(url(p.id, "/cerrar")).send({ medidor_fin: 5300 });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.estado).toBe("cerrado");
    expect(Number(fin.body.recorrido)).toBeCloseTo(287.5, 1);
  });

  it("si el viaje anterior no tiene medidor, el previo sale de la última carga de la unidad", async () => {
    const eq = await unidad();
    const c = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tanque,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: eq,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 20,
      lectura_contometro: 20,
      lectura_odometro: 777,
      costo_unitario: 16.8,
      despachado_en: hora(-100),
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const p = (await programar(eq)).body;
    const previo = await admin.get(url(p.id, "/medidor-previo"));
    expect(previo.body).toMatchObject({ valor: 777, fuente: "carga" });
  });

  it("ruta por confirmar: sale igual pero no entra al promedio de la ruta; corregirla la confirma", async () => {
    const eq = await unidad();
    const ruta = await lugar(idUnico("Chota"));
    const base = async (h: number) => {
      const r = await viaje(eq, {
        origen_id: ruta,
        destino_id: bambamarca,
        inicio_en: hora(h),
        fin_en: hora(h + 3),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await cargar(eq, 40, h + 1)).status).toBe(201);
    };
    await base(130);
    await base(140);
    await base(150);

    const p = (await programar(eq, { origen_id: ruta, destino_id: bambamarca })).body;
    const ini = await admin.post(url(p.id, "/iniciar")).send({
      medidor_inicio: 9000,
      ruta_por_confirmar: true,
      nota_ruta: "Salgo en otro volquete, avisé a Noemi",
    });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    expect(ini.body.ruta_por_confirmar).toBe(true);
    expect((await cargar(eq, 300, 190)).status).toBe(201); // carga fuera de rango: no cuenta
    const cierre = await admin.post(url(p.id, "/cerrar")).send({ medidor_fin: 9100 });
    expect(cierre.status).toBe(200);

    const filas = (await consumo(eq)).body.data as Record<string, string | boolean>[];
    const cerrado = filas.find((f) => f.id === p.id)!;
    expect(cerrado.ruta_por_confirmar).toBe(true);
    // El promedio y el conteo de la ruta siguen siendo los de los 3 viajes confirmados.
    expect(Number(cerrado.viajes_ruta)).toBe(3);
    expect(Number(cerrado.promedio_ruta)).toBeCloseTo(40, 1);

    const conf = await admin.put(url(p.id)).send({
      destino_id: Number(cerrado.destino_id),
      ruta_por_confirmar: false,
      motivo: "Ruta confirmada",
    });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body.ruta_por_confirmar).toBe(false);
  });

  it("la oficina puede cambiar la unidad del viaje; la ocupada por otro viaje se rechaza", async () => {
    const a = await unidad();
    const b = await unidad();
    const v = (await viaje(a, { inicio_en: hora(160), fin_en: hora(165) })).body;
    expect((await viaje(b, { inicio_en: hora(162), fin_en: hora(166) })).status).toBe(201);
    const choque = await admin
      .put(url(v.id))
      .send({ equipo_id: b, motivo: "Salió en otro volquete" });
    expect(choque.status).toBe(409);
    const libre = await unidad();
    const ok = await admin
      .put(url(v.id))
      .send({ equipo_id: libre, motivo: "Salió en otro volquete" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(Number(ok.body.equipo_id)).toBe(libre);
  });

  it("Lectura consulta pero no registra; el grifero no ve viajes", async () => {
    const lectura = await conRol("lectura");
    expect((await lectura.get("/api/erp/combustible/viajes")).status).toBe(200);
    expect((await consumo(1, "combustible", lectura)).status).toBe(200);
    expect(
      (
        await lectura.post("/api/erp/combustible/viajes").send({
          equipo_id: 1,
          origen_id: huamachuco,
          destino_id: bambamarca,
          inicio_en: hora(0),
        })
      ).status
    ).toBe(403);
    expect((await lectura.post("/api/erp/combustible/lugares").send({ nombre: "X" })).status).toBe(
      403
    );

    const grifero = await conRol("grifero");
    expect((await grifero.get("/api/erp/combustible/viajes")).status).toBe(403);
    expect((await consumo(1, "combustible", grifero)).status).toBe(403);
    expect((await consumo(1, "urea", grifero)).status).toBe(403);
  });

  it("otro tenant no ve el viaje ni puede usar sus lugares ni sus unidades", async () => {
    const eq = await unidad();
    const v = (await viaje(eq, { inicio_en: hora(100), fin_en: hora(101) })).body;

    const otro = await crearTenantDePrueba(password);
    tenants.push(otro.tenant.id);
    const ajeno = request.agent(app);
    await ajeno
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    expect((await ajeno.get(`/api/erp/combustible/viajes/${v.id}`)).status).toBe(404);
    expect((await ajeno.get("/api/erp/combustible/viajes")).body.data).toHaveLength(0);
    expect(
      (await ajeno.post(`/api/erp/combustible/viajes/${v.id}/anular`).send({ motivo: "ajeno" }))
        .status
    ).toBe(404);
    const propio = Number(
      (await ajeno.post("/api/erp/combustible/lugares").send({ nombre: idUnico("Lima") })).body.id
    );
    const eqAjeno = Number(
      (await ajeno.post("/api/erp/equipos").send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE" }))
        .body.id
    );
    // Lugar de otro tenant.
    expect(
      (
        await ajeno.post("/api/erp/combustible/viajes").send({
          equipo_id: eqAjeno,
          origen_id: huamachuco,
          destino_id: propio,
          inicio_en: hora(0),
        })
      ).status
    ).toBe(400);
    // Unidad de otro tenant.
    const propio2 = Number(
      (await ajeno.post("/api/erp/combustible/lugares").send({ nombre: idUnico("Ica") })).body.id
    );
    expect(
      (
        await ajeno.post("/api/erp/combustible/viajes").send({
          equipo_id: eq,
          origen_id: propio,
          destino_id: propio2,
          inicio_en: hora(0),
        })
      ).status
    ).toBe(404);
  });

  // ── "Mi viaje": el conductor marca su propio viaje (0124) ────────────────
  const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const marcar = (a: Agente, id: string, accion: "iniciar-mio" | "cerrar-mio", body: object) =>
    a.post(`/api/erp/combustible/viajes/${id}/${accion}`).send(body);

  it("el conductor ve solo sus viajes (por su DNI) y no puede marcar los de otro", async () => {
    const yo = await conductor();
    const otro = await conductor();
    const eq = await unidad();
    const eq2 = await unidad();
    const mio = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        origen_id: huamachuco,
        destino_id: bambamarca,
        conductor_nombre: "Yo",
        conductor_dni: yo.dni,
      })
    ).body;
    const ajeno = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq2,
        origen_id: huamachuco,
        destino_id: bambamarca,
        conductor_dni: otro.dni,
      })
    ).body;

    const lista = await yo.agente.get("/api/erp/combustible/viajes/mios");
    expect(lista.status).toBe(200);
    expect(lista.body.data.map((v: { id: string }) => v.id)).toEqual([mio.id]);
    expect(lista.body.data[0].previo).toMatchObject({ tipo_medidor: "odometro" });

    expect((await marcar(yo.agente, ajeno.id, "iniciar-mio", { medidor_inicio: 10 })).status).toBe(
      404
    );
    const ok = await marcar(yo.agente, mio.id, "iniciar-mio", { medidor_inicio: 10 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.estado).toBe("en_curso");
    expect(ok.body.inicio_origen_hora).toBe("servidor");
  });

  it("el reintento de la cola con el mismo uuid no falla; otra marca distinta sí", async () => {
    const yo = await conductor();
    const eq = await unidad();
    const v = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        origen_id: huamachuco,
        destino_id: bambamarca,
        conductor_dni: yo.dni,
      })
    ).body;
    const uuid = crypto.randomUUID();
    const a = await marcar(yo.agente, v.id, "iniciar-mio", {
      medidor_inicio: 50,
      cliente_uuid: uuid,
    });
    const b = await marcar(yo.agente, v.id, "iniciar-mio", {
      medidor_inicio: 50,
      cliente_uuid: uuid,
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.inicio_en).toBe(a.body.inicio_en);
    const c = await marcar(yo.agente, v.id, "iniciar-mio", {
      medidor_inicio: 50,
      cliente_uuid: crypto.randomUUID(),
    });
    expect(c.status).toBe(409);

    const fin = crypto.randomUUID();
    expect(
      (await marcar(yo.agente, v.id, "cerrar-mio", { medidor_fin: 90, cliente_uuid: fin })).status
    ).toBe(200);
    expect(
      (await marcar(yo.agente, v.id, "cerrar-mio", { medidor_fin: 90, cliente_uuid: fin })).status
    ).toBe(200);
  });

  it("sin señal: la marca que llega tarde vale con la hora del celular, marcada como tal", async () => {
    const yo = await conductor();
    const eq = await unidad();
    const v = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        origen_id: huamachuco,
        destino_id: bambamarca,
        conductor_dni: yo.dni,
      })
    ).body;
    // Hora adelantada o vieja de más: se rechaza.
    expect(
      (await marcar(yo.agente, v.id, "iniciar-mio", { medidor_inicio: 1, marcado_en: hace(-60) }))
        .status
    ).toBe(400);
    expect(
      (
        await marcar(yo.agente, v.id, "iniciar-mio", {
          medidor_inicio: 1,
          marcado_en: hace(8 * 24 * 60),
        })
      ).status
    ).toBe(400);

    const salida = hace(180);
    const ini = await marcar(yo.agente, v.id, "iniciar-mio", {
      medidor_inicio: 1,
      marcado_en: salida,
    });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    expect(ini.body.inicio_origen_hora).toBe("dispositivo");
    expect(Date.parse(ini.body.inicio_en)).toBe(Date.parse(salida));

    // Una carga en ruta entra al viaje y el conductor la ve en su tarjeta.
    expect((await cargar(eq, 30, (Date.parse(hace(120)) - T0) / H)).status).toBe(201);
    const enCurso = (await yo.agente.get("/api/erp/combustible/viajes/mios")).body.data[0];
    expect(Number(enCurso.combustible_gal)).toBeCloseTo(30, 1);
    // Ve sus propias cargas y lo que suele tardar la ruta (para estimar la
    // llegada), pero NADA de promedios de consumo ni comparaciones.
    expect(enCurso.cargas_detalle).toHaveLength(1);
    expect(enCurso).toHaveProperty("duracion_ruta_min");
    for (const prohibido of ["promedio_ruta", "promedio_ruta_unidad", "viajes_ruta", "ruta"]) {
      expect(enCurso).not.toHaveProperty(prohibido);
    }

    // Un reloj algo corrido (2 min) en línea no cuenta como "sin señal".
    const fin = await marcar(yo.agente, v.id, "cerrar-mio", {
      medidor_fin: 40,
      marcado_en: hace(2),
    });
    expect(fin.status).toBe(200);
    expect(fin.body.fin_origen_hora).toBe("servidor");
  });

  it("el conductor no toca la gestión de viajes; grifero y Lectura no ven Mi viaje", async () => {
    const yo = await conductor();
    const eq = await unidad();
    const v = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        origen_id: huamachuco,
        destino_id: bambamarca,
        conductor_dni: yo.dni,
      })
    ).body;
    expect((await yo.agente.get("/api/erp/combustible/viajes")).status).toBe(403);
    expect(
      (
        await yo.agente
          .post(`/api/erp/combustible/viajes/${v.id}/iniciar`)
          .send({ medidor_inicio: 1 })
      ).status
    ).toBe(403);
    expect(
      (
        await yo.agente
          .post("/api/erp/combustible/viajes")
          .send({ equipo_id: eq, origen_id: huamachuco, destino_id: bambamarca })
      ).status
    ).toBe(403);
    expect((await (await conRol("grifero")).get("/api/erp/combustible/viajes/mios")).status).toBe(
      403
    );
    expect((await (await conRol("lectura")).get("/api/erp/combustible/viajes/mios")).status).toBe(
      403
    );

    const lista = await admin.get("/api/erp/combustible/viajes/conductores");
    expect(lista.status).toBe(200);
    expect(lista.body.data.map((c: { dni: string }) => c.dni)).toContain(yo.dni);
  });

  it("el detalle trae cuánto suele durar y consumir la ruta (para la llegada estimada)", async () => {
    const eq = await unidad();
    const a = await lugar(idUnico("Cajabamba"));
    const b = await lugar(idUnico("Celendin"));
    // Tres viajes cerrados de 3, 5 y 4 horas, con 30, 40 y 50 gal.
    for (const [ini, dur, gal] of [
      [10, 3, 30],
      [20, 5, 40],
      [30, 4, 50],
    ]) {
      const v = await viaje(eq, {
        origen_id: a,
        destino_id: b,
        inicio_en: hora(ini),
        fin_en: hora(ini + dur),
      });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      expect((await cargar(eq, gal, ini + 1)).status).toBe(201);
    }
    const p = (await programar(eq, { origen_id: a, destino_id: b })).body;
    const det = await admin.get(`/api/erp/combustible/viajes/${p.id}`);
    expect(det.status).toBe(200);
    expect(det.body.ruta.viajes).toBe(3);
    expect(det.body.ruta.duracion_min).toBeCloseTo(240, 0);
    expect(det.body.ruta.combustible_gal).toBeCloseTo(40, 1);
  });
});
