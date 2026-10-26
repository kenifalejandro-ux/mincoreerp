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
      conductor_dni: String(40000000 + seq++), // uno por unidad: nadie maneja dos viajes a la vez
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
        abastece_urea_ruta: true,
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

    expect((await admin.put(url).send({ observaciones: "Lleva carga" })).status).toBe(400);
    const ed = await admin
      .put(url)
      .send({ observaciones: "Lleva carga", motivo: "Aclaro la carga" });
    expect(ed.status).toBe(200);
    expect(ed.body.observaciones).toBe("Lleva carga");
    // Un viaje cerrado no se reabre borrándole la llegada.
    expect((await admin.put(url).send({ fin_en: null, motivo: "reabrir" })).status).toBe(400);

    expect((await admin.post(`${url}/anular`).send({})).status).toBe(400);
    expect((await admin.post(`${url}/anular`).send({ motivo: "Duplicado" })).status).toBe(200);
    expect((await consumo(eq)).body.data).toHaveLength(0);
    expect((await admin.put(url).send({ observaciones: "x", motivo: "x".repeat(5) })).status).toBe(
      409
    );
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

  it("no se programa un viaje para una unidad sin conductor (nadie lo vería en Mi viaje)", async () => {
    const sin = await admin
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("VQ"), tipo: "VOLQUETE" });
    expect(sin.status).toBe(201);
    const r = await programar(Number(sin.body.id));
    expect(r.status).toBe(400);
    expect(r.body.message ?? r.body.error).toContain("no tiene conductor asignado");
    // Con el conductor indicado en el propio viaje, sí se puede.
    const con = await programar(Number(sin.body.id), {
      conductor_nombre: "Luis Rojas",
      conductor_dni: "40000099",
    });
    expect(con.status, JSON.stringify(con.body)).toBe(201);
  });

  it("un viaje programado de la misma unidad no impide cerrar ni iniciar otro (regresión: rango sin salida chocaba con todo)", async () => {
    const eq = await unidad();
    const a = (await programar(eq)).body;
    const b = (await programar(eq)).body; // queda programado, sin salida
    expect((await admin.post(url(a.id, "/iniciar")).send({ medidor_inicio: 100 })).status).toBe(
      200
    );
    const fin = await admin.post(url(a.id, "/cerrar")).send({ medidor_fin: 150 });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.estado).toBe("cerrado");
    // El programado sigue libre y ahora sí puede iniciar.
    const ini = await admin.post(url(b.id, "/iniciar")).send({ medidor_inicio: 150 });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
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
  const marcar = (
    a: Agente,
    id: string | number,
    accion:
      | "iniciar-mio"
      | "cerrar-mio"
      | "llegada-mia"
      | "salida-mia"
      | "descanso-mio"
      | "descanso-mio/terminar"
      | "mando/entregar"
      | "mando/aceptar"
      | "mando/retirar",
    body: object
  ) => a.post(`/api/erp/combustible/viajes/${id}/${accion}`).send(body);

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
  // ── Paradas (0148) ────────────────────────────────────────────────────────

  const paradasDe = async (id: number) =>
    (await admin.get(url(id))).body.viaje.paradas as {
      orden: number;
      lugar_id: number;
      llegada_en: string | null;
      llegada_medidor: string | null;
      salida_en: string | null;
      salida_medidor: string | null;
    }[];

  it("un viaje sin paradas se arma como origen → destino y las devuelve", async () => {
    const eq = await unidad();
    const v = (await programar(eq)).body;
    expect(v.paradas.map((p: { lugar_id: number }) => p.lugar_id)).toEqual([
      huamachuco,
      bambamarca,
    ]);
    expect((await paradasDe(v.id)).map((p) => p.orden)).toEqual([0, 1]);
  });

  it("A → B → A: origen y destino son la ida, hay tres paradas y las marcas de los extremos se copian", async () => {
    const eq = await unidad();
    const p = await admin.post("/api/erp/combustible/viajes").send({
      equipo_id: eq,
      paradas: [huamachuco, bambamarca, huamachuco],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(Number(p.body.origen_id)).toBe(huamachuco);
    expect(Number(p.body.destino_id)).toBe(bambamarca);
    expect(p.body.paradas.map((x: { lugar_id: number }) => x.lugar_id)).toEqual([
      huamachuco,
      bambamarca,
      huamachuco,
    ]);

    const ini = await admin.post(url(p.body.id, "/iniciar")).send({ medidor_inicio: 100 });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    const tras = await paradasDe(p.body.id);
    expect(Number(tras[0].salida_medidor)).toBe(100);
    expect(tras[0].salida_en).toBeTruthy();
    expect(tras[2].llegada_en).toBeNull();

    // Con varias paradas el viaje no cierra en la primera llegada (ver las pruebas de
    // llegada y salida de cada parada).
    expect((await admin.post(url(p.body.id, "/cerrar")).send({ medidor_fin: 300 })).status).toBe(
      409
    );
  });

  it("paradas inválidas: seguidas iguales, lugar inexistente, desbordado, inconsistente o ya terminado", async () => {
    const eq = await unidad();
    const crear = (extra: Record<string, unknown>) =>
      admin.post("/api/erp/combustible/viajes").send({ equipo_id: eq, ...extra });
    expect((await crear({ paradas: [huamachuco, huamachuco, bambamarca] })).status).toBe(400);
    expect((await crear({ paradas: [huamachuco, 987654321] })).status).toBe(400);
    expect((await crear({ paradas: [huamachuco, 1e20] })).status).toBe(400); // no es un 500
    expect((await crear({ paradas: [huamachuco] })).status).toBe(400);
    expect((await crear({ paradas: [huamachuco, bambamarca], origen_id: bambamarca })).status).toBe(
      400
    );
    expect((await crear({})).status).toBe(400); // ni paradas ni origen y destino
    const terminado = await crear({
      paradas: [huamachuco, bambamarca, huamachuco],
      inicio_en: hora(130),
      fin_en: hora(135),
    });
    expect(terminado.status).toBe(400);
    expect(JSON.stringify(terminado.body)).toContain("parada por parada");
  });

  it("un lugar de otro tenant no entra como parada", async () => {
    const otro = await crearTenantDePrueba(password);
    tenants.push(otro.tenant.id);
    const ajeno = request.agent(app);
    await ajeno
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    const lugarAjeno = Number(
      (await ajeno.post("/api/erp/combustible/lugares").send({ nombre: idUnico("Lima") })).body.id
    );
    const eq = await unidad();
    const r = await admin.post("/api/erp/combustible/viajes").send({
      equipo_id: eq,
      paradas: [huamachuco, bambamarca, lugarAjeno],
    });
    expect(r.status).toBe(400);
  });

  it("editar un viaje mantiene sus paradas al día; con varias paradas no se cambia el recorrido", async () => {
    const eq = await unidad();
    const dos = (await viaje(eq, { inicio_en: hora(140), fin_en: hora(143) })).body;
    const ed = await admin.put(url(dos.id)).send({
      motivo: "corrijo la llegada",
      fin_en: hora(144),
      medidor_inicio: 10,
      medidor_fin: 90,
    });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    const p2 = await paradasDe(dos.id);
    expect(Date.parse(p2[1].llegada_en!)).toBe(Date.parse(hora(144)));
    expect(Number(p2[1].llegada_medidor)).toBe(90);
    expect(Number(p2[0].salida_medidor)).toBe(10);
    // Cambiar el destino de un viaje de dos paradas mueve la parada final.
    const lejos = await lugar(idUnico("Cajamarca"));
    expect(
      (await admin.put(url(dos.id)).send({ motivo: "era otro destino", destino_id: lejos })).status
    ).toBe(200);
    expect((await paradasDe(dos.id))[1].lugar_id).toBe(lejos);

    const eq2 = await unidad();
    const circuito = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq2,
        paradas: [huamachuco, bambamarca, lejos, huamachuco],
      })
    ).body;
    const rechazo = await admin
      .put(url(circuito.id))
      .send({ motivo: "quiero otro recorrido", destino_id: lejos });
    expect(rechazo.status).toBe(409);
    // Lo que no toca el recorrido sí se corrige.
    expect(
      (
        await admin
          .put(url(circuito.id))
          .send({ motivo: "una nota", observaciones: "carga de cal" })
      ).status
    ).toBe(200);
  });
  // ── Llegar y salir de cada parada ────────────────────────────────────────

  /** Un conductor con su unidad y un viaje A → B → A ya iniciado en el km 100. */
  async function circuitoEnCurso(paradas = [huamachuco, bambamarca, huamachuco]) {
    const yo = await conductor();
    const eq = await unidad();
    const v = (
      await admin
        .post("/api/erp/combustible/viajes")
        .send({ equipo_id: eq, paradas, conductor_dni: yo.dni })
    ).body;
    const ini = await marcar(yo.agente, v.id, "iniciar-mio", { medidor_inicio: 100 });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    return { yo, eq, id: Number(v.id) };
  }

  it("ida y vuelta: llega y sale de cada parada, y el viaje cierra solo en la última", async () => {
    const { yo, id, eq } = await circuitoEnCurso();
    const lleg = await marcar(yo.agente, id, "llegada-mia", { medidor: 150, orden: 1 });
    expect(lleg.status, JSON.stringify(lleg.body)).toBe(200);
    expect(lleg.body.estado).toBe("en_curso");
    const enB = (await paradasDe(id))[1];
    expect(Number(enB.llegada_medidor)).toBe(150);
    expect(enB.salida_en).toBeNull();

    // La lectura de la parada ya cuenta: un vale con un km menor entra, pero alerta por retroceso.
    const valeEn = async (odometro: number) => {
      const serie = serieUnica();
      const r = await admin.post("/api/erp/combustible/despachos").send({
        origen: "tanque_propio",
        combustible_id: tanque,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: eq,
        serie_talonario: serie,
        n_vale: 1,
        cantidad: 10,
        lectura_contometro: 10,
        lectura_odometro: odometro,
        costo_unitario: 16.8,
        despachado_en: new Date().toISOString(),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const alertas = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
      return (alertas.body.data as { tipo: string; serie_talonario: string }[]).find(
        (a) => a.tipo === "medidor_inconsistente" && a.serie_talonario === serie
      );
    };
    expect(await valeEn(120)).toBeDefined();
    expect(await valeEn(160)).toBeUndefined();

    const sale = await marcar(yo.agente, id, "salida-mia", { medidor: 150, orden: 1 });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect((await paradasDe(id))[1].salida_en).toBeTruthy();

    const fin = await marcar(yo.agente, id, "llegada-mia", { medidor: 250, orden: 2 });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.estado).toBe("cerrado");
    const tras = await paradasDe(id);
    expect(Number(tras[2].llegada_medidor)).toBe(250);
    expect(tras[2].llegada_en).toBeTruthy();
  });

  it("una marca fuera de orden, sin medidor, menor o sobre un viaje cerrado se rechaza", async () => {
    const { yo, id } = await circuitoEnCurso();
    const m = (accion: Parameters<typeof marcar>[2], body: Record<string, unknown>) =>
      marcar(yo.agente, id, accion, body);
    expect((await m("salida-mia", { medidor: 120 })).status).toBe(409); // todavía no llegó a B
    expect((await m("llegada-mia", { medidor: 150, orden: 2 })).status).toBe(409); // va hacia la 1
    expect((await m("llegada-mia", { medidor: 90, orden: 1 })).status).toBe(400); // menor que 100
    expect((await m("llegada-mia", { orden: 1 })).status).toBe(400); // sin medidor
    expect((await m("cerrar-mio", { medidor_fin: 150 })).status).toBe(409); // faltan paradas
    expect((await m("llegada-mia", { medidor: 150, orden: 1 })).status).toBe(200);
    expect((await m("llegada-mia", { medidor: 160 })).status).toBe(409); // ya está en B
    expect((await m("salida-mia", { medidor: 140 })).status).toBe(400); // menor que la llegada
    expect((await m("salida-mia", { medidor: 150 })).status).toBe(200);
    expect((await m("llegada-mia", { medidor: 250 })).status).toBe(200); // cierra
    expect((await m("llegada-mia", { medidor: 260 })).status).toBe(409); // ya cerrado
    expect((await m("salida-mia", { medidor: 260 })).status).toBe(409);
  });

  it("el reintento de la cola con el mismo uuid no duplica la marca", async () => {
    const { yo, id } = await circuitoEnCurso();
    const uuid = crypto.randomUUID();
    const a = await marcar(yo.agente, id, "llegada-mia", { medidor: 150, cliente_uuid: uuid });
    const b = await marcar(yo.agente, id, "llegada-mia", { medidor: 150, cliente_uuid: uuid });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await paradasDe(id))[1].llegada_en).toBeTruthy();
    const salida = crypto.randomUUID();
    const c = await marcar(yo.agente, id, "salida-mia", { medidor: 150, cliente_uuid: salida });
    const d = await marcar(yo.agente, id, "salida-mia", { medidor: 150, cliente_uuid: salida });
    expect(c.status).toBe(200);
    expect(d.status).toBe(200);
    // El mismo uuid del otro viaje no se puede reutilizar.
    const otro = await circuitoEnCurso();
    const robado = await marcar(otro.yo.agente, otro.id, "llegada-mia", {
      medidor: 150,
      cliente_uuid: uuid,
    });
    expect(robado.status).toBe(409);
  });

  it("dos llegadas a la vez: una gana y la otra se rechaza", async () => {
    const { yo, id } = await circuitoEnCurso();
    const dos = await Promise.all([
      marcar(yo.agente, id, "llegada-mia", { medidor: 150, cliente_uuid: crypto.randomUUID() }),
      marcar(yo.agente, id, "llegada-mia", { medidor: 151, cliente_uuid: crypto.randomUUID() }),
    ]);
    expect(dos.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("otro conductor no marca el viaje ajeno", async () => {
    const { id } = await circuitoEnCurso();
    const intruso = await conductor();
    expect((await marcar(intruso.agente, id, "llegada-mia", { medidor: 150 })).status).toBe(404);
    expect((await marcar(intruso.agente, id, "salida-mia", { medidor: 150 })).status).toBe(404);
  });

  it("la oficina marca por el conductor: con hora a mano pide motivo y no admite una hora futura", async () => {
    const { id } = await circuitoEnCurso();
    const marca = (body: Record<string, unknown>) =>
      admin.post(url(id, "/llegada")).send({ medidor: 150, orden: 1, ...body });
    await new Promise((r) => setTimeout(r, 100));
    const aMano = new Date(Date.now() - 20).toISOString();
    expect((await marca({ llegada_en: aMano })).status).toBe(400); // sin motivo
    const futura = new Date(Date.now() + 3_600_000).toISOString();
    expect((await marca({ llegada_en: futura, motivo: "sin señal" })).status).toBe(400);
    const ok = await marca({ llegada_en: aMano, motivo: "el conductor no tenía señal" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(Date.parse((await paradasDe(id))[1].llegada_en!)).toBe(Date.parse(aMano));
    // Sin hora a mano la pone el servidor, y no pide motivo.
    expect((await admin.post(url(id, "/salida")).send({ medidor: 150 })).status).toBe(200);
  });
  // ── Consumo por tramo y comparación por recorrido ────────────────────────

  const cargarAhora = async (equipo_id: number, cantidad: number) => {
    const r = await admin.post("/api/erp/combustible/despachos").send({
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
      despachado_en: new Date().toISOString(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };

  it("el detalle reparte lo cargado entre los tramos: la carga de una parada va al tramo que sigue", async () => {
    const { yo, id, eq } = await circuitoEnCurso();
    const m = (accion: Parameters<typeof marcar>[2], body: object) =>
      marcar(yo.agente, id, accion, body);
    await cargarAhora(eq, 10); // antes de llegar a B: tramo 1
    expect((await m("llegada-mia", { medidor: 150 })).status).toBe(200);
    await cargarAhora(eq, 20); // ya en B, antes de salir: tramo 2
    expect((await m("salida-mia", { medidor: 150 })).status).toBe(200);
    await cargarAhora(eq, 5); // en ruta hacia A: tramo 2
    expect((await m("llegada-mia", { medidor: 250 })).status).toBe(200);

    const det = await admin.get(url(id));
    expect(det.status).toBe(200);
    const tramos = det.body.tramos as {
      de: string;
      a: string;
      recorrido: number;
      combustible_gal: number;
    }[];
    expect(tramos).toHaveLength(2);
    expect(tramos[0].recorrido).toBe(50);
    expect(tramos[0].combustible_gal).toBeCloseTo(10, 1);
    expect(tramos[1].recorrido).toBe(100);
    expect(tramos[1].combustible_gal).toBeCloseTo(25, 1);
    expect(tramos[0].a).toBe(tramos[1].de);
  });

  it("sin 'cuenta como': solo se comparan viajes con el MISMO recorrido", async () => {
    const x = await lugar(idUnico("Origen"));
    const y = await lugar(idUnico("Destino"));
    const ida = async (h: number, gal: number) => {
      const eq = await unidad();
      const r = await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        origen_id: x,
        destino_id: y,
        inicio_en: hora(h),
        fin_en: hora(h + 4),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await cargar(eq, gal, h + 1)).status).toBe(201);
      return eq;
    };
    await ida(10, 40);
    await ida(30, 60);

    // El circuito x → y → x de otra unidad cierra con mucho más combustible.
    const { yo, id, eq } = await circuitoEnCurso([x, y, x]);
    await cargarAhora(eq, 500);
    expect((await marcar(yo.agente, id, "llegada-mia", { medidor: 150 })).status).toBe(200);
    expect((await marcar(yo.agente, id, "salida-mia", { medidor: 150 })).status).toBe(200);
    expect((await marcar(yo.agente, id, "llegada-mia", { medidor: 250 })).status).toBe(200);

    const filas = (
      await admin.get("/api/erp/combustible/viajes/consumo").query({ producto: "combustible" })
    ).body.data as { recorrido_clave: string; promedio_ruta: string; viajes_ruta: string }[];
    const delCircuito = filas.filter((f) => f.recorrido_clave === `${x}-${y}-${x}`);
    const delTramoSolo = filas.filter((f) => f.recorrido_clave === `${x}-${y}`);
    expect(delCircuito).toHaveLength(1);
    expect(Number(delCircuito[0].viajes_ruta)).toBe(1);
    expect(Number(delCircuito[0].promedio_ruta)).toBeCloseTo(500, 0);
    expect(delTramoSolo).toHaveLength(2);
    expect(Number(delTramoSolo[0].viajes_ruta)).toBe(2);
    expect(Number(delTramoSolo[0].promedio_ruta)).toBeCloseTo(50, 0);
  });
  // ── Descansos ────────────────────────────────────────────────────────────

  type Descanso = {
    fin_en: string | null;
    motivo: string | null;
    inicio_por: string;
    fin_por: string | null;
  };
  const descansosDe = async (id: number) =>
    ((await admin.get(url(id))).body.viaje.descansos ?? []) as Descanso[];

  it("el conductor descansa: con el descanso abierto el viaje no avanza; lo termina y sigue", async () => {
    const { yo, id } = await circuitoEnCurso();
    const m = (accion: Parameters<typeof marcar>[2], body: object = {}) =>
      marcar(yo.agente, id, accion, body);
    const ini = await m("descanso-mio", { motivo: "Dormir" });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    const abierto = ini.body.descansos as Descanso[];
    expect(abierto).toHaveLength(1);
    expect(abierto[0]).toMatchObject({ motivo: "Dormir", fin_en: null, inicio_por: "conductor" });

    expect((await m("llegada-mia", { medidor: 150 })).status).toBe(409); // sin terminar el descanso
    expect((await m("descanso-mio", { motivo: "Comer" })).status).toBe(409); // uno a la vez
    const fin = await m("descanso-mio/terminar");
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect((fin.body.descansos as Descanso[])[0].fin_en).toBeTruthy();
    expect((await m("descanso-mio/terminar")).status).toBe(409); // ya no hay uno abierto
    expect((await m("llegada-mia", { medidor: 150 })).status).toBe(200);
  });

  it("editar un viaje con paradas marcadas no deja la salida ni el medidor por fuera de ellas", async () => {
    const { yo, id } = await circuitoEnCurso();
    expect((await marcar(yo.agente, id, "llegada-mia", { medidor: 150 })).status).toBe(200);
    const manana = new Date(Date.now() + 3_600_000).toISOString();
    const salidaTardia = await admin
      .put(url(id))
      .send({ motivo: "salida mal puesta", inicio_en: manana });
    expect(salidaTardia.status).toBe(409);
    expect(JSON.stringify(salidaTardia.body)).toContain("parada marcada");
    const medidorAlto = await admin
      .put(url(id))
      .send({ motivo: "medidor mal puesto", medidor_inicio: 200 });
    expect(medidorAlto.status).toBe(409);
    expect(JSON.stringify(medidorAlto.body)).toContain("medidor");
    // Lo que sigue dentro de lo marcado sí se corrige.
    const bien = await admin.put(url(id)).send({ motivo: "era el 120", medidor_inicio: 120 });
    expect(bien.status, JSON.stringify(bien.body)).toBe(200);
    expect(Number((await paradasDe(id))[0].salida_medidor)).toBe(120);
  });

  it("editar un viaje con un descanso marcado no deja la salida después del descanso", async () => {
    const { yo, id } = await circuitoEnCurso();
    expect((await marcar(yo.agente, id, "descanso-mio", { motivo: "Dormir" })).status).toBe(200);
    expect((await marcar(yo.agente, id, "descanso-mio/terminar", {})).status).toBe(200);
    const manana = new Date(Date.now() + 3_600_000).toISOString();
    const r = await admin.put(url(id)).send({ motivo: "salida mal puesta", inicio_en: manana });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("descanso");
    expect((await descansosDe(id)).length).toBe(1);
    expect((await admin.put(url(id)).send({ motivo: "una nota", observaciones: "x" })).status).toBe(
      200
    );
  });

  it("el reintento de la cola no duplica el descanso; el uuid de otro viaje no vale", async () => {
    const { yo, id } = await circuitoEnCurso();
    const uuid = crypto.randomUUID();
    const a = await marcar(yo.agente, id, "descanso-mio", { cliente_uuid: uuid });
    const b = await marcar(yo.agente, id, "descanso-mio", { cliente_uuid: uuid });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await descansosDe(id)).toHaveLength(1);
    const fin = crypto.randomUUID();
    expect(
      (await marcar(yo.agente, id, "descanso-mio/terminar", { cliente_uuid: fin })).status
    ).toBe(200);
    expect(
      (await marcar(yo.agente, id, "descanso-mio/terminar", { cliente_uuid: fin })).status
    ).toBe(200);
    const otro = await circuitoEnCurso();
    const robado = await marcar(otro.yo.agente, otro.id, "descanso-mio", { cliente_uuid: uuid });
    expect(robado.status).toBe(409);
  });

  it("no descansa quien no es del viaje, ni antes de salir, ni con el viaje cerrado", async () => {
    const { yo, id } = await circuitoEnCurso();
    const intruso = await conductor();
    expect((await marcar(intruso.agente, id, "descanso-mio", {})).status).toBe(404);

    const otro = await conductor();
    const eq = await unidad();
    const programado = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        paradas: [huamachuco, bambamarca, huamachuco],
        conductor_dni: otro.dni,
      })
    ).body;
    expect((await marcar(otro.agente, programado.id, "descanso-mio", {})).status).toBe(409);

    const m = (accion: Parameters<typeof marcar>[2], body: object) =>
      marcar(yo.agente, id, accion, body);
    expect((await m("llegada-mia", { medidor: 150 })).status).toBe(200);
    expect((await m("salida-mia", { medidor: 150 })).status).toBe(200);
    expect((await m("llegada-mia", { medidor: 250 })).status).toBe(200); // cierra
    expect((await m("descanso-mio", {})).status).toBe(409);
  });

  it("la oficina marca el descanso por el conductor: pide motivo y una hora que no sea anterior a la salida", async () => {
    const { id } = await circuitoEnCurso();
    const post = (accion: string, body: object) => admin.post(url(id, accion)).send(body);
    expect((await post("/descanso", {})).status).toBe(400); // sin motivo
    expect((await post("/descanso", { motivo: "ab" })).status).toBe(400); // motivo muy corto
    expect((await post("/descanso", { motivo: "Avería", inicio_en: hora(0) })).status).toBe(400);
    const ok = await post("/descanso", { motivo: "Avería" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await descansosDe(id))[0]).toMatchObject({ motivo: "Avería", inicio_por: "oficina" });
    // Con hora a mano para terminar, el motivo es obligatorio.
    expect((await post("/descanso/terminar", { fin_en: new Date().toISOString() })).status).toBe(
      400
    );
    expect((await post("/descanso/terminar", {})).status).toBe(200);
    expect((await descansosDe(id))[0]).toMatchObject({ fin_por: "oficina" });
  });

  it("si la oficina cierra el viaje con un descanso abierto, el descanso se termina", async () => {
    const eq = await unidad();
    const p = (await programar(eq)).body;
    expect((await admin.post(url(p.id, "/iniciar")).send({ medidor_inicio: 10 })).status).toBe(200);
    expect((await admin.post(url(p.id, "/descanso")).send({ motivo: "Dormir" })).status).toBe(200);
    const cierre = await admin.post(url(p.id, "/cerrar")).send({ medidor_fin: 90 });
    expect(cierre.status, JSON.stringify(cierre.body)).toBe(200);
    expect((await descansosDe(p.id))[0]).toMatchObject({ fin_por: "oficina" });
    expect((await descansosDe(p.id))[0].fin_en).toBeTruthy();
  });
  // ── Historial del conductor ──────────────────────────────────────────────

  type FilaHistorial = {
    id: string;
    numero: number;
    paradas: string[];
    recorrido: string | null;
    descanso_min: string | number;
    parte_min?: string | number | null;
  };
  const historial = (agente: Agente, query: Record<string, string | number> = {}) =>
    agente.get("/api/erp/combustible/viajes/mios/historial").query(query);

  it("el historial del conductor trae solo sus viajes cerrados, del más reciente al más viejo, por páginas", async () => {
    const yo = await conductor();
    const otro = await conductor();
    const cerrado = async (dni: string, h: number, ini: number, fin: number) => {
      const eq = await unidad(); // antes de armar la petición: dos en el mismo agente se pisan
      const r = await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        origen_id: huamachuco,
        destino_id: bambamarca,
        conductor_dni: dni,
        inicio_en: hora(h),
        fin_en: hora(h + 4),
        medidor_inicio: ini,
        medidor_fin: fin,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return Number(r.body.id);
    };
    const v1 = await cerrado(yo.dni, 10, 100, 250);
    const v2 = await cerrado(yo.dni, 20, 300, 340);
    const v3 = await cerrado(yo.dni, 30, 400, 480);
    await cerrado(otro.dni, 40, 10, 20);
    // Programado y en curso no son historial.
    const eqProgramado = await unidad();
    await admin.post("/api/erp/combustible/viajes").send({
      equipo_id: eqProgramado,
      paradas: [huamachuco, bambamarca],
      conductor_dni: yo.dni,
    });

    const todos = await historial(yo.agente);
    expect(todos.status, JSON.stringify(todos.body)).toBe(200);
    const filas = todos.body.data as FilaHistorial[];
    expect(filas.map((f) => Number(f.id))).toEqual([v3, v2, v1]);
    expect(Number(filas[0].recorrido)).toBe(80);
    expect(filas[0].paradas).toHaveLength(2);
    expect(todos.body.siguiente).toBeNull();

    // Por páginas: la llegada del último que ya tiene es el cursor.
    const p1 = await historial(yo.agente, { limite: 2 });
    expect((p1.body.data as FilaHistorial[]).map((f) => Number(f.id))).toEqual([v3, v2]);
    expect(p1.body.siguiente).toBeTruthy();
    const p2 = await historial(yo.agente, { limite: 2, antes: p1.body.siguiente });
    expect((p2.body.data as FilaHistorial[]).map((f) => Number(f.id))).toEqual([v1]);
    expect(p2.body.siguiente).toBeNull();

    // El otro conductor solo ve lo suyo.
    expect(((await historial(otro.agente)).body.data as FilaHistorial[]).length).toBe(1);
  });

  it("el historial cuenta lo descansado, rechaza parámetros rotos y no es para otros perfiles", async () => {
    const { yo, id } = await circuitoEnCurso();
    const m = (accion: Parameters<typeof marcar>[2], body: object = {}) =>
      marcar(yo.agente, id, accion, body);
    expect((await m("descanso-mio", { motivo: "Dormir" })).status).toBe(200);
    expect((await m("descanso-mio/terminar")).status).toBe(200);
    expect((await m("llegada-mia", { medidor: 150 })).status).toBe(200);
    expect((await m("salida-mia", { medidor: 150 })).status).toBe(200);
    expect((await m("llegada-mia", { medidor: 250 })).status).toBe(200);

    const fila = ((await historial(yo.agente)).body.data as FilaHistorial[])[0];
    expect(Number(fila.id)).toBe(id);
    expect(Number(fila.recorrido)).toBe(150);
    expect(Number(fila.descanso_min)).toBeGreaterThan(0);
    expect(fila.paradas).toHaveLength(3);

    expect((await historial(yo.agente, { antes: "no-es-una-fecha" })).status).toBe(400);
    expect((await historial(yo.agente, { limite: 0 })).status).toBe(400);
    expect((await historial(yo.agente, { limite: 51 })).status).toBe(400);
    expect((await historial(await conRol("grifero"))).status).toBe(403);
    expect((await historial(await conRol("lectura"))).status).toBe(403);
  });

  // ── Relevo y turnos de conducción ────────────────────────────────────────

  /** Un viaje programado con titular y relevo (los dos con cuenta de conductor). */
  async function conRelevo(sale?: "titular" | "relevo", paradas = [huamachuco, bambamarca]) {
    const titular = await conductor();
    const relevo = await conductor();
    const eq = await unidad();
    const r = await admin.post("/api/erp/combustible/viajes").send({
      equipo_id: eq,
      paradas,
      conductor_dni: titular.dni,
      relevo_dni: relevo.dni,
      ...(sale ? { sale } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { titular, relevo, eq, id: Number(r.body.id), viaje: r.body };
  }
  const miosDe = async (agente: Agente) =>
    (await agente.get("/api/erp/combustible/viajes/mios")).body.data as {
      id: string;
      mi_rol: string;
      volante_dni: string;
      estado: string;
    }[];

  it("se programa con relevo: tiene que ser otra persona, conductor activo con DNI de la empresa", async () => {
    const { relevo, viaje } = await conRelevo("relevo");
    expect(viaje).toMatchObject({ relevo_dni: relevo.dni, sale_primero: "relevo" });
    const titular = await conductor();
    const nuevo = (extra: Record<string, unknown>) =>
      unidad().then((eq) =>
        admin.post("/api/erp/combustible/viajes").send({
          equipo_id: eq,
          paradas: [huamachuco, bambamarca],
          conductor_dni: titular.dni,
          ...extra,
        })
      );
    expect((await nuevo({ relevo_dni: titular.dni })).status).toBe(400); // él mismo
    expect((await nuevo({ relevo_dni: "99999999" })).status).toBe(400); // no es usuario
    const noConductor = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Un operador", dni: "86999001", password, rol: "operador" });
    expect(noConductor.status).toBe(201);
    expect((await nuevo({ relevo_dni: "86999001" })).status).toBe(400); // otro rol
    expect((await nuevo({ sale: "relevo" })).status).toBe(400); // sale el relevo, pero no hay
    expect((await nuevo({ relevo_dni: relevo.dni })).status).toBe(201);
  });

  it("marca el que va al volante: el otro del viaje recibe 409 y un extraño, 404", async () => {
    const { titular, relevo, id } = await conRelevo();
    const intruso = await conductor();
    const marca = (a: Agente, accion: Parameters<typeof marcar>[2], body: object) =>
      marcar(a, id, accion, body);
    expect((await marca(relevo.agente, "iniciar-mio", { medidor_inicio: 10 })).status).toBe(409);
    expect((await marca(intruso.agente, "iniciar-mio", { medidor_inicio: 10 })).status).toBe(404);
    expect((await marca(titular.agente, "iniciar-mio", { medidor_inicio: 10 })).status).toBe(200);
    expect((await marca(relevo.agente, "llegada-mia", { medidor: 20 })).status).toBe(409);
    expect((await marca(titular.agente, "llegada-mia", { medidor: 20 })).status).toBe(200);
  });

  it("Mi viaje le muestra el viaje al relevo (en consulta) y la unidad sigue a quien maneja", async () => {
    const { titular, relevo, id, viaje } = await conRelevo();
    const delRelevo = (await miosDe(relevo.agente)).find((x) => Number(x.id) === id);
    expect(delRelevo).toMatchObject({ mi_rol: "relevo", volante_dni: titular.dni });
    expect((await miosDe(titular.agente)).find((x) => Number(x.id) === id)?.mi_rol).toBe("titular");
    const unidadDe = async (a: Agente) =>
      (await a.get("/api/erp/combustible/viajes/mi-unidad")).body.data;
    expect((await unidadDe(titular.agente))?.viaje_id).toBe(id);
    expect(await unidadDe(relevo.agente)).toBeNull(); // todavía no maneja
    // Si sale el relevo, la unidad es de él y no del titular.
    const otro = await conRelevo("relevo");
    expect((await unidadDe(otro.relevo.agente))?.viaje_id).toBe(otro.id);
    expect(await unidadDe(otro.titular.agente)).toBeNull();
    expect(viaje.sale_primero).toBe("titular");
  });

  it("al iniciar nace el primer turno, y nadie va al volante de dos viajes a la vez", async () => {
    const { relevo, id } = await conRelevo("relevo");
    expect((await marcar(relevo.agente, id, "iniciar-mio", { medidor_inicio: 10 })).status).toBe(
      200
    );
    const turnos = (await admin.get(url(id))).body.viaje.turnos as {
      conductor_dni: string;
      fin_en: string | null;
    }[];
    expect(turnos).toHaveLength(1);
    expect(turnos[0]).toMatchObject({ conductor_dni: relevo.dni, fin_en: null });

    // El mismo conductor, con otro viaje: no puede salir mientras maneja el primero.
    const eq2 = await unidad();
    const otro = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq2,
        paradas: [huamachuco, bambamarca],
        conductor_dni: relevo.dni,
      })
    ).body;
    const choque = await marcar(relevo.agente, otro.id, "iniciar-mio", { medidor_inicio: 5 });
    expect(choque.status, JSON.stringify(choque.body)).toBe(409);
    // Al cerrar el primero, queda libre.
    expect((await marcar(relevo.agente, id, "cerrar-mio", { medidor_fin: 50 })).status).toBe(200);
    expect(
      (await marcar(relevo.agente, otro.id, "iniciar-mio", { medidor_inicio: 5 })).status
    ).toBe(200);
  });

  it("el descanso del que no maneja no frena el viaje; el del que maneja, sí", async () => {
    // Con una parada intermedia: llegar a la última cerraría el viaje y con él todos los descansos.
    const { titular, relevo, id } = await conRelevo(undefined, [
      huamachuco,
      bambamarca,
      huamachuco,
    ]);
    expect((await marcar(titular.agente, id, "iniciar-mio", { medidor_inicio: 10 })).status).toBe(
      200
    );
    const d = await marcar(relevo.agente, id, "descanso-mio", { motivo: "Dormir" });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect((d.body.descansos as { detiene: boolean }[])[0].detiene).toBe(false);
    // Mientras el relevo duerme, el titular sigue su viaje.
    expect((await marcar(titular.agente, id, "llegada-mia", { medidor: 20 })).status).toBe(200);
    const fin = await marcar(relevo.agente, id, "descanso-mio/terminar", {});
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
  });

  it("el historial muestra solo su parte: el relevo que manejó lo ve, el titular que no manejó, no", async () => {
    const { titular, relevo, id } = await conRelevo("relevo");
    const m = (accion: Parameters<typeof marcar>[2], body: object) =>
      marcar(relevo.agente, id, accion, body);
    expect((await m("iniciar-mio", { medidor_inicio: 100 })).status).toBe(200);
    expect((await m("llegada-mia", { medidor: 180 })).status).toBe(200); // cierra: 2 paradas

    const delRelevo = ((await historial(relevo.agente)).body.data as FilaHistorial[]).find(
      (f) => Number(f.id) === id
    );
    expect(Number(delRelevo?.recorrido)).toBe(80);
    expect(Number(delRelevo?.parte_min ?? -1)).toBeGreaterThanOrEqual(0);
    const delTitular = (await historial(titular.agente)).body.data as FilaHistorial[];
    expect(delTitular.find((f) => Number(f.id) === id)).toBeUndefined();
  });

  // ── Entrega del mando ────────────────────────────────────────────────────

  const enCurso = async () => {
    const c = await conRelevo(undefined, [huamachuco, bambamarca, huamachuco]);
    const ini = await marcar(c.titular.agente, c.id, "iniciar-mio", { medidor_inicio: 100 });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    return c;
  };
  // El viaje como lo ve Mi viaje del conductor (la fila completa, con turnos y entrega).
  const viajeDe = async (a: Agente, id: number) =>
    (await a.get("/api/erp/combustible/viajes/mios")).body.data.find(
      (x: { id: string }) => Number(x.id) === id
    ) as {
      volante_dni: string;
      entrega_pendiente: { a_dni: string; medidor: string } | null;
      turnos: { conductor_dni: string; medidor_inicio: string; medidor_fin: string | null }[];
    };

  it("entregar el mando: sigue al volante quien entregó hasta que el otro acepta", async () => {
    const { titular, relevo, id } = await enCurso();
    const e = await marcar(titular.agente, id, "mando/entregar", {
      medidor: 150,
      lugar: "Grifo X",
    });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body.entrega_pendiente).toMatchObject({ a_dni: relevo.dni });
    expect(e.body.volante_dni).toBe(titular.dni);
    // El relevo todavía no maneja; el titular sí.
    expect((await marcar(relevo.agente, id, "llegada-mia", { medidor: 160 })).status).toBe(409);

    const a = await marcar(relevo.agente, id, "mando/aceptar", {});
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const v = await viajeDe(relevo.agente, id);
    expect(v.volante_dni).toBe(relevo.dni);
    expect(v.entrega_pendiente).toBeNull();
    expect(v.turnos).toHaveLength(2);
    expect(Number(v.turnos[0].medidor_fin)).toBe(150);
    expect(Number(v.turnos[1].medidor_inicio)).toBe(150);
    // Ahora el titular es quien espera.
    expect((await marcar(titular.agente, id, "llegada-mia", { medidor: 160 })).status).toBe(409);
    expect((await marcar(relevo.agente, id, "llegada-mia", { medidor: 160 })).status).toBe(200);
  });

  it("la entrega valida quién, cuándo y con qué medidor", async () => {
    const { titular, relevo, id } = await enCurso();
    const entregar = (a: Agente, body: object) => marcar(a, id, "mando/entregar", body);
    expect((await entregar(relevo.agente, { medidor: 150 })).status).toBe(409); // no maneja
    expect((await entregar(titular.agente, {})).status).toBe(400); // falta el medidor
    expect((await entregar(titular.agente, { medidor: 50 })).status).toBe(400); // menor al del viaje
    expect((await marcar(titular.agente, id, "mando/aceptar", {})).status).toBe(409); // sin entrega
    expect((await entregar(titular.agente, { medidor: 150 })).status).toBe(200);
    expect((await entregar(titular.agente, { medidor: 151 })).status).toBe(409); // ya hay una
    expect((await marcar(titular.agente, id, "mando/aceptar", {})).status).toBe(409); // no es para él
    expect((await marcar(relevo.agente, id, "mando/retirar", {})).status).toBe(409); // no la hizo él
    const r = await marcar(titular.agente, id, "mando/retirar", {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.entrega_pendiente).toBeNull();
    expect((await viajeDe(titular.agente, id)).volante_dni).toBe(titular.dni);
  });

  it("el mismo envío de la cola no entrega ni acepta dos veces; con descanso abierto no se recibe", async () => {
    const { titular, relevo, id } = await enCurso();
    const uuid = crypto.randomUUID();
    expect(
      (await marcar(titular.agente, id, "mando/entregar", { medidor: 150, cliente_uuid: uuid }))
        .status
    ).toBe(200);
    expect(
      (await marcar(titular.agente, id, "mando/entregar", { medidor: 150, cliente_uuid: uuid }))
        .status
    ).toBe(200);
    expect((await marcar(relevo.agente, id, "descanso-mio", {})).status).toBe(200);
    expect((await marcar(relevo.agente, id, "mando/aceptar", {})).status).toBe(409);
    expect((await marcar(relevo.agente, id, "descanso-mio/terminar", {})).status).toBe(200);
    const au = crypto.randomUUID();
    expect((await marcar(relevo.agente, id, "mando/aceptar", { cliente_uuid: au })).status).toBe(
      200
    );
    expect((await marcar(relevo.agente, id, "mando/aceptar", { cliente_uuid: au })).status).toBe(
      200
    );
    expect((await viajeDe(relevo.agente, id)).turnos).toHaveLength(2);
  });
});
