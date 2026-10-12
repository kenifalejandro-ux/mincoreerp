/** tests/combustible-alertas-correos-reparto.test.ts
 *
 * PR 2 de alertas: los cuatro correos que faltaban (vale fuera de orden,
 * despacho tardío, tanqueta sobregirada, diferencia de recepción), cada uno
 * con el reparto por grifo del PR 1.
 *
 * Método de siempre: cada "no le llegó" va con su GEMELO "sí le llegó".
 * Un "no" solo podría ser que el envío entero esté roto, y eso se ve como
 * silencio.
 *
 * Además:
 *  - tanqueta: UN correo por sobregiro, no por vale (un correo por cada carga
 *    mientras siga en rojo es como muere una alerta).
 *  - recepciones: UN correo por grifo y por corrida, cortado en 10 líneas.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";
import { correrConciliacion } from "../src/server/services/combustibleConciliacion.worker";
import { enviarCorreoDiferenciaRecepcion } from "../src/modules/combustible/combustibleAlertas.mailer";

const correos: { destinatarios: { email: string }[]; asunto: string; lineas: string[] }[] = [];
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(
    async (args: { destinatarios: { email: string }[]; asunto: string; lineas: string[] }) => {
      correos.push({
        destinatarios: args.destinatarios,
        asunto: args.asunto,
        lineas: args.lineas,
      });
    }
  ),
}));

const PASSWORD = "ClaveDePrueba123";
let seq = 0;
const serieUnica = () => `P${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}`;
const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

afterAll(async () => {
  await closeDatabase();
});

describe("combustible: los correos nuevos van a quien tiene ese grifo", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let grifoA: number;
  let grifoB: number;
  let tanqueA: number;
  let tanqueB: number;
  let equipoA: number;
  let equipoB: number;
  let proveedorId: number;
  let jefeA: { id: string; email: string };
  let jefeB: { id: string; email: string };
  let jefeTodo: { id: string; email: string };

  async function persona(nombre: string) {
    const email = `${nombre}-${slug}@test.local`.toLowerCase();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre, email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    return { id: alta.body.id as string, email };
  }

  async function configurar(usuarioId: string, alcance?: { grifos: number[] }) {
    const actuales = (await admin.get(`/api/erp/usuarios/${usuarioId}/permisos`)).body as {
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
      alertasCorreo: { modulo: string; recibeAlertas: boolean }[];
    };
    const r = await admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
      modulos: actuales.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.modulo === "combustible" ? true : m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: actuales.alertasCorreo.map((a) => ({
        modulo: a.modulo,
        recibeAlertas: a.modulo === "combustible" ? true : a.recibeAlertas,
      })),
      alcanceCombustible: alcance
        ? { todo: false, sedes: [], surtidores: [], grifos: alcance.grifos }
        : { todo: true, sedes: [], grifos: [], surtidores: [] },
      motivo: "prueba automatizada: correos de alertas",
    });
    expect(r.status).toBe(200);
  }

  async function tanque(grifo: number, extra: Record<string, unknown> = {}) {
    const r = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
      grifo_interno_id: grifo,
      ...extra,
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const vale = (tq: number, equipo: number, serie: string, n: number) =>
    admin.post("/api/erp/combustible/despachos").send({
      origen: "tanque_propio",
      combustible_id: tq,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo,
      serie_talonario: serie,
      n_vale: n,
      cantidad: 35,
      lectura_contometro: 35,
      costo_unitario: 16,
      despachado_en: new Date().toISOString(),
    });

  const correosCon = (fragmento: string) => correos.filter((c) => c.asunto.includes(fragmento));
  const emails = (c: { destinatarios: { email: string }[] }) => c.destinatarios.map((d) => d.email);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    const sesion = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password: PASSWORD });
    expect(sesion.status).toBe(200);

    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    grifoA = sedes[0].grifos[0].id;
    grifoB = (
      await admin
        .post("/api/erp/administracion/grifos")
        .send({ sede_id: sedes[0].id, nombre: "Punto B" })
    ).body.id;
    proveedorId = (
      await admin
        .post("/api/erp/combustible/grifos")
        .send({ nombre: idUnico("Prov"), abastece_tanque: true })
    ).body.id;

    tanqueA = await tanque(grifoA);
    tanqueB = await tanque(grifoB);
    equipoA = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("EA"),
        tipo: "Volquete",
        tipo_medidor: "horometro",
        grifo_interno_id: grifoA,
      })
    ).body.id;
    equipoB = (
      await admin.post("/api/erp/equipos").send({
        placa_codigo: idUnico("EB"),
        tipo: "Volquete",
        tipo_medidor: "horometro",
        grifo_interno_id: grifoB,
      })
    ).body.id;

    jefeA = await persona("jefeA");
    jefeB = await persona("jefeB");
    jefeTodo = await persona("jefeTodo");
    await configurar(jefeA.id, { grifos: [grifoA] });
    await configurar(jefeB.id, { grifos: [grifoB] });
    await configurar(jefeTodo.id);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  beforeEach(() => {
    correos.length = 0;
  });

  // ── vale fuera de orden ───────────────────────────────────────────────

  it("vale fuera de orden: el correo va a quien ve ese grifo, y solo a él", async () => {
    const serieA = serieUnica();
    await vale(tanqueA, equipoA, serieA, 50);
    expect((await vale(tanqueA, equipoA, serieA, 7)).status).toBe(201);

    const deA = correosCon("fuera de orden");
    expect(deA).toHaveLength(1);
    // El gemelo: sí llega a quien corresponde.
    expect(emails(deA[0])).toEqual(expect.arrayContaining([jefeA.email, jefeTodo.email]));
    // El ataque: el jefe del otro grifo no se entera.
    expect(emails(deA[0])).not.toContain(jefeB.email);

    correos.length = 0;
    const serieB = serieUnica();
    await vale(tanqueB, equipoB, serieB, 50);
    await vale(tanqueB, equipoB, serieB, 7);
    const deB = correosCon("fuera de orden");
    expect(deB).toHaveLength(1);
    expect(emails(deB[0])).toEqual(expect.arrayContaining([jefeB.email, jefeTodo.email]));
    expect(emails(deB[0])).not.toContain(jefeA.email);
  });

  it("vale en orden: no manda el correo (el gemelo del silencio)", async () => {
    const serie = serieUnica();
    await vale(tanqueA, equipoA, serie, 1);
    await vale(tanqueA, equipoA, serie, 2);
    expect(correosCon("fuera de orden")).toHaveLength(0);
  });

  // ── despacho tardío ───────────────────────────────────────────────────

  it("despacho tardío: avisa solo al grifo del vale", async () => {
    const serie = serieUnica();
    await vale(tanqueA, equipoA, serie, 1);
    await vale(tanqueA, equipoA, serie, 3);
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE combustible_alertas SET creado_en = now() - make_interval(hours => 100)
         WHERE tenant_id = $1 AND serie_talonario = $2`,
        [tenantId, serie]
      )
    );
    await correrConciliacion(tenantId);
    correos.length = 0;

    expect((await vale(tanqueA, equipoA, serie, 2)).status).toBe(201);
    const tardios = correosCon("llegó tarde");
    expect(tardios).toHaveLength(1);
    expect(emails(tardios[0])).toEqual(expect.arrayContaining([jefeA.email, jefeTodo.email]));
    expect(emails(tardios[0])).not.toContain(jefeB.email);
  });

  // ── tanqueta sobregirada ──────────────────────────────────────────────

  describe("tanqueta sobregirada: un correo por sobregiro", () => {
    let conductor: ReturnType<typeof request.agent>;
    let tanquetaId: number;
    let tanqueGal: number;
    let nVale = 1;

    const llenar = (cantidad: number) =>
      admin.post("/api/erp/combustible/despachos").send({
        origen: "tanque_propio",
        combustible_id: tanqueGal,
        tipo_combustible: "diesel_b5",
        tipo_destino: "reserva_cubeta",
        tanqueta_destino_id: tanquetaId,
        serie_talonario: "TQC",
        n_vale: nVale++,
        cantidad,
        lectura_contometro: cantidad,
        costo_unitario: 16,
      });

    const cargar = (cantidad: number) =>
      conductor.post("/api/erp/combustible/despachos").send({
        origen: "tanqueta",
        tanqueta_origen_id: tanquetaId,
        tipo_combustible: "diesel_b5",
        tipo_destino: "equipo",
        equipo_id: equipoA,
        cantidad,
        lectura_horometro: 1000 + seq++ * 10,
      });

    beforeAll(async () => {
      const dni = String(87600000 + Math.floor(Math.random() * 300000) + seq++);
      const alta = await admin
        .post("/api/erp/usuarios")
        .send({ nombre: "Conductor", dni, password: PASSWORD, rol: "conductor_ruta" });
      expect(alta.status).toBe(201);
      conductor = request.agent(app);
      await conductor
        .post("/api/auth/login")
        .send({ tenantSlug: slug, identificador: dni, password: PASSWORD });
      // La tanqueta es en galones: el tanque que la llena también.
      tanqueGal = await tanque(grifoA, {
        unidad: "gal",
        capacidad_total: 10000,
        nivel_actual: 8000,
      });
      const t = await admin
        .post("/api/erp/combustible/tanquetas")
        .send({ grifo_interno_id: grifoA });
      expect(t.status).toBe(201);
      tanquetaId = Number(t.body.id);
    });

    it("la carga que cruza a negativo avisa; las siguientes, mientras siga en rojo, no", async () => {
      expect((await llenar(100)).status).toBe(201);
      correos.length = 0;

      // Cruza: de +100 a -50.
      expect((await cargar(150)).status).toBe(201);
      const primero = correosCon("saldo negativo");
      expect(primero).toHaveLength(1);
      // Va al grifo de la TANQUETA, y no al de la otra sede.
      expect(emails(primero[0])).toEqual(expect.arrayContaining([jefeA.email, jefeTodo.email]));
      expect(emails(primero[0])).not.toContain(jefeB.email);

      // Ya en rojo: la alerta del panel sigue naciendo, el correo no.
      correos.length = 0;
      expect((await cargar(20)).status).toBe(201);
      expect(correosCon("saldo negativo")).toHaveLength(0);
      const alertas = await admin.get("/api/erp/combustible/alertas").query({ pageSize: 200 });
      const delPanel = alertas.body.data.filter(
        (a: { tipo: string }) => a.tipo === "tanqueta_sobregirada"
      );
      expect(delPanel.length).toBeGreaterThanOrEqual(2);
    });

    it("cuando el saldo vuelve a positivo y se cruza otra vez, avisa de nuevo", async () => {
      // Sale del rojo (venía en -70): +300 -> 230.
      expect((await llenar(300)).status).toBe(201);
      correos.length = 0;
      expect((await cargar(400)).status).toBe(201);
      expect(correosCon("saldo negativo")).toHaveLength(1);
    });

    it("una carga que no deja la tanqueta en negativo no avisa", async () => {
      const ll = await llenar(250);
      expect(ll.status, JSON.stringify(ll.body)).toBe(201);
      correos.length = 0;
      expect((await cargar(10)).status).toBe(201);
      expect(correosCon("saldo negativo")).toHaveLength(0);
    });

    it("cargas SIMULTÁNEAS que la sobregiran avisan exactamente una vez", async () => {
      // Auditoría: decidir "esta carga cruzó" leyendo el saldo DESPUÉS de
      // guardar falla con cargas concurrentes (cola offline, dos equipos):
      // cada una ve un saldo que ya incluye a las otras. Con tres de 80 sobre
      // 100, las tres ven -140 y ninguna se cree la que cruzó.
      const t = await admin
        .post("/api/erp/combustible/tanquetas")
        .send({ grifo_interno_id: grifoA });
      expect(t.status).toBe(201);
      tanquetaId = Number(t.body.id);
      expect((await llenar(100)).status).toBe(201);
      correos.length = 0;

      const r = await Promise.all([cargar(80), cargar(80), cargar(80)]);
      expect(r.map((x) => x.status)).toEqual([201, 201, 201]);
      expect(correosCon("saldo negativo")).toHaveLength(1);
    });
  });

  // ── diferencia de recepción ───────────────────────────────────────────

  describe("diferencia de recepción: un correo por grifo y por corrida", () => {
    /** Facturaron 5.000 y entraron 4.000: falta 1.000 contra una tolerancia
     *  de 1% + 100. Habla. */
    async function recepcionConFalta(tq: number) {
      const l1 = await admin
        .post("/api/erp/combustible/lecturas")
        .send({ combustible_id: tq, nivel: 8000, leido_en: hace(10) });
      expect(l1.status).toBe(201);
      const rec = await admin.post("/api/erp/combustible/recepciones").send({
        combustible_id: tq,
        grifo_id: proveedorId,
        cantidad: 5000,
        costo_unitario: 16,
        tipo_documento: "factura",
        numero_documento: idUnico("F"),
        recibido_en: hace(9.5),
      });
      expect(rec.status).toBe(201);
      const l2 = await admin
        .post("/api/erp/combustible/lecturas")
        .send({ combustible_id: tq, nivel: 12000, leido_en: hace(9) });
      expect(l2.status).toBe(201);
    }

    it("cada grifo recibe lo suyo, una sola vez", async () => {
      const tA = await tanque(grifoA, { umbral_diferencia_pct: 1, umbral_diferencia_piso: 100 });
      const tB = await tanque(grifoB, { umbral_diferencia_pct: 1, umbral_diferencia_piso: 100 });
      await recepcionConFalta(tA);
      await recepcionConFalta(tB);
      correos.length = 0;

      await correrConciliacion(tenantId);
      const dif = correosCon("contra la varilla");
      // Dos grifos con diferencia en la misma corrida = dos correos.
      expect(dif).toHaveLength(2);
      const aA = dif.find((c) => emails(c).includes(jefeA.email));
      const aB = dif.find((c) => emails(c).includes(jefeB.email));
      expect(aA).toBeDefined();
      expect(aB).toBeDefined();
      expect(emails(aA!)).not.toContain(jefeB.email);
      expect(emails(aB!)).not.toContain(jefeA.email);
      expect(emails(aA!)).toContain(jefeTodo.email);
      expect(emails(aB!)).toContain(jefeTodo.email);

      // Segunda corrida: la alerta ya existe, no vuelve a sonar.
      correos.length = 0;
      await correrConciliacion(tenantId);
      expect(correosCon("contra la varilla")).toHaveLength(0);
    });

    it("el correo se corta en 10 recepciones y dice cuántas faltan", async () => {
      correos.length = 0;
      const item = {
        tanqueNombre: "Tanque",
        unidad: "L",
        diferenciaLitros: -1000,
        diferenciaPct: 20,
        toleradoLitros: 150,
      };
      await enviarCorreoDiferenciaRecepcion(
        [{ email: "x@test.local", nombre: "X" }],
        Array.from({ length: 12 }, () => item)
      );
      expect(correos).toHaveLength(1);
      expect(correos[0].asunto).toContain("12 recepciones");
      const listadas = correos[0].lineas.filter((l) => l.startsWith("- "));
      expect(listadas).toHaveLength(10);
      expect(correos[0].lineas.some((l) => l.includes("y 2 más"))).toBe(true);
    });
  });
});
