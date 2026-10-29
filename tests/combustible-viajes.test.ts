/**tests/combustible-viajes.test.ts
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
import { fijarCuotaTenant, RECURSO_USUARIOS } from "../src/server/services/platformCuotas.service";

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
    // Cada test crea sus conductores: el archivo pasa del tope de 100 usuarios del plan por defecto.
    await fijarCuotaTenant(creado.tenant.id, RECURSO_USUARIOS, 1000, "test");
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

  it("la compra en ruta de combustible cuenta tal cual (20 gal = 20 gal), sin tratarla como litros; urea y tanque en litros no cambian", async () => {
    const grifoRuta = (
      await admin.post("/api/erp/combustible/grifos").send({
        nombre: idUnico("GRIFO"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
    const tqL = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TL"),
      tanque_nombre: "Tanque en litros",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 10000,
      nivel_actual: 9000,
      requiere_documento: false,
    });
    expect(tqL.status, JSON.stringify(tqL.body)).toBe(201);

    // Lugares propios: el promedio de la ruta no se mezcla con los demás tests.
    const origen = await lugar(idUnico("OrigenGal"));
    const destino = await lugar(idUnico("DestinoGal"));
    const yo = await conductor();
    const eq = await unidad();
    const v = await viaje(eq, {
      origen_id: origen,
      destino_id: destino,
      conductor_dni: yo.dni,
      fin_en: hora(8),
      medidor_inicio: 1000,
      medidor_fin: 1400,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);

    // Por la ruta real del conductor: 20 gal de diésel y 2 bolsas de urea (8 L) en la boleta.
    const compra = await admin.post("/api/erp/combustible/compras-ruta").send({
      cliente_uuid: crypto.randomUUID(),
      grifo_id: grifoRuta,
      comprobante_tipo: "boleta",
      comprobante_numero: idUnico("B"),
      equipo_id: eq,
      despachado_en: hora(3),
      combustible: {
        tipo_combustible: "diesel_b5",
        cantidad: 20,
        costo_unitario: 17.5,
        lectura_odometro: 1100,
        horas_abastecidas: 5,
      },
      urea: { lineas: [{ presentacion: "bolsa", cantidad_bultos: 2, costo_unitario: 30 }] },
    });
    expect(compra.status, JSON.stringify(compra.body)).toBe(201);
    const enLitros = await admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tqL.body.id,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: eq,
      serie_talonario: serieUnica(),
      n_vale: 1,
      cantidad: 3.785,
      lectura_contometro: 3.785,
      costo_unitario: 4.4,
      despachado_en: hora(4),
    });
    expect(enLitros.status, JSON.stringify(enLitros.body)).toBe(201);

    // 20 gal de la compra + 3.785 L (= 1 gal) del tanque en litros.
    const fila = (await consumo(eq)).body.data[0];
    expect(Number(fila.cantidad)).toBeCloseTo(21, 2);

    const det = await admin.get(`/api/erp/combustible/viajes/${v.body.id}`);
    const c = det.body.cargas.find(
      (x: { producto: string; origen: string }) =>
        x.producto === "combustible" && x.origen === "compra_externa"
    );
    expect(c.unidad).toBe("gal");
    expect(Number(c.cantidad)).toBe(20);
    const urea = det.body.cargas.find((x: { producto: string }) => x.producto === "urea");
    expect(urea.unidad).toBe("L");
    const suma = (campo: "combustible_gal" | "urea_l") =>
      det.body.tramos.reduce((a: number, t: Record<string, number>) => a + Number(t[campo]), 0);
    expect(suma("combustible_gal")).toBeCloseTo(21, 2);
    expect(suma("urea_l")).toBeCloseTo(8, 2);

    // "Mi viaje" del conductor: su último viaje cerrado trae lo mismo.
    const mios = await yo.agente.get("/api/erp/combustible/viajes/mios");
    expect(mios.status).toBe(200);
    expect(Number(mios.body.data[0].combustible_gal)).toBeCloseTo(21, 2);
    expect(Number(mios.body.data[0].urea_l)).toBeCloseTo(8, 2);

    // El promedio de la ruta, visto desde otro viaje de la misma ruta.
    const otra = await viaje(await unidad(), {
      origen_id: origen,
      destino_id: destino,
      inicio_en: hora(20),
    });
    expect(otra.status, JSON.stringify(otra.body)).toBe(201);
    const det2 = await admin.get(`/api/erp/combustible/viajes/${otra.body.id}`);
    expect(Number(det2.body.ruta.combustible_gal)).toBeCloseTo(21, 2);
    expect(Number(det2.body.ruta.urea_l)).toBeCloseTo(8, 2);
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
      (
        await marcar(yo.agente, v.id, "iniciar-mio", {
          medidor_inicio: 1,
          marcado_en: hace(-60),
          cliente_uuid: crypto.randomUUID(),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await marcar(yo.agente, v.id, "iniciar-mio", {
          medidor_inicio: 1,
          marcado_en: hace(8 * 24 * 60),
          cliente_uuid: crypto.randomUUID(),
        })
      ).status
    ).toBe(400);

    // Sin identificador de la cola no hay hora del celular: se rechaza, no se ignora en silencio.
    const sinUuid = await marcar(yo.agente, v.id, "iniciar-mio", {
      medidor_inicio: 1,
      marcado_en: hace(180),
    });
    expect(sinUuid.status).toBe(400);
    expect(sinUuid.body.message).toMatch(/necesita su identificador/);

    const salida = hace(180);
    const ini = await marcar(yo.agente, v.id, "iniciar-mio", {
      medidor_inicio: 1,
      marcado_en: salida,
      cliente_uuid: crypto.randomUUID(),
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
      cliente_uuid: crypto.randomUUID(),
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

  it("el detalle estima cada tramo con la mediana de los viajes del mismo tipo; con poco historial, con todos; sin historial, no estima", async () => {
    const a = await lugar(idUnico("Chota"));
    const b = await lugar(idUnico("Cutervo"));
    const c = await lugar(idUnico("Jaen"));
    const eqHistorial = await unidad();
    // Tres viajes cerrados a→b de 3, 5 y 4 horas (mediana 240 min) y dos de b→c.
    for (const [ini, dur] of [
      [10, 3],
      [20, 5],
      [30, 4],
    ]) {
      const v = await viaje(eqHistorial, {
        origen_id: a,
        destino_id: b,
        inicio_en: hora(ini),
        fin_en: hora(ini + dur),
      });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
    }
    for (const ini of [40, 50]) {
      expect(
        (
          await viaje(eqHistorial, {
            origen_id: b,
            destino_id: c,
            inicio_en: hora(ini),
            fin_en: hora(ini + 2),
          })
        ).status
      ).toBe(201);
    }

    // Un viaje en curso a → b → c con una unidad del mismo tipo.
    const eq = await unidad();
    const enRuta = await viaje(eq, {
      origen_id: a,
      destino_id: b,
      paradas: [a, b, c],
      inicio_en: hora(60),
    });
    expect(enRuta.status, JSON.stringify(enRuta.body)).toBe(201);
    const det = await admin.get(`/api/erp/combustible/viajes/${enRuta.body.id}`);
    const t = det.body.tramos as {
      esperado_min: number | null;
      esperado_viajes: number;
      esperado_base: string | null;
    }[];
    expect(t[0]).toMatchObject({ esperado_min: 240, esperado_viajes: 3, esperado_base: "tipo" });
    // b → c tiene solo 2 viajes: no se estima.
    expect(t[1]).toMatchObject({ esperado_min: null, esperado_viajes: 2, esperado_base: null });

    // Una unidad de otro tipo no tiene historial propio: se estima con todas las unidades.
    const otra = await admin.post("/api/erp/equipos").send({
      placa_codigo: idUnico("CM"),
      tipo: "CAMIONETA",
      tipo_medidor: "odometro",
      conductor_nombre: "Luis Soto",
      conductor_dni: String(40000000 + seq++),
    });
    expect(otra.status, JSON.stringify(otra.body)).toBe(201);
    const enRuta2 = await viaje(Number(otra.body.id), {
      origen_id: a,
      destino_id: b,
      inicio_en: hora(70),
    });
    expect(enRuta2.status, JSON.stringify(enRuta2.body)).toBe(201);
    const det2 = await admin.get(`/api/erp/combustible/viajes/${enRuta2.body.id}`);
    expect(det2.body.tramos[0]).toMatchObject({ esperado_min: 240, esperado_base: "todas" });
  });

  it("la hora programada de salida y la tolerancia: se guardan, valen 10 por defecto y se corrigen con motivo", async () => {
    const eq = await unidad();
    const sinHora = await programar(eq);
    expect(sinHora.status, JSON.stringify(sinHora.body)).toBe(201);
    expect(sinHora.body.salida_programada_en).toBeNull();
    expect(sinHora.body.desfase_tolerancia_min).toBe(10);
    await admin.post(url(sinHora.body.id, "/anular")).send({ motivo: "Prueba" });

    const programada = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const p = await programar(eq, { salida_programada_en: programada, desfase_tolerancia_min: 15 });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(new Date(p.body.salida_programada_en).toISOString()).toBe(programada);
    expect(p.body.desfase_tolerancia_min).toBe(15);

    // Se corrige con motivo; null la borra.
    const nueva = new Date(Date.now() + 3 * 3_600_000).toISOString();
    expect((await admin.put(url(p.body.id)).send({ salida_programada_en: nueva })).status).toBe(
      400
    );
    const ed = await admin
      .put(url(p.body.id))
      .send({ salida_programada_en: nueva, desfase_tolerancia_min: 5, motivo: "Cambió la hora" });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    expect(new Date(ed.body.salida_programada_en).toISOString()).toBe(nueva);
    expect(ed.body.desfase_tolerancia_min).toBe(5);
    const sin = await admin
      .put(url(p.body.id))
      .send({ salida_programada_en: null, motivo: "Sin hora fija" });
    expect(sin.body.salida_programada_en).toBeNull();
    expect(sin.body.desfase_tolerancia_min).toBe(5); // lo que no se manda no cambia
  });

  it("la hora programada y la tolerancia se validan: rango, retroactivo y números", async () => {
    const eq = await unidad();
    const dias = (n: number) => new Date(Date.now() + n * 864e5).toISOString();
    for (const extra of [
      { salida_programada_en: dias(-8) }, // más de una semana atrás
      { salida_programada_en: dias(400) }, // más de un año adelante
      { salida_programada_en: "9999-12-31T00:00:00Z" }, // fecha extrema: 400, no 500
      { salida_programada_en: "2026-11-05T10:00:00+99:00" }, // desfase de zona imposible
      { salida_programada_en: "no es una fecha" },
      { desfase_tolerancia_min: -1 },
      { desfase_tolerancia_min: 241 },
      { desfase_tolerancia_min: 1.5 },
      // un viaje ya hecho no tiene hora "programada"
      { salida_programada_en: dias(0), inicio_en: hora(1), fin_en: hora(2) },
      { desfase_tolerancia_min: 5, inicio_en: hora(1), fin_en: hora(2) },
    ]) {
      const r = await programar(eq, extra);
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    // Un desfase de zona que Postgres no admite (+23:59) se guarda ya convertido a UTC: ni 500 ni 400.
    const dist = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 19);
    const zona = await programar(await unidad(), { salida_programada_en: `${dist}+23:59` });
    expect(zona.status, JSON.stringify(zona.body)).toBe(201);
    expect(new Date(zona.body.salida_programada_en).toISOString()).toBe(
      new Date(`${dist}+23:59`).toISOString()
    );

    const p = await programar(eq);
    expect(
      (
        await admin
          .put(url(p.body.id))
          .send({ salida_programada_en: "9999-12-31T00:00:00Z", motivo: "Prueba" })
      ).status
    ).toBe(400);

    // Con el viaje en curso el encargado sí puede corregirlas; cerrado no (borraría el retraso).
    // Reenviar el mismo valor guardado sí pasa (un formulario que reenvía todo).
    const enCurso = (await viaje(await unidad(), { inicio_en: hora(5) })).body;
    expect(enCurso.estado).toBe("en_curso");
    const corregida = await admin.put(url(enCurso.id)).send({
      salida_programada_en: dias(0),
      desfase_tolerancia_min: 20,
      motivo: "Estaba mal la hora",
    });
    expect(corregida.status, JSON.stringify(corregida.body)).toBe(200);
    expect(corregida.body.desfase_tolerancia_min).toBe(20);
    const hecho = (await viaje(await unidad(), { inicio_en: hora(3), fin_en: hora(4) })).body;
    const nueva = await admin
      .put(url(hecho.id))
      .send({ salida_programada_en: dias(0), motivo: "Quito el retraso" });
    expect(nueva.status).toBe(400);
    expect(nueva.body.message ?? nueva.body.error).toMatch(/ya terminado/);
    expect(
      (
        await admin
          .put(url(hecho.id))
          .send({ desfase_tolerancia_min: 30, motivo: "Subo la tolerancia" })
      ).status
    ).toBe(400);
    expect(
      (
        await admin.put(url(hecho.id)).send({
          desfase_tolerancia_min: 10,
          observaciones: "Sin cambio",
          motivo: "Reenvío igual",
        })
      ).status
    ).toBe(200);
  });

  {
    /**HEAD */
  }
  it("desfase_salida_min: minutos que salió después (+) o antes (-) de la hora programada; null sin hora", async () => {
    const salir = async (programadaEn: string | null) => {
      const yo = await conductor();
      const eq = await unidad();
      const v = await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        origen_id: huamachuco,
        destino_id: bambamarca,
        conductor_dni: yo.dni,
        ...(programadaEn ? { salida_programada_en: programadaEn } : {}),
      });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      // Antes de salir no hay desfase.
      expect((await admin.get(url(v.body.id))).body.viaje.desfase_salida_min).toBeNull();
      const ini = await marcar(yo.agente, v.body.id, "iniciar-mio", { medidor_inicio: 100 });
      expect(ini.status, JSON.stringify(ini.body)).toBe(200);
      return (await admin.get(url(v.body.id))).body.viaje.desfase_salida_min as number | null;
    };
    const min = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
    expect(await salir(min(-12))).toBe(12); // la hora era hace 12 min: salió 12 min tarde
    expect(await salir(min(30))).toBe(-30); // la hora es en 30 min: salió 30 min antes
    expect(await salir(null)).toBeNull();
  });

  // ── Cola del conductor ────────────────────────────────────────────────────

  /** Programa un viaje para ese conductor, en una unidad propia (una unidad no tiene dos viajes
   *  sin cerrar). */
  const programarPara = async (dni: string, extra: Record<string, unknown> = {}) => {
    const r = await programar(await unidad(), { conductor_dni: dni, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: Number(r.body.id), numero: r.body.numero as number };
  };
  const enMin = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

  it("la cola del conductor va por hora programada (sin hora, al final) y solo inicia el primero", async () => {
    const yo = await conductor();
    const sinHora = await programarPara(yo.dni);
    const tarde = await programarPara(yo.dni, { salida_programada_en: enMin(120) });
    const primero = await programarPara(yo.dni, { salida_programada_en: enMin(60) });

    const mios = (await yo.agente.get("/api/erp/combustible/viajes/mios")).body.data as {
      id: string;
      estado: string;
      cola_posicion: number | null;
    }[];
    expect(mios.map((m) => [Number(m.id), m.cola_posicion])).toEqual([
      [primero.id, 1],
      [tarde.id, 2],
      [sinHora.id, 3],
    ]);

    // Los de atrás se rechazan y dicen cuál va primero; el primero sale.
    for (const x of [tarde, sinHora]) {
      const r = await marcar(yo.agente, x.id, "iniciar-mio", { medidor_inicio: 100 });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.message ?? r.body.error).toContain(`V-${primero.numero}`);
    }
    expect(
      (await marcar(yo.agente, primero.id, "iniciar-mio", { medidor_inicio: 100 })).status
    ).toBe(200);

    // Ya en curso el primero, los demás suben en la cola.
    const despues = (await yo.agente.get("/api/erp/combustible/viajes/mios")).body.data as {
      id: string;
      cola_posicion: number | null;
    }[];
    expect(
      despues.filter((m) => m.cola_posicion !== null).map((m) => [Number(m.id), m.cola_posicion])
    ).toEqual([
      [tarde.id, 1],
      [sinHora.id, 2],
    ]);
  });

  it("dos inicios a la vez del mismo conductor: uno sale, el otro se rechaza y no se salta la cola", async () => {
    const yo = await conductor();
    const primero = await programarPara(yo.dni, { salida_programada_en: enMin(60) });
    const segundo = await programarPara(yo.dni, { salida_programada_en: enMin(120) });
    const [a, b] = await Promise.all([
      marcar(yo.agente, segundo.id, "iniciar-mio", { medidor_inicio: 100 }),
      marcar(yo.agente, primero.id, "iniciar-mio", { medidor_inicio: 100 }),
    ]);
    // El segundo nunca sale solo: o pierde por la cola o por ir ya al volante del primero.
    expect(a.status, JSON.stringify(a.body)).toBe(409);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
  });

  it("la oficina cambia la unidad de un viaje (a una de id mayor o menor) mientras dos conductores inician: nunca quedan dos viajes iniciados en la misma unidad", async () => {
    // El candado de la unidad se toma sobre la unidad que el viaje tenía al leerlo. Si la oficina lo
    // mueve a otra unidad mientras el conductor espera, el conductor trabaja sobre la nueva con el
    // candado de la vieja: el choque se ve contra el viaje de quien espera en la nueva.
    for (let i = 0; i < 16; i++) {
      const c1 = await conductor();
      const c2 = await conductor();
      const primera = await unidad();
      const segunda = await unidad();
      // Vueltas pares: el viaje 1 pasa a la unidad de id mayor; impares: a la de id menor.
      const [unidadA, unidadB] = i % 2 === 0 ? [primera, segunda] : [segunda, primera];
      const v1 = await programar(unidadA, { conductor_dni: c1.dni });
      const v2 = await programar(unidadB, { conductor_dni: c2.dni });
      expect(v1.status, JSON.stringify(v1.body)).toBe(201);
      expect(v2.status, JSON.stringify(v2.body)).toBe(201);

      const [edicion, ini1, ini2] = await Promise.all([
        admin.put(url(v1.body.id)).send({ equipo_id: unidadB, motivo: "se cambia la unidad" }),
        marcar(c1.agente, v1.body.id, "iniciar-mio", { medidor_inicio: 100 }),
        marcar(c2.agente, v2.body.id, "iniciar-mio", { medidor_inicio: 100 }),
      ]);

      // Ninguna respuesta es un 500: cada una gana o se rechaza con un motivo.
      for (const r of [edicion, ini1, ini2]) {
        expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
      }
      // Cambiar de unidad no es un rechazo que la cola offline descartaría como definitivo.
      for (const r of [ini1, ini2]) {
        expect(JSON.stringify(r.body)).not.toContain("cambió de unidad");
      }
      // Estado final: a lo sumo un viaje iniciado por unidad, y los dos viajes en unidades distintas
      // si la edición no se aplicó.
      const f1 = (await admin.get(url(v1.body.id))).body;
      const f2 = (await admin.get(url(v2.body.id))).body;
      const iniciados = [f1, f2].filter((v) => v.inicio_en);
      const porUnidad = new Map<number, number>();
      for (const v of iniciados) {
        porUnidad.set(Number(v.equipo_id), (porUnidad.get(Number(v.equipo_id)) ?? 0) + 1);
      }
      expect(
        [...porUnidad.values()].every((n) => n === 1),
        `vuelta ${i}: edición ${edicion.status}, inicios ${ini1.status}/${ini2.status}, ` +
          `viaje 1 en ${f1.equipo_id} (inicio ${f1.inicio_en}), viaje 2 en ${f2.equipo_id} (inicio ${f2.inicio_en})`
      ).toBe(true);
    }
  }, 90_000);

  it("anular el primero adelanta al segundo; una marca que esperó sin señal no se rechaza por la cola", async () => {
    const yo = await conductor();
    const primero = await programarPara(yo.dni, { salida_programada_en: enMin(60) });
    const segundo = await programarPara(yo.dni, { salida_programada_en: enMin(120) });
    const tercero = await programarPara(yo.dni, { salida_programada_en: enMin(180) });

    // Sin señal el conductor inició el tercero hace 10 min: ya pasó, la cola no lo descarta.
    const hace10 = new Date(Date.now() - 10 * 60_000).toISOString();
    const tarde = await marcar(yo.agente, tercero.id, "iniciar-mio", {
      medidor_inicio: 100,
      marcado_en: hace10,
      cliente_uuid: crypto.randomUUID(),
    });
    expect(tarde.status, JSON.stringify(tarde.body)).toBe(200);
    expect(tarde.body.inicio_origen_hora).toBe("dispositivo");

    // Con la oficina anulando el primero, el segundo queda primero de la cola.
    expect(
      (await admin.post(url(primero.id, "/anular")).send({ motivo: "Se canceló" })).status
    ).toBe(200);
    const mios = (await yo.agente.get("/api/erp/combustible/viajes/mios")).body.data as {
      id: string;
      cola_posicion: number | null;
    }[];
    expect(mios.find((m) => Number(m.id) === segundo.id)?.cola_posicion).toBe(1);
  });

  it("la oficina puede iniciar un viaje que no es el primero de la cola; el relevo no cuenta en la cola de quien no sale", async () => {
    const yo = await conductor();
    const primero = await programarPara(yo.dni, { salida_programada_en: enMin(60) });
    const segundo = await programarPara(yo.dni, { salida_programada_en: enMin(120) });
    const oficina = await admin.post(url(segundo.id, "/iniciar")).send({ medidor_inicio: 100 });
    expect(oficina.status, JSON.stringify(oficina.body)).toBe(200);
    expect(primero.id).not.toBe(segundo.id);

    // Un viaje donde es relevo y sale el titular no está en su cola.
    const otro = await conductor();
    const eq = await unidad();
    const conRelevo = await programar(eq, { conductor_dni: otro.dni, relevo_dni: yo.dni });
    expect(conRelevo.status, JSON.stringify(conRelevo.body)).toBe(201);
    const mios = (await yo.agente.get("/api/erp/combustible/viajes/mios")).body.data as {
      id: string;
      estado: string;
      cola_posicion: number | null;
    }[];
    const comoRelevo = mios.find((m) => Number(m.id) === Number(conRelevo.body.id));
    expect(comoRelevo?.cola_posicion).toBeNull();
  });

  // ── Resumen por conductor ─────────────────────────────────────────────────

  const resumenDe = async (desde: string, hasta: string) =>
    (await admin.get("/api/erp/combustible/viajes/resumen-conductores").query({ desde, hasta }))
      .body.data as {
      dni: string;
      nombre: string;
      viajes: number;
      km: number;
      minutos_al_volante: number;
      salidas_medidas: number;
      salidas_puntuales: number;
      consumo_viajes: number;
      consumo_desvio_pct: number | null;
    }[];

  it("el resumen por conductor suma sus viajes, kilómetros y horas al volante del período", async () => {
    const eq = await unidad();
    const dni = String(41500000 + seq++); // el conductor de sus dos viajes
    // Una ruta propia: sin historial de otros viajes con qué comparar el consumo.
    const a = await lugar(idUnico("Sorochuco"));
    const b = await lugar(idUnico("Huasmin"));
    // Dos viajes cerrados: 150 km en 4 h y 100 km en 4 h (turnos de la unidad).
    for (const [ini, med0, med1] of [
      [600, 100, 250],
      [610, 250, 350],
    ]) {
      const v = await viaje(eq, {
        conductor_dni: dni,
        origen_id: a,
        destino_id: b,
        inicio_en: hora(ini),
        fin_en: hora(ini + 4),
        medidor_inicio: med0,
        medidor_fin: med1,
      });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
    }
    const r = (await resumenDe(hora(599), hora(620))).find((x) => x.dni === dni);
    expect(r).toMatchObject({ viajes: 2, km: 250, minutos_al_volante: 480 });
    // Sin hora programada no hay puntualidad que medir, ni historial para comparar el consumo.
    expect(r).toMatchObject({ salidas_medidas: 0, consumo_viajes: 0, consumo_desvio_pct: null });
    // Fuera del período no aparece.
    expect((await resumenDe(hora(700), hora(720))).find((x) => x.dni === dni)).toBeUndefined();
  });

  it("el resumen compara el consumo de cada conductor con el promedio de su ruta", async () => {
    const a = await lugar(idUnico("Pomabamba"));
    const b = await lugar(idUnico("Piscobamba"));
    // Tres viajes cerrados en la misma ruta, de tres conductores y tres unidades: 30, 30 y 60 gal
    // (promedio 40): los dos primeros gastan 25 % menos y el tercero 50 % más.
    const gastos: { dni: string; gal: number; ini: number }[] = [
      { dni: String(41600000 + seq++), gal: 30, ini: 120 },
      { dni: String(41600000 + seq++), gal: 30, ini: 140 },
      { dni: String(41600000 + seq++), gal: 60, ini: 160 },
    ];
    for (const g of gastos) {
      const eq = await unidad();
      const v = await viaje(eq, {
        conductor_dni: g.dni,
        origen_id: a,
        destino_id: b,
        inicio_en: hora(g.ini),
        fin_en: hora(g.ini + 4),
        medidor_inicio: 100,
        medidor_fin: 300,
      });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      expect((await cargar(eq, g.gal, g.ini + 1)).status).toBe(201);
    }
    const filas = await resumenDe(hora(119), hora(170));
    const de = (dni: string) => filas.find((x) => x.dni === dni);
    expect(de(gastos[0].dni)).toMatchObject({ consumo_viajes: 1, consumo_desvio_pct: -25 });
    expect(de(gastos[1].dni)).toMatchObject({ consumo_viajes: 1, consumo_desvio_pct: -25 });
    expect(de(gastos[2].dni)).toMatchObject({ consumo_viajes: 1, consumo_desvio_pct: 50 });
    // El promedio de la ruta no depende del período que se mira: con solo el tercer viaje a la vista
    // el desvío sigue siendo +50 % (antes se comparaba consigo mismo y no salía).
    const solo = await resumenDe(hora(159), hora(170));
    expect(solo.find((x) => x.dni === gastos[2].dni)).toMatchObject({
      consumo_viajes: 1,
      consumo_desvio_pct: 50,
    });
  });

  it("las horas al volante del resumen no cuentan lo que la unidad estuvo detenida", async () => {
    const eq = await unidad();
    const dni = String(41700000 + seq++);
    const v = await viaje(eq, {
      conductor_dni: dni,
      inicio_en: hora(150),
      medidor_inicio: 100,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const id = v.body.id;
    // 4 h de viaje, 2 h de ellas detenido por una avería: 120 min al volante.
    const av = await admin
      .post(url(id, "/descanso"))
      .send({ motivo: "Avería", inicio_en: hora(151) });
    expect(av.status, JSON.stringify(av.body)).toBe(200);
    const te = await admin
      .post(url(id, "/descanso/terminar"))
      .send({ fin_en: hora(153), motivo: "Prueba" });
    expect(te.status, JSON.stringify(te.body)).toBe(200);
    const ci = await admin
      .post(url(id, "/cerrar"))
      .send({ fin_en: hora(154), medidor_fin: 200, motivo: "Prueba" });
    expect(ci.status, JSON.stringify(ci.body)).toBe(200);
    const r = (await resumenDe(hora(149), hora(160))).find((x) => x.dni === dni);
    expect(r).toMatchObject({ viajes: 1, km: 100, minutos_al_volante: 120 });
  });

  it("el resumen cuenta la puntualidad de los viajes que el conductor inició (a tiempo o antes)", async () => {
    const cerrado = async (programadaEn: string) => {
      const yo = await conductor();
      const eq = await unidad();
      const v = await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        origen_id: huamachuco,
        destino_id: bambamarca,
        conductor_dni: yo.dni,
        salida_programada_en: programadaEn,
      });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      expect(
        (await marcar(yo.agente, v.body.id, "iniciar-mio", { medidor_inicio: 100 })).status
      ).toBe(200);
      expect((await marcar(yo.agente, v.body.id, "cerrar-mio", { medidor_fin: 200 })).status).toBe(
        200
      );
      return yo.dni;
    };
    const min = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
    const tarde = await cerrado(min(-30)); // salió 30 min tarde: pasa la tolerancia de 10
    const puntual = await cerrado(min(-3)); // 3 min tarde: dentro de la tolerancia
    const antes = await cerrado(min(40)); // salió 40 min antes: no es tarde
    const filas = await resumenDe(min(-120), min(120));
    const de = (dni: string) => filas.find((x) => x.dni === dni);
    expect(de(tarde)).toMatchObject({
      viajes: 1,
      km: 100,
      salidas_medidas: 1,
      salidas_puntuales: 0,
    });
    expect(de(puntual)).toMatchObject({ salidas_medidas: 1, salidas_puntuales: 1 });
    expect(de(antes)).toMatchObject({ salidas_medidas: 1, salidas_puntuales: 1 });
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

  it("un medidor absurdo se rechaza en el servidor; uno tipeado mal pero posible lo corrige la oficina", async () => {
    const { yo, id } = await circuitoEnCurso();
    // 999999 es absurdo: el servidor lo ataja (antes lo aceptaba y el viaje quedaba sin salida).
    expect((await marcar(yo.agente, id, "llegada-mia", { medidor: 999999, orden: 1 })).status).toBe(
      400
    );
    // 1600 en vez de 160 es posible: entra. Pero la llegada final (200) ya no cabe.
    expect((await marcar(yo.agente, id, "llegada-mia", { medidor: 1600, orden: 1 })).status).toBe(
      200
    );
    expect((await marcar(yo.agente, id, "salida-mia", { medidor: 1600, orden: 1 })).status).toBe(
      200
    );
    expect((await marcar(yo.agente, id, "llegada-mia", { medidor: 200, orden: 2 })).status).toBe(
      400
    );

    const corregir = (orden: number, cuerpo: Record<string, unknown>, agente = admin) =>
      agente.post(url(id, `/paradas/${orden}/corregir`)).send(cuerpo);
    // Sin motivo, sin nada que corregir, o por quien no es de la oficina: no.
    expect((await corregir(1, { que: "llegada", medidor: 160 })).status).toBe(400);
    expect((await corregir(1, { que: "llegada", motivo: "Mal tipeado" })).status).toBe(400);
    expect(
      (await corregir(1, { que: "llegada", medidor: 160, motivo: "Mal tipeado" }, yo.agente)).status
    ).toBe(403);
    // La salida de la parada 1 sigue en 1600: la llegada no puede pasarla, ni bajar del km 100.
    expect((await corregir(1, { que: "llegada", medidor: 1700, motivo: "Prueba" })).status).toBe(
      400
    );
    expect((await corregir(1, { que: "llegada", medidor: 90, motivo: "Prueba" })).status).toBe(400);
    // Las marcas de los extremos se corrigen editando el viaje, no por aquí.
    expect((await corregir(0, { que: "salida", medidor: 100, motivo: "Prueba" })).status).toBe(400);
    expect((await corregir(2, { que: "llegada", medidor: 200, motivo: "Prueba" })).status).toBe(
      400
    );

    // Corregir las dos marcas mal tipeadas: primero la salida (el techo de la llegada).
    const sal = await corregir(1, { que: "salida", medidor: 160, motivo: "Mal tipeado" });
    expect(sal.status, JSON.stringify(sal.body)).toBe(400); // 160 < llegada 1600
    expect(
      (await corregir(1, { que: "llegada", medidor: 160, motivo: "Mal tipeado" })).status
    ).toBe(200);
    expect((await corregir(1, { que: "salida", medidor: 160, motivo: "Mal tipeado" })).status).toBe(
      200
    );
    const b = (await paradasDe(id))[1];
    expect(Number(b.llegada_medidor)).toBe(160);
    expect(Number(b.salida_medidor)).toBe(160);
    // Y ahora el viaje sigue: la llegada final en 200 cierra.
    const fin = await marcar(yo.agente, id, "llegada-mia", { medidor: 200, orden: 2 });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.estado).toBe("cerrado");
  });

  it("la hora de una marca intermedia se corrige entre la anterior y la siguiente, nunca en el futuro", async () => {
    const { yo, id } = await circuitoEnCurso();
    expect((await marcar(yo.agente, id, "llegada-mia", { medidor: 150, orden: 1 })).status).toBe(
      200
    );
    const corregir = (cuerpo: Record<string, unknown>) =>
      admin
        .post(url(id, "/paradas/1/corregir"))
        .send({ que: "llegada", motivo: "Prueba", ...cuerpo });
    // Antes de la salida del origen, o en el futuro: no.
    expect((await corregir({ hora: hora(100_000) })).status).toBe(400);
    expect((await corregir({ hora: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(
      400
    );
    // Hora igual o posterior a la siguiente marca: no (aquí no hay siguiente; la salida de B la crea).
    expect((await corregir({ hora: hora(-100_000) })).status).toBe(400);
    // Una marca que no existe todavía (la salida de la parada 1) no se inventa por aquí.
    expect(
      (
        await admin
          .post(url(id, "/paradas/1/corregir"))
          .send({ que: "salida", hora: new Date().toISOString(), motivo: "Prueba" })
      ).status
    ).toBe(409);
    // Una hora válida (justo después de la salida del origen) entra y queda como la nueva.
    const nueva = new Date(Date.parse((await paradasDe(id))[0].salida_en!) + 1).toISOString();
    const ok = await corregir({ hora: nueva });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(new Date((await paradasDe(id))[1].llegada_en!).toISOString()).toBe(nueva);
    // Con la salida ya marcada, la llegada no puede alcanzar ni pasar a la salida.
    expect((await marcar(yo.agente, id, "salida-mia", { medidor: 150, orden: 1 })).status).toBe(
      200
    );
    const salida = (await paradasDe(id))[1].salida_en!;
    const tope = await corregir({ hora: salida });
    expect(tope.status, JSON.stringify(tope.body)).toBe(400);
    expect(tope.body.message).toMatch(/anterior a la marca siguiente/);
    // Solo el medidor (sin tocar la hora) también se puede corregir.
    const sinHora = await corregir({ medidor: 145 });
    expect(sinHora.status, JSON.stringify(sinHora.body)).toBe(200);
    expect(Number((await paradasDe(id))[1].llegada_medidor)).toBe(145);
  });

  it("iniciar o cerrar con una hora manual futura se rechaza", async () => {
    const yo = await conductor();
    const eq = await unidad();
    const v = (
      await admin
        .post("/api/erp/combustible/viajes")
        .send({ equipo_id: eq, paradas: [huamachuco, bambamarca], conductor_dni: yo.dni })
    ).body;
    const futuro = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const ini = await admin
      .post(url(v.id, "/iniciar"))
      .send({ medidor_inicio: 100, inicio_en: futuro });
    expect(ini.status, JSON.stringify(ini.body)).toBe(400);
    expect((await admin.post(url(v.id, "/iniciar")).send({ medidor_inicio: 100 })).status).toBe(
      200
    );
    const fin = await admin.post(url(v.id, "/cerrar")).send({ medidor_fin: 150, fin_en: futuro });
    expect(fin.status, JSON.stringify(fin.body)).toBe(400);
  });

  it("una avería marcada sin señal (hora de hace rato) también abre su alerta en el acto", async () => {
    const detenidoDe = async (viajeId: number) =>
      (
        (await admin.get("/api/erp/combustible/alertas").query({ pageSize: 200 })).body.data as {
          tipo: string;
          viaje_id: number | null;
        }[]
      ).filter((a) => a.tipo === "viaje_detenido" && Number(a.viaje_id) === viajeId);

    // El viaje salió hace 2 h (con su hora del celular), así que una avería de hace 30 min cae dentro.
    const sinSenal = { yo: await conductor(), id: 0 };
    const eq = await unidad();
    const salio = (
      await admin.post("/api/erp/combustible/viajes").send({
        equipo_id: eq,
        paradas: [huamachuco, bambamarca, huamachuco],
        conductor_dni: sinSenal.yo.dni,
      })
    ).body;
    sinSenal.id = Number(salio.id);
    const ini = await marcar(sinSenal.yo.agente, sinSenal.id, "iniciar-mio", {
      medidor_inicio: 100,
      marcado_en: hace(120),
      cliente_uuid: crypto.randomUUID(),
    });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    const vieja = await marcar(sinSenal.yo.agente, sinSenal.id, "descanso-mio", {
      motivo: "Avería",
      marcado_en: hace(30),
      cliente_uuid: crypto.randomUUID(),
    });
    expect(vieja.status, JSON.stringify(vieja.body)).toBe(200);
    // La alerta es urgente: no espera a la pasada del worker aunque la marca venga de la cola.
    expect(await detenidoDe(sinSenal.id)).toHaveLength(1);

    const enVivo = await circuitoEnCurso();
    const ahora = await marcar(enVivo.yo.agente, enVivo.id, "descanso-mio", {
      motivo: "Avería",
      cliente_uuid: crypto.randomUUID(),
    });
    expect(ahora.status, JSON.stringify(ahora.body)).toBe(200);
    expect(await detenidoDe(enVivo.id)).toHaveLength(1);
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

  it("cerrar con una hora o un medidor anteriores a un cambio de mando ya marcado da 400, no 500", async () => {
    const { relevo, id } = await conUnSoloTurno(false);
    const cambio = await corregir(id, {
      a_dni: relevo.dni,
      cambio_en: hora(4),
      medidor: 250,
      motivo: "no lo marcaron",
    });
    expect(cambio.status, JSON.stringify(cambio.body)).toBe(200);
    const cerrar = (body: object) =>
      admin.post(`${url(id)}/cerrar`).send({ motivo: "cierre a mano", ...body });
    const temprano = await cerrar({ fin_en: hora(3), medidor_fin: 400 });
    expect(temprano.status).toBe(400);
    expect(JSON.stringify(temprano.body)).toContain("último marcado");
    const bajo = await cerrar({ fin_en: hora(10), medidor_fin: 200 });
    expect(bajo.status).toBe(400);
    expect(JSON.stringify(bajo.body)).toContain("último del viaje");
    expect((await cerrar({ fin_en: hora(10), medidor_fin: 400 })).status).toBe(200);
  });

  it("la llegada final valida el medidor contra la salida de la parada anterior", async () => {
    const { titular, id } = await conUnSoloTurno(false, [huamachuco, bambamarca, huamachuco]);
    expect((await marcar(titular.agente, id, "llegada-mia", { medidor: 150 })).status).toBe(200);
    expect((await marcar(titular.agente, id, "salida-mia", { medidor: 160 })).status).toBe(200);
    const final = (medidor: number) => marcar(titular.agente, id, "llegada-mia", { medidor });
    expect((await final(120)).status).toBe(400); // retrocede respecto a la salida en 160
    expect((await admin.get(url(id))).body.viaje.estado).toBe("en_curso");
    expect((await final(170)).status).toBe(200);
  });

  it("ponerle llegada a un viaje en curso al editarlo cancela la entrega pendiente", async () => {
    const { titular, id } = await enCurso();
    expect((await marcar(titular.agente, id, "mando/entregar", { medidor: 150 })).status).toBe(200);
    const fin = new Date(Date.now() + 60_000).toISOString();
    const r = await admin
      .put(url(id))
      .send({ motivo: "cierro el viaje", fin_en: fin, medidor_fin: 200 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const viaje = (await admin.get(url(id))).body.viaje;
    expect(viaje.estado).toBe("cerrado");
    expect(viaje.entrega_pendiente).toBeNull();
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

  it("la oficina termina el descanso del relevo que no maneja, señalándolo y con motivo", async () => {
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
    const descansoId = (d.body.descansos as { id: number }[])[0].id;
    const terminar = (body: object) => admin.post(url(id, "/descanso/terminar")).send(body);
    // Sin señalarlo, la oficina solo termina el del que maneja: aquí no hay ninguno.
    expect((await terminar({})).status).toBe(409);
    // Señalado, el motivo es obligatorio: queda quién y por qué.
    expect((await terminar({ descanso_id: descansoId })).status).toBe(400);
    // Un descanso que no existe no termina nada.
    expect((await terminar({ descanso_id: descansoId + 9999, motivo: "Sin señal" })).status).toBe(
      409
    );
    const ok = await terminar({ descanso_id: descansoId, motivo: "Sin señal" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const cerrado = (
      ok.body.descansos as { id: number; fin_en: string | null; fin_por: string }[]
    )[0];
    expect(cerrado.fin_en).not.toBeNull();
    expect(cerrado.fin_por).toBe("oficina");
    // Libre otra vez: ya puede recibir el mando.
    expect((await terminar({ descanso_id: descansoId, motivo: "Sin señal" })).status).toBe(409);
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

  // ── Corregir un cambio de mando a posteriori (oficina) ───────────────────

  /** Un viaje con titular y relevo registrado a posteriori: un solo turno, del titular. */
  const conUnSoloTurno = async (cerrado = true, paradas = [huamachuco, bambamarca]) => {
    const titular = await conductor();
    const relevo = await conductor();
    const eq = await unidad();
    const r = await admin.post("/api/erp/combustible/viajes").send({
      equipo_id: eq,
      paradas,
      conductor_dni: titular.dni,
      relevo_dni: relevo.dni,
      inicio_en: hora(0),
      medidor_inicio: 100,
      ...(cerrado ? { fin_en: hora(10), medidor_fin: 400 } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { titular, relevo, id: Number(r.body.id) };
  };
  type TurnoCorregido = {
    conductor_dni: string;
    inicio_en: string;
    fin_en: string | null;
    medidor_inicio: string | null;
    medidor_fin: string | null;
    lugar: string | null;
    corregido: boolean;
    corregido_motivo: string | null;
  };
  const turnosDe = async (id: number) =>
    (await admin.get(url(id))).body.viaje.turnos as TurnoCorregido[];
  const corregir = (id: number, body: object) => admin.post(`${url(id)}/mando/corregir`).send(body);

  it("la oficina corrige un cambio de mando olvidado: parte el turno y deja quién y por qué", async () => {
    const { titular, relevo, id } = await conUnSoloTurno();
    expect(await turnosDe(id)).toHaveLength(1);
    const r = await corregir(id, {
      a_dni: relevo.dni,
      cambio_en: hora(4),
      medidor: 250,
      lugar: "Grifo Y",
      motivo: "no lo marcaron",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [primero, segundo] = await turnosDe(id);
    expect(primero).toMatchObject({ conductor_dni: titular.dni, corregido: false });
    expect(Date.parse(primero.fin_en!)).toBe(Date.parse(hora(4)));
    expect(Number(primero.medidor_inicio)).toBe(100);
    expect(Number(primero.medidor_fin)).toBe(250);
    expect(segundo).toMatchObject({
      conductor_dni: relevo.dni,
      lugar: "Grifo Y",
      corregido: true,
      corregido_motivo: "no lo marcaron",
    });
    // El tramo nuevo conserva el final del turno original (la llegada del viaje).
    expect(Date.parse(segundo.fin_en!)).toBe(Date.parse(hora(10)));
    expect(Number(segundo.medidor_inicio)).toBe(250);
    expect(Number(segundo.medidor_fin)).toBe(400);
  });

  it("con el viaje en curso, la corrección pasa el turno abierto al otro conductor", async () => {
    const { relevo, id } = await conUnSoloTurno(false);
    const r = await corregir(id, {
      a_dni: relevo.dni,
      cambio_en: hora(4),
      medidor: 250,
      motivo: "no lo marcaron",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const turnos = await turnosDe(id);
    expect(turnos).toHaveLength(2);
    expect(turnos[1]).toMatchObject({ conductor_dni: relevo.dni, fin_en: null, corregido: true });
    expect(r.body.volante_dni).toBe(relevo.dni);
  });

  it("la corrección valida hora, persona, medidor, motivo y permisos", async () => {
    const { titular, relevo, id } = await conUnSoloTurno();
    const base = { a_dni: relevo.dni, cambio_en: hora(4), medidor: 250, motivo: "no lo marcaron" };
    expect((await corregir(id, { ...base, cambio_en: hora(-5) })).status).toBe(409); // antes de salir
    expect((await corregir(id, { ...base, cambio_en: hora(11) })).status).toBe(409); // después de llegar
    expect(
      (await corregir(id, { ...base, cambio_en: new Date(Date.now() + H).toISOString() })).status
    ).toBe(400); // futuro
    expect((await corregir(id, { ...base, a_dni: titular.dni })).status).toBe(409); // ya manejaba
    expect((await corregir(id, { ...base, a_dni: "99999999" })).status).toBe(400); // ajeno al viaje
    expect((await corregir(id, { ...base, motivo: "" })).status).toBe(400);
    expect((await corregir(id, { ...base, medidor: undefined })).status).toBe(400); // falta
    expect((await corregir(id, { ...base, medidor: 500 })).status).toBe(400); // fuera del turno
    expect((await titular.agente.post(`${url(id)}/mando/corregir`).send(base)).status).toBe(403);
    expect(await turnosDe(id)).toHaveLength(1); // nada de lo rechazado dejó huella

    expect((await corregir(id, base)).status).toBe(200);
    // Partir el primer tramo para dárselo al relevo choca con su turno siguiente.
    expect((await corregir(id, { ...base, cambio_en: hora(2), medidor: 150 })).status).toBe(409);
    // El relevo devuelve el volante al titular a mitad de su turno: tres tramos.
    const vuelta = await corregir(id, {
      a_dni: titular.dni,
      cambio_en: hora(7),
      medidor: 320,
      motivo: "volvió el titular",
    });
    expect(vuelta.status, JSON.stringify(vuelta.body)).toBe(200);
    expect(await turnosDe(id)).toHaveLength(3);
  });

  it("sin relevo, o con una entrega pendiente, no se corrige el mando", async () => {
    const solo = (await viaje(await unidad(), { inicio_en: hora(0), fin_en: hora(10) })).body;
    const sinRelevo = await corregir(solo.id, {
      a_dni: "12345678",
      cambio_en: hora(4),
      motivo: "no lo marcaron",
    });
    expect(sinRelevo.status).toBe(409);

    const { titular, relevo, id } = await enCurso();
    expect((await marcar(titular.agente, id, "mando/entregar", { medidor: 150 })).status).toBe(200);
    const pendiente = await corregir(id, {
      a_dni: relevo.dni,
      cambio_en: new Date(Date.now() - 1000).toISOString(),
      medidor: 150,
      motivo: "no lo marcaron",
    });
    expect(pendiente.status).toBe(409);
    expect(JSON.stringify(pendiente.body)).toContain("entrega pendiente");
  });

  // ── Auditoría de Viajes: reglas cruzadas e idempotencia ──────────────────

  it("cambiar el titular de un viaje en curso no lo pone al volante de dos viajes", async () => {
    const a = await enCurso();
    const b = await enCurso();
    const choque = await admin
      .put(url(b.id))
      .send({ motivo: "cambio de titular", conductor_dni: a.titular.dni });
    expect(choque.status).toBe(409);
    expect(JSON.stringify(choque.body)).toContain("al volante");
    expect((await viajeDe(b.titular.agente, b.id)).volante_dni).toBe(b.titular.dni);

    // A una persona libre sí: su turno pasa a ella.
    const libre = await conductor();
    const ok = await admin
      .put(url(b.id))
      .send({ motivo: "cambio de titular", conductor_dni: libre.dni });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await turnosDe(b.id))[0].conductor_dni).toBe(libre.dni);
  });

  it("con una entrega pendiente no se cambia el titular", async () => {
    const { titular, id } = await enCurso();
    expect((await marcar(titular.agente, id, "mando/entregar", { medidor: 150 })).status).toBe(200);
    const libre = await conductor();
    const r = await admin
      .put(url(id))
      .send({ motivo: "cambio de titular", conductor_dni: libre.dni });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("entrega pendiente");
    expect((await marcar(titular.agente, id, "mando/retirar", {})).status).toBe(200);
    expect(
      (await admin.put(url(id)).send({ motivo: "cambio de titular", conductor_dni: libre.dni }))
        .status
    ).toBe(200);
  });

  it("corregir el mando no deja un medidor que contradiga una parada ya marcada", async () => {
    const { titular, relevo, id } = await conUnSoloTurno(false, [
      huamachuco,
      bambamarca,
      huamachuco,
    ]);
    expect((await marcar(titular.agente, id, "llegada-mia", { medidor: 150 })).status).toBe(200);
    const base = { a_dni: relevo.dni, cambio_en: hora(4), motivo: "no lo marcaron" };
    // El cambio fue antes de llegar a B (km 150): no puede marcar más que eso.
    const alto = await corregir(id, { ...base, medidor: 190 });
    expect(alto.status).toBe(400);
    expect(JSON.stringify(alto.body)).toContain("parada marcada");
    expect(await turnosDe(id)).toHaveLength(1);
    expect((await corregir(id, { ...base, medidor: 120 })).status).toBe(200);
  });

  it("el reintento de la cola se reconoce aunque el mando ya cambió de manos", async () => {
    const { titular, relevo, id } = await enCurso();
    const llegada = crypto.randomUUID();
    const entrega = crypto.randomUUID();
    expect(
      (await marcar(titular.agente, id, "llegada-mia", { medidor: 150, cliente_uuid: llegada }))
        .status
    ).toBe(200);
    expect(
      (await marcar(titular.agente, id, "mando/entregar", { medidor: 150, cliente_uuid: entrega }))
        .status
    ).toBe(200);
    expect((await marcar(relevo.agente, id, "mando/aceptar", {})).status).toBe(200);
    // El titular ya no maneja, pero sus dos marcas ya entraron: el reintento no es un error.
    expect(
      (await marcar(titular.agente, id, "llegada-mia", { medidor: 150, cliente_uuid: llegada }))
        .status
    ).toBe(200);
    expect(
      (await marcar(titular.agente, id, "mando/entregar", { medidor: 150, cliente_uuid: entrega }))
        .status
    ).toBe(200);
    // Un marca nueva suya sí sigue rechazada, y un ajeno no recibe nada con ese uuid.
    expect((await marcar(titular.agente, id, "salida-mia", { medidor: 150 })).status).toBe(409);
    const ajeno = await conductor();
    expect(
      (await marcar(ajeno.agente, id, "llegada-mia", { medidor: 150, cliente_uuid: llegada }))
        .status
    ).toBe(404);
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
      medidor_actual: string | null;
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

  it("medidor_actual: la última lectura del viaje sin esperar al cierre (parada, entrega, cancelada)", async () => {
    const { titular, relevo, id } = await enCurso();
    const actual = async () => Number((await viajeDe(titular.agente, id)).medidor_actual);
    const inicial = await actual();
    expect(inicial).toBeGreaterThan(0);

    const e = await marcar(titular.agente, id, "mando/entregar", { medidor: inicial + 80 });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(await actual()).toBe(inicial + 80);

    // Una entrega cancelada ya no cuenta como lectura.
    expect((await marcar(titular.agente, id, "mando/retirar", {})).status).toBe(200);
    expect(await actual()).toBe(inicial);

    await marcar(titular.agente, id, "mando/entregar", { medidor: inicial + 100 });
    expect((await marcar(relevo.agente, id, "mando/aceptar", {})).status).toBe(200);
    expect(await actual()).toBe(inicial + 100);
    expect(
      (await marcar(relevo.agente, id, "llegada-mia", { medidor: inicial + 150 })).status
    ).toBe(200);
    expect(await actual()).toBe(inicial + 150);
  });

  it("medidor_actual: un viaje programado no tiene lectura y uno cerrado vale su medidor de cierre", async () => {
    const prog = await conRelevo();
    expect((await viajeDe(prog.titular.agente, prog.id)).medidor_actual).toBeNull();

    const c = await enCurso();
    expect(
      (await marcar(c.titular.agente, c.id, "llegada-mia", { medidor: 150, orden: 1 })).status
    ).toBe(200);
    expect(Number((await viajeDe(c.titular.agente, c.id)).medidor_actual)).toBe(150);
    expect(
      (await marcar(c.titular.agente, c.id, "salida-mia", { medidor: 150, orden: 1 })).status
    ).toBe(200);
    const fin = await marcar(c.titular.agente, c.id, "llegada-mia", { medidor: 260, orden: 2 });
    expect(fin.body.estado).toBe("cerrado");
    expect(Number((await viajeDe(c.titular.agente, c.id)).medidor_actual)).toBe(260);
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

  it("ponerle llegada a un viaje en curso al editarlo cierra también su descanso abierto", async () => {
    const c = await conRelevo(undefined, [huamachuco, bambamarca]);
    const ini = await marcar(c.titular.agente, c.id, "iniciar-mio", {
      medidor_inicio: 100,
      marcado_en: hace(120),
      cliente_uuid: crypto.randomUUID(),
    });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    const d = await admin
      .post(url(c.id, "/descanso"))
      .send({ motivo: "Avería", inicio_en: hace(60) });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const ed = await admin
      .put(url(c.id))
      .send({ fin_en: hace(10), medidor_fin: 200, motivo: "Cierro el viaje" });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    expect(ed.body.estado).toBe("cerrado");
    const descansos = (await admin.get(url(c.id))).body.viaje.descansos as {
      fin_en: string | null;
    }[];
    expect(descansos).toHaveLength(1);
    expect(descansos[0].fin_en).not.toBeNull();
  });

  it("corregir un cambio de mando recalcula qué descansos detienen la unidad", async () => {
    const c = await conRelevo(undefined, [huamachuco, bambamarca]);
    const ini = await marcar(c.titular.agente, c.id, "iniciar-mio", {
      medidor_inicio: 100,
      marcado_en: hace(120),
      cliente_uuid: crypto.randomUUID(),
    });
    expect(ini.status, JSON.stringify(ini.body)).toBe(200);
    // El titular descansa de hace 60 a hace 50 min: manejaba él, así que la unidad estuvo detenida.
    expect(
      (await admin.post(url(c.id, "/descanso")).send({ motivo: "Almuerzo", inicio_en: hace(60) }))
        .status
    ).toBe(200);
    const te = await admin
      .post(url(c.id, "/descanso/terminar"))
      .send({ fin_en: hace(50), motivo: "Prueba" });
    expect(te.status, JSON.stringify(te.body)).toBe(200);
    const detiene = async () =>
      ((await admin.get(url(c.id))).body.viaje.descansos as { detiene: boolean }[]).map(
        (x) => x.detiene
      );
    expect(await detiene()).toEqual([true]);

    // Resulta que el relevo manejaba desde hace 90 min: el descanso del titular no frenó nada.
    const cm = await admin.post(url(c.id, "/mando/corregir")).send({
      a_dni: c.relevo.dni,
      cambio_en: hace(90),
      medidor: 120,
      motivo: "No lo marcaron",
    });
    expect(cm.status, JSON.stringify(cm.body)).toBe(200);
    expect(await detiene()).toEqual([false]);
  });

  it("corregir el mando cierra la alerta de un descanso abierto que ya no detenía la unidad", async () => {
    const c = await conRelevo(undefined, [huamachuco, bambamarca]);
    expect(
      (
        await marcar(c.titular.agente, c.id, "iniciar-mio", {
          medidor_inicio: 100,
          marcado_en: hace(120),
          cliente_uuid: crypto.randomUUID(),
        })
      ).status
    ).toBe(200);
    expect(
      (await admin.post(url(c.id, "/descanso")).send({ motivo: "Avería", inicio_en: hace(60) }))
        .status
    ).toBe(200);
    const detenidoDe = async () =>
      (
        (await admin.get("/api/erp/combustible/alertas").query({ pageSize: 200 })).body.data as {
          tipo: string;
          viaje_id: number | null;
          resuelta_en: string | null;
        }[]
      ).filter((a) => a.tipo === "viaje_detenido" && Number(a.viaje_id) === c.id && !a.resuelta_en);
    expect(await detenidoDe()).toHaveLength(1);

    const cm = await admin.post(url(c.id, "/mando/corregir")).send({
      a_dni: c.relevo.dni,
      cambio_en: hace(90),
      medidor: 120,
      motivo: "No lo marcaron",
    });
    expect(cm.status, JSON.stringify(cm.body)).toBe(200);
    const descansos = (await admin.get(url(c.id))).body.viaje.descansos as { detiene: boolean }[];
    expect(descansos.map((d) => d.detiene)).toEqual([false]);
    expect(await detenidoDe()).toHaveLength(0);
  });

  it("cambiar el titular de un viaje con descansos se los pasa a la persona nueva", async () => {
    const c = await conRelevo(undefined, [huamachuco, bambamarca]);
    await marcar(c.titular.agente, c.id, "iniciar-mio", {
      medidor_inicio: 100,
      marcado_en: hace(120),
      cliente_uuid: crypto.randomUUID(),
    });
    await admin.post(url(c.id, "/descanso")).send({ motivo: "Almuerzo", inicio_en: hace(60) });
    await admin.post(url(c.id, "/descanso/terminar")).send({ fin_en: hace(50), motivo: "Prueba" });
    const libre = await conductor();
    const ed = await admin.put(url(c.id)).send({
      motivo: "Cambio de titular",
      conductor_dni: libre.dni,
      conductor_nombre: "Titular Nuevo",
    });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    const descansos = async () =>
      (await admin.get(url(c.id))).body.viaje.descansos as {
        conductor_nombre: string;
        detiene: boolean;
      }[];
    expect((await descansos()).map((d) => d.conductor_nombre)).toEqual(["Titular Nuevo"]);
    // Un cambio de mando posterior no lo confunde: el titular nuevo iba al volante a esa hora.
    const cm = await admin.post(url(c.id, "/mando/corregir")).send({
      a_dni: c.relevo.dni,
      cambio_en: hace(30),
      medidor: 150,
      motivo: "No lo marcaron",
    });
    expect(cm.status, JSON.stringify(cm.body)).toBe(200);
    expect((await descansos()).map((d) => d.detiene)).toEqual([true]);
  });
});
