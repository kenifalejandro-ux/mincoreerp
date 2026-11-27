/** tests/mantenimiento-preventivo.test.ts
 *
 * M9: el cálculo del preventivo, los servicios realizados y las lecturas del medidor, con empresas que tienen
 * SOLO `mantenimiento`.
 *
 * 1. El cálculo, sin base: qué nivel toca, cuánto falta, estados y cumplimiento.
 * 2. El resumen: vencido, próximo, al día y sin datos (con su motivo), equipos sin plan y cambios de plan.
 * 3. Registrar un servicio deja su lectura; si no cuadra no se guarda nada. Anular deshace las dos.
 * 4. Datos absurdos: 400 o 404, nunca 500.
 * 5. Reintentos y carreras.
 * 6. Permisos, otra empresa, auditoría, cuota y respaldo.
 * 7. Un servicio cuya lectura se anuló desde Flota deja de contar.
 */
import { randomUUID } from "node:crypto";

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico } from "./helpers";
import {
  calcularProximo,
  cumplimiento,
  pasoDelNivel,
  pasoSiguiente,
} from "../src/modules/mantenimiento/mantenimiento.calculo";
import { MODULOS } from "../src/modules/registry";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { fijarCuotaTenant } from "../src/server/services/platformCuotas.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";
const R = "/api/erp/mantenimiento";
const P = `${R}/preventivo`;
const CICLO = [1, 2, 1, 3];

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
type Agente = ReturnType<typeof request.agent>;
interface Fila {
  equipo_id: number;
  estado: string;
  motivo: string | null;
  lectura: number;
  ultimo: { id: number; nivel: number; paso: number; lectura: number } | null;
  proximo: { nivel: number; paso: number; en_lectura: number; faltan: number } | null;
}

describe("Preventivo: el cálculo", () => {
  const plan = { intervalo: 250, aviso_antes: 25, ciclo: CICLO };

  it("recorre el ciclo y vuelve a empezar", () => {
    expect(CICLO.map((nivel, paso) => pasoSiguiente(CICLO, { nivel, paso }))).toEqual([1, 2, 3, 0]);
    expect(pasoSiguiente(CICLO, null)).toBe(0);
    expect(pasoSiguiente([2], { nivel: 2, paso: 0 })).toBe(0);
  });

  it("si el plan cambió, se ubica por el nivel; si el nivel ya no está, empieza de nuevo", () => {
    // Era el paso 3 (MP3); ahora el MP3 está en la posición 1.
    expect(pasoSiguiente([1, 3, 2], { nivel: 3, paso: 3 })).toBe(2);
    expect(pasoSiguiente([1, 2], { nivel: 3, paso: 3 })).toBe(0);
    expect(pasoSiguiente([1], { nivel: 1, paso: 11 })).toBe(0);
  });

  it("busca la posición de un nivel desde la que tocaba, dando la vuelta", () => {
    expect(pasoDelNivel(CICLO, 1, 1)).toBe(2);
    expect(pasoDelNivel(CICLO, 3, 1)).toBe(0);
    expect(pasoDelNivel(CICLO, 0, 3)).toBe(3);
    expect(pasoDelNivel([1, 2], 0, 3)).toBeNull();
  });

  it.each([
    [1000, 250, "al_dia"],
    [1224, 26, "al_dia"],
    [1225, 25, "proximo"],
    [1249.99, 0.01, "proximo"],
    [1250, 0, "vencido"],
    [1300, -50, "vencido"],
    // Una lectura menor que la del servicio no resta: el medidor no retrocede.
    [0, 250, "al_dia"],
  ])("con %s de lectura faltan %s y está %s", (actual, faltan, estado) => {
    const r = calcularProximo(plan, { nivel: 1, paso: 0, lectura: 1000 }, actual);
    expect(r).toMatchObject({ faltan, estado, en_lectura: 1250, nivel: 2, paso: 1 });
  });

  it("los decimales no ensucian la resta", () => {
    const r = calcularProximo(plan, { nivel: 1, paso: 0, lectura: 0.1 }, 0.3);
    expect(r).toMatchObject({ en_lectura: 250.1, faltan: 249.8 });
  });

  it("sin aviso solo hay al día o vencido, y sin servicio previo no hay cálculo", () => {
    const sinAviso = { ...plan, aviso_antes: 0 };
    const previo = { nivel: 1, paso: 0, lectura: 0 };
    expect(calcularProximo(sinAviso, previo, 249.99)!.estado).toBe("al_dia");
    expect(calcularProximo(sinAviso, previo, 250)!.estado).toBe("vencido");
    expect(calcularProximo(plan, null, 500)).toBeNull();
  });

  it("el cumplimiento ignora lo que no tiene datos y nunca redondea hacia arriba", () => {
    expect(cumplimiento([])).toBeNull();
    expect(cumplimiento(["sin_datos"])).toBeNull();
    expect(cumplimiento(["al_dia", "proximo", "sin_datos"])).toBe(100);
    expect(cumplimiento(["vencido"])).toBe(0);
    expect(cumplimiento(["al_dia", "al_dia", "vencido"])).toBe(66);
    expect(cumplimiento([...Array(199).fill("al_dia"), "vencido"])).toBe(99);
  });
});

describe("Preventivo: servicios, lecturas y resumen", () => {
  const empresas: Empresa[] = [];
  let a: Empresa;
  let b: Empresa;
  let admin: Agente;
  let adminB: Agente;

  const modulos = async (e: Empresa, lista: string[]) => {
    const r = await request(app)
      .put(`/api/platform/tenants/${e.tenant.id}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: MODULOS.map((m) => ({
          modulo: m.id,
          estado: lista.includes(m.id) ? "habilitado" : "deshabilitado",
        })),
      });
    expect(r.status).toBe(200);
  };
  const entrar = async (e: Empresa) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const nueva = async (lista = ["mantenimiento"]) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    await modulos(e, lista);
    return e;
  };
  const persona = async (rol: string) => {
    const dni = dniUnico();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password: PASSWORD, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, identificador: dni, password: PASSWORD });
    expect(res.status).toBe(200);
    return ag;
  };
  const crearPlan = async (tipo: string, extra: object = {}, ag: Agente = admin) => {
    const r = await ag.post(`${R}/planes`).send({
      tipo_equipo: tipo,
      medida: "horometro",
      intervalo: 250,
      ciclo: CICLO,
      niveles: { "1": { tareas: ["a"] }, "2": { tareas: ["b"] }, "3": { tareas: ["c"] } },
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: number };
  };
  /** Un equipo con su propio tipo y plan, para que los casos no se mezclen. */
  const equipoConPlan = async (extra: { lectura?: number } = {}, ag: Agente = admin) => {
    const clave = randomUUID().slice(0, 8);
    const tipo = `Tipo ${clave}`;
    const r = await ag.post(`${R}/equipos`).send({ placa_codigo: clave, tipo, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const plan = await crearPlan(tipo, {}, ag);
    return { id: r.body.id as number, tipo, placa: clave, plan: plan.id };
  };
  const servicio = (equipo_id: number, extra: object = {}) => ({
    cliente_uuid: randomUUID(),
    equipo_id,
    nivel: 1,
    lectura: 1000,
    hecho_en: "2026-01-10T12:00:00Z",
    ...extra,
  });
  const registrar = async (equipo_id: number, extra: object = {}, ag: Agente = admin) => {
    const r = await ag.post(`${P}/servicios`).send(servicio(equipo_id, extra));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: number; paso: number; lectura: number; observacion: string | null };
  };
  const anular = (id: number | string, ag: Agente = admin, motivo = "Dato mal escrito") =>
    ag.patch(`${P}/servicios/${id}/anular`).send({ motivo });
  const urlLecturas = (equipo: number | string) => `${P}/equipos/${equipo}/lecturas`;
  const lecturas = async (equipo: number, ag: Agente = admin) => {
    const r = await ag.get(urlLecturas(equipo));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.lecturas as {
      id: number;
      valor: number;
      anulada_en: string | null;
      motivo_anulacion: string | null;
    }[];
  };
  const vigentes = async (equipo: number) =>
    (await lecturas(equipo))
      .filter((l) => !l.anulada_en)
      .map((l) => l.valor)
      .sort((x, y) => x - y);
  const servicios = async (equipo: number) => {
    const r = await admin.get(`${P}/equipos/${equipo}/servicios`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.servicios as { id: number; anulado_en: string | null }[];
  };
  const resumen = async (ag: Agente = admin) => {
    const r = await ag.get(P);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as {
      meta: number;
      cumplimiento: number | null;
      totales: Record<string, number>;
      niveles: { nivel: number; al_dia: number; proximo: number; vencido: number }[];
      equipos: Fila[];
    };
  };
  const fila = async (equipo: number) =>
    (await resumen()).equipos.find((e) => e.equipo_id === equipo)!;

  beforeAll(async () => {
    a = await nueva();
    b = await nueva();
    admin = await entrar(a);
    adminB = await entrar(b);
  });

  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  it("el resumen cuenta cada estado, por nivel y contra la meta", async () => {
    const c = await nueva();
    const ag = await entrar(c);
    const vacio = await resumen(ag);
    expect(vacio).toMatchObject({ meta: 90, cumplimiento: null, equipos: [] });

    const alDia = await equipoConPlan({ lectura: 1100 }, ag);
    const proximo = await equipoConPlan({ lectura: 1230 }, ag);
    const vencido = await equipoConPlan({ lectura: 1400 }, ag);
    const sinServicio = await equipoConPlan({ lectura: 50 }, ag);
    await ag.post(`${R}/equipos`).send({ placa_codigo: "SIN-PLAN", tipo: "Otro" });
    const quitado = await equipoConPlan({}, ag);
    expect(
      (await ag.patch(`${R}/equipos/${quitado.id}/quitar`).send({ motivo: "Baja" })).status
    ).toBe(200);
    for (const e of [alDia, proximo, vencido]) await registrar(e.id, {}, ag);
    await ag.put(`${R}/config`).send({ meta_preventivo: 75 });

    const r = await resumen(ag);
    expect(r.meta).toBe(75);
    expect(r.cumplimiento).toBe(66);
    expect(r.totales).toEqual({ al_dia: 1, proximo: 1, vencido: 1, sin_datos: 1, sin_plan: 1 });
    expect(r.niveles).toEqual([
      { nivel: 1, al_dia: 0, proximo: 0, vencido: 0 },
      { nivel: 2, al_dia: 1, proximo: 1, vencido: 1 },
      { nivel: 3, al_dia: 0, proximo: 0, vencido: 0 },
    ]);
    const de = (id: number) => r.equipos.find((f) => f.equipo_id === id)!;
    expect(de(vencido.id).proximo).toMatchObject({ en_lectura: 1250, faltan: -150 });
    expect(de(sinServicio.id)).toMatchObject({ estado: "sin_datos", motivo: "sin_servicio" });
    expect(r.equipos.map((f) => f.equipo_id)).not.toContain(quitado.id);
  });

  it("sigue el ciclo servicio tras servicio y acepta indicar la posición", async () => {
    const e = await equipoConPlan();
    const pasos: number[] = [];
    for (const [i, nivel] of [1, 2, 1, 3, 1].entries()) {
      const s = await registrar(e.id, {
        nivel,
        lectura: 250 * (i + 1),
        hecho_en: `2026-0${i + 1}-10T12:00:00Z`,
      });
      pasos.push(s.paso);
    }
    expect(pasos).toEqual([0, 1, 2, 3, 0]);
    expect((await fila(e.id)).proximo).toMatchObject({ nivel: 2, en_lectura: 1500 });

    const otro = await equipoConPlan();
    await registrar(otro.id, { paso: 2 });
    expect((await fila(otro.id)).proximo).toMatchObject({ nivel: 3, paso: 3 });
  });

  it("un servicio anotado con fecha anterior no pisa al más reciente", async () => {
    const e = await equipoConPlan();
    await registrar(e.id, { nivel: 2, lectura: 800, hecho_en: "2026-03-01T12:00:00Z" });
    await registrar(e.id, { nivel: 1, lectura: 500, hecho_en: "2026-02-01T12:00:00Z" });
    expect((await fila(e.id)).ultimo).toMatchObject({ nivel: 2, lectura: 800 });
  });

  it("si la lectura no cuadra, no se guarda ni el servicio ni la lectura", async () => {
    const e = await equipoConPlan();
    await registrar(e.id);
    const menor = servicio(e.id, { nivel: 2, lectura: 900, hecho_en: "2026-02-01T12:00:00Z" });
    const r = await admin.post(`${P}/servicios`).send(menor);
    expect(r.status).toBe(400);
    expect(await servicios(e.id)).toHaveLength(1);
    expect(await vigentes(e.id)).toEqual([1000]);
    // El mismo pedido, ya corregido, entra: el rechazo no dejó la clave reservada.
    const bien = await admin.post(`${P}/servicios`).send({ ...menor, lectura: 1100 });
    expect(bien.status, JSON.stringify(bien.body)).toBe(201);
  });

  it("anular un servicio anula su lectura y vuelve a mandar el anterior", async () => {
    const e = await equipoConPlan();
    await registrar(e.id);
    const malo = await registrar(e.id, {
      nivel: 2,
      lectura: 9000,
      hecho_en: "2026-02-01T12:00:00Z",
    });
    expect((await anular(malo.id)).status).toBe(200);
    expect(await vigentes(e.id)).toEqual([1000]);
    expect(await fila(e.id)).toMatchObject({ lectura: 1000, ultimo: { lectura: 1000 } });
    expect((await servicios(e.id)).filter((s) => s.anulado_en)).toHaveLength(1);
    // Se puede registrar de nuevo, bien.
    await registrar(e.id, { nivel: 2, lectura: 1250, hecho_en: "2026-02-01T12:00:00Z" });
  });

  it("anular un servicio cuya lectura ya se había anulado en la base no falla", async () => {
    const e = await equipoConPlan();
    const s = await registrar(e.id);
    await withTenant(a.tenant.id, (c) =>
      c.query(
        `UPDATE equipo_lecturas SET anulada_en = now(), motivo_anulacion = 'aparte'
          WHERE equipo_id = $1`,
        [e.id]
      )
    );
    expect((await anular(s.id)).status).toBe(200);
    expect((await lecturas(e.id))[0].motivo_anulacion).toBe("aparte");
  });

  it("la lectura de un servicio vigente no se anula sola; una suelta sí", async () => {
    const e = await equipoConPlan();
    await registrar(e.id);
    const suelta = await admin.post(urlLecturas(e.id)).send({ valor: 1300 });
    expect(suelta.status, JSON.stringify(suelta.body)).toBe(201);
    expect((await fila(e.id)).estado).toBe("vencido");
    const [deServicio] = (await lecturas(e.id)).filter((l) => l.valor === 1000);
    const motivo = { motivo: "Mal anotada" };
    const no = await admin.patch(`${urlLecturas(e.id)}/${deServicio.id}/anular`).send(motivo);
    expect(no.status).toBe(409);
    const si = await admin.patch(`${urlLecturas(e.id)}/${suelta.body.id}/anular`).send(motivo);
    expect(si.status).toBe(200);
    expect((await fila(e.id)).estado).toBe("al_dia");
  });

  it("no se registra sin plan, con otro medidor, ni un nivel o posición que el plan no tiene", async () => {
    const sin = await admin.post(`${R}/equipos`).send({ placa_codigo: "SP-1", tipo: "Sin plan A" });
    const r1 = await admin.post(`${P}/servicios`).send(servicio(sin.body.id));
    expect(r1.status).toBe(409);

    const km = await admin
      .post(`${R}/equipos`)
      .send({ placa_codigo: "KM-1", tipo: "En km", medidor: "odometro" });
    await crearPlan("En km");
    expect((await admin.post(`${P}/servicios`).send(servicio(km.body.id))).status).toBe(409);
    expect(await fila(km.body.id)).toMatchObject({
      estado: "sin_datos",
      motivo: "medidor_distinto",
    });
    expect(await vigentes(km.body.id)).toEqual([]);

    const corto = await admin.post(`${R}/equipos`).send({ placa_codigo: "C-1", tipo: "Corto" });
    await crearPlan("Corto", { ciclo: [1], niveles: { "1": { tareas: ["a"] } } });
    for (const extra of [{ nivel: 3 }, { paso: 1 }, { paso: 11 }]) {
      const r = await admin.post(`${P}/servicios`).send(servicio(corto.body.id, extra));
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await vigentes(corto.body.id)).toEqual([]);
  });

  it("un equipo creado sin medidor definido se atiende como horómetro, que es lo que se muestra", async () => {
    const e = await equipoConPlan();
    await withTenant(a.tenant.id, (c) =>
      c.query("UPDATE equipos SET tipo_medidor = NULL WHERE id = $1", [e.id])
    );
    expect((await fila(e.id)).motivo).toBe("sin_servicio");
    const s = await admin.post(`${P}/servicios`).send(servicio(e.id));
    expect.soft(s.status, JSON.stringify(s.body)).toBe(201);
    const l = await admin.post(urlLecturas(e.id)).send({ valor: 1100 });
    expect.soft(l.status, JSON.stringify(l.body)).toBe(201);
  });

  it("a un equipo quitado no se le registran servicios ni lecturas", async () => {
    const e = await equipoConPlan();
    await admin.patch(`${R}/equipos/${e.id}/quitar`).send({ motivo: "Baja" });
    expect((await admin.post(`${P}/servicios`).send(servicio(e.id))).status).toBe(404);
    expect((await admin.post(urlLecturas(e.id)).send({ valor: 5 })).status).toBe(404);
  });

  it("el plan se puede cambiar o quitar sin perder los servicios", async () => {
    const e = await equipoConPlan();
    await registrar(e.id, { nivel: 3 });
    const cambio = await admin.put(`${R}/planes/${e.plan}`).send({
      tipo_equipo: e.tipo,
      medida: "horometro",
      intervalo: 500,
      aviso_antes: 50,
      ciclo: [1, 2],
      niveles: { "1": { tareas: ["a"] }, "2": { tareas: ["b"] } },
      version: 1,
    });
    expect(cambio.status, JSON.stringify(cambio.body)).toBe(200);
    expect((await fila(e.id)).proximo).toMatchObject({ nivel: 1, paso: 0, en_lectura: 1500 });
    await admin.delete(`${R}/planes/${e.plan}`);
    expect(await fila(e.id)).toBeUndefined();
    expect(await servicios(e.id)).toHaveLength(1);
  });

  it("el mismo MP con la misma lectura no entra dos veces, ni con decimales de más", async () => {
    const e = await equipoConPlan();
    await registrar(e.id, { lectura: 1000.01 });
    for (const lectura of [1000.01, 1000.012, 1000.0149]) {
      const r = await admin.post(`${P}/servicios`).send(servicio(e.id, { lectura }));
      expect.soft(r.status, `lectura ${lectura}`).toBe(409);
    }
    expect(await servicios(e.id)).toHaveLength(1);
  });

  it("un servicio inválido da 400, nunca 500, y no se guarda nada", async () => {
    const e = await equipoConPlan();
    const base = () => servicio(e.id);
    const malos: Record<string, unknown>[] = [
      {},
      { cliente_uuid: undefined },
      { cliente_uuid: "abc" },
      { equipo_id: 0 },
      { equipo_id: -1 },
      { equipo_id: 1.5 },
      { equipo_id: "1" },
      { equipo_id: 2_147_483_648 },
      { nivel: 0 },
      { nivel: 4 },
      { nivel: "1" },
      { paso: -1 },
      { paso: 12 },
      { paso: 1.5 },
      { lectura: -1 },
      { lectura: 10_000_000 },
      { lectura: 1e30 },
      { lectura: "100" },
      { lectura: null },
      { hecho_en: undefined },
      { hecho_en: "ayer" },
      { hecho_en: "2026-01-10" },
      { hecho_en: "2026-02-30T12:00:00Z" },
      { hecho_en: "0001-01-01T00:00:00Z" },
      { hecho_en: "1999-12-31T23:59:59Z" },
      { hecho_en: "2999-01-01T00:00:00Z" },
      { hecho_en: "2026-01-10T12:00:00+99:00" },
      { observacion: 5 },
      { observacion: "x".repeat(301) },
      { tenant_id: b.tenant.id },
      { medida: "odometro" },
    ];
    const fallos: string[] = [];
    for (const [i, extra] of malos.entries()) {
      const cuerpo = i === 0 ? {} : { ...base(), ...extra };
      const r = await admin.post(`${P}/servicios`).send(cuerpo);
      if (r.status !== 400) fallos.push(`${r.status} ${JSON.stringify(extra).slice(0, 100)}`);
    }
    expect(fallos).toEqual([]);
    expect(await servicios(e.id)).toEqual([]);
    expect(await vigentes(e.id)).toEqual([]);
  });

  it("los textos con caracteres invisibles se limpian y no dan error", async () => {
    const e = await equipoConPlan();
    const s = await registrar(e.id, { observacion: "Cambio\u0000de\tfiltro" });
    expect(s.observacion).toBe("Cambio de filtro");
    expect((await anular(s.id, admin, "Mal\u0000anotado")).status).toBe(200);
  });

  it("anular una lectura con un motivo raro no da error de servidor", async () => {
    const e = await equipoConPlan();
    const l = await admin.post(urlLecturas(e.id)).send({ valor: 10 });
    const url = `${urlLecturas(e.id)}/${l.body.id}/anular`;
    for (const motivo of ["", "  ", "x".repeat(301), 5]) {
      expect((await admin.patch(url).send({ motivo })).status, String(motivo)).toBe(400);
    }
    const r = await admin.patch(url).send({ motivo: "Mal\u0000anotada" });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
  });

  it("lecturas inválidas e ids absurdos se rechazan sin error de servidor", async () => {
    const e = await equipoConPlan();
    const fallos: string[] = [];
    for (const cuerpo of [
      {},
      { valor: -1 },
      { valor: "5" },
      { valor: 1e30 },
      { valor: 5, leido_en: "0001-01-01T00:00:00Z" },
      { valor: 5, leido_en: "2999-01-01T00:00:00Z" },
      { valor: 5, cliente_uuid: "abc" },
    ]) {
      const r = await admin.post(urlLecturas(e.id)).send(cuerpo);
      if (r.status !== 400) fallos.push(`${r.status} ${JSON.stringify(cuerpo)}`);
    }
    for (const id of ["0", "999999999", "2147483648", "99999999999999999999", "abc", "-1"]) {
      const pedidos = {
        anularServicio: await anular(id),
        servicios: await admin.get(`${P}/equipos/${id}/servicios`),
        lecturas: await admin.get(urlLecturas(id)),
        nueva: await admin.post(urlLecturas(id)).send({ valor: 5 }),
        anularLectura: await admin
          .patch(`${urlLecturas(e.id)}/${id}/anular`)
          .send({ motivo: "motivo" }),
      };
      for (const [nombre, r] of Object.entries(pedidos)) {
        if (r.status !== 404) fallos.push(`id ${id} ${nombre}: ${r.status}`);
      }
    }
    expect(fallos).toEqual([]);
  });

  it("el reintento devuelve el mismo servicio y la misma clave con otros datos se rechaza", async () => {
    const e = await equipoConPlan();
    const pedido = servicio(e.id);
    const uno = await admin.post(`${P}/servicios`).send(pedido);
    const dos = await admin.post(`${P}/servicios`).send(pedido);
    expect([uno.status, dos.status]).toEqual([201, 200]);
    expect(dos.body.id).toBe(uno.body.id);
    const otro = await admin.post(`${P}/servicios`).send({ ...pedido, lectura: 1500 });
    expect(otro.status).toBe(409);
    await anular(uno.body.id);
    const tarde = await admin.post(`${P}/servicios`).send(pedido);
    expect(tarde.status).toBe(200);
    expect(tarde.body.anulado_en).not.toBeNull();
    expect(await servicios(e.id)).toHaveLength(1);

    const lectura = { valor: 2000, cliente_uuid: randomUUID() };
    const l1 = await admin.post(urlLecturas(e.id)).send(lectura);
    const l2 = await admin.post(urlLecturas(e.id)).send(lectura);
    expect([l1.status, l2.status]).toEqual([201, 200]);
    expect(await vigentes(e.id)).toEqual([2000]);
  });

  it("de varios envíos a la vez entra uno solo, con la misma clave o con distinta", async () => {
    const e = await equipoConPlan();
    const mismo = servicio(e.id);
    const r1 = await Promise.all(
      Array.from({ length: 5 }, () => admin.post(`${P}/servicios`).send(mismo))
    );
    expect(r1.map((x) => x.status).sort()).toEqual([200, 200, 200, 200, 201]);

    const otro = await equipoConPlan();
    const r2 = await Promise.all(
      Array.from({ length: 5 }, () => admin.post(`${P}/servicios`).send(servicio(otro.id)))
    );
    expect(r2.map((x) => x.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await vigentes(otro.id)).toEqual([1000]);
  });

  it("servicios distintos a la vez se encolan sin bloquearse y de varias anulaciones entra una", async () => {
    const e = await equipoConPlan();
    const r = await Promise.all(
      [1000, 1000, 1000, 1000].map((lectura, i) =>
        admin.post(`${P}/servicios`).send(servicio(e.id, { nivel: [1, 2, 3, 1][i], lectura }))
      )
    );
    expect(r.every((x) => x.status === 201 || x.status === 409)).toBe(true);
    const creado = r.find((x) => x.status === 201)!.body.id;
    const [l] = (await lecturas(e.id)).slice(-1);
    const cruzadas = await Promise.all([
      anular(creado),
      anular(creado),
      anular(creado),
      admin.patch(`${urlLecturas(e.id)}/${l.id}/anular`).send({ motivo: "cruce" }),
    ]);
    expect(cruzadas.every((x) => x.status === 200 || x.status === 409)).toBe(true);
    expect(cruzadas.slice(0, 3).filter((x) => x.status === 200)).toHaveLength(1);
  });

  it("admin y operador escriben; Lectura solo mira; sin sesión o sin módulo no entra", async () => {
    const operador = await persona("operador");
    const lectura = await persona("lectura");
    const e = await equipoConPlan();
    const s = await registrar(e.id, {}, operador);
    for (const url of [P, `${P}/equipos/${e.id}/servicios`, urlLecturas(e.id)]) {
      expect((await lectura.get(url)).status, url).toBe(200);
      expect((await request(app).get(url)).status, url).toBe(401);
    }
    expect((await lectura.post(`${P}/servicios`).send(servicio(e.id))).status).toBe(403);
    expect((await lectura.post(urlLecturas(e.id)).send({ valor: 2000 })).status).toBe(403);
    expect((await anular(s.id, lectura)).status).toBe(403);
    const [l] = await lecturas(e.id);
    const r = await lectura.patch(`${urlLecturas(e.id)}/${l.id}/anular`).send({ motivo: "motivo" });
    expect(r.status).toBe(403);
    expect((await anular(s.id, operador)).status).toBe(200);

    const sin = await nueva(["documentos"]);
    expect((await (await entrar(sin)).get(P)).status).toBe(403);
  });

  it("otra empresa no ve ni toca equipos, servicios ni lecturas", async () => {
    const e = await equipoConPlan();
    const s = await registrar(e.id);
    const [l] = await lecturas(e.id);
    const respuestas = [
      await adminB.get(`${P}/equipos/${e.id}/servicios`),
      await adminB.get(urlLecturas(e.id)),
      await adminB.post(urlLecturas(e.id)).send({ valor: 5000 }),
      await adminB.post(`${P}/servicios`).send(servicio(e.id, { lectura: 5000 })),
      await anular(s.id, adminB),
      await adminB.patch(`${urlLecturas(e.id)}/${l.id}/anular`).send({ motivo: "motivo" }),
    ];
    expect(respuestas.map((x) => x.status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect((await resumen(adminB)).equipos.map((f) => f.equipo_id)).not.toContain(e.id);
    expect(await vigentes(e.id)).toEqual([1000]);
  });

  it("sin cupo de lecturas no se guarda nada, y se avisa sin error de servidor", async () => {
    const c = await nueva();
    const ag = await entrar(c);
    const e = await equipoConPlan({}, ag);
    await fijarCuotaTenant(c.tenant.id, "equipo_lecturas", 0, "prueba");
    const r = await ag.post(`${P}/servicios`).send(servicio(e.id));
    expect(r.status).toBe(403);
    expect((await ag.post(urlLecturas(e.id)).send({ valor: 5 })).status).toBe(403);
    expect((await ag.get(`${P}/equipos/${e.id}/servicios`)).body.servicios).toEqual([]);
  });

  it("la auditoría guarda ids (y el motivo al anular); lo rechazado no deja rastro", async () => {
    const c = await nueva();
    const ag = await entrar(c);
    const e = await equipoConPlan({}, ag);
    const pedido = servicio(e.id, { observacion: "secreto" });
    const s = await ag.post(`${P}/servicios`).send(pedido);
    await ag.post(`${P}/servicios`).send(pedido);
    await ag.post(`${P}/servicios`).send({});
    const l = await ag.post(urlLecturas(e.id)).send({ valor: 1100 });
    await ag.patch(`${urlLecturas(e.id)}/${l.body.id}/anular`).send({ motivo: "Mal" });
    await anular(s.body.id, ag, "Error");
    await anular(s.body.id, ag, "Error");
    const r = await pool.query(
      `SELECT accion, detalle FROM platform_audit_log
        WHERE tenant_id = $1 AND (accion LIKE 'mantenimiento.servicio%'
          OR accion LIKE 'mantenimiento.lectura%') ORDER BY id`,
      [c.tenant.id]
    );
    expect(r.rows).toEqual([
      {
        accion: "mantenimiento.servicio_registrar",
        detalle: { servicioId: s.body.id, equipoId: e.id },
      },
      {
        accion: "mantenimiento.lectura_registrar",
        detalle: { equipoId: e.id, lecturaId: l.body.id },
      },
      {
        accion: "mantenimiento.lectura_anular",
        detalle: { equipoId: e.id, lecturaId: l.body.id, motivo: "Mal" },
      },
      {
        accion: "mantenimiento.servicio_anular",
        detalle: { servicioId: s.body.id, motivo: "Error" },
      },
    ]);
  });

  it("al clonar el respaldo, el servicio apunta al equipo y a la lectura copiados", async () => {
    const origen = await nueva();
    const ag = await entrar(origen);
    const e = await equipoConPlan({}, ag);
    await registrar(e.id, {}, ag);
    const anulado = await registrar(
      e.id,
      { nivel: 2, lectura: 1100, hecho_en: "2026-02-10T12:00:00Z" },
      ag
    );
    await anular(anulado.id, ag);
    const destino = await nueva();
    const backup = await request(app)
      .post(`/api/platform/tenants/${origen.tenant.id}/backups`)
      .set("Authorization", BEARER);
    expect(backup.status, JSON.stringify(backup.body)).toBe(201);
    const restaurado = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.tenant.id, confirmar: true });
    expect(restaurado.status, JSON.stringify(restaurado.body)).toBe(200);
    const copia = await withTenant(destino.tenant.id, (c) =>
      c.query(
        `SELECT e.placa_codigo, s.nivel, l.valor::float8 AS valor, l.equipo_id = e.id AS mismo,
                s.anulado_en IS NOT NULL AS anulado
           FROM mantenimiento_servicios s
           JOIN equipos e ON e.id = s.equipo_id AND e.tenant_id = s.tenant_id
           JOIN equipo_lecturas l ON l.id = s.lectura_id AND l.tenant_id = s.tenant_id
          ORDER BY s.nivel`
      )
    );
    expect(copia.rows).toEqual([
      { placa_codigo: e.placa, nivel: 1, valor: 1000, mismo: true, anulado: false },
      { placa_codigo: e.placa, nivel: 2, valor: 1100, mismo: true, anulado: true },
    ]);
  });

  it("si desde Flota se anula la lectura de un servicio, ese servicio deja de contar", async () => {
    const c = await nueva(["mantenimiento", "flota"]);
    const ag = await entrar(c);
    const e = await equipoConPlan({}, ag);
    await registrar(e.id, {}, ag);
    const segundo = { nivel: 2, lectura: 1250, hecho_en: "2026-02-10T12:00:00Z" };
    const malo = await registrar(e.id, segundo, ag);
    const [l] = (await lecturas(e.id, ag)).filter((x) => x.valor === 1250);
    const r = await ag
      .post(`/api/erp/equipos/${e.id}/lecturas/${l.id}/anular`)
      .send({ motivo: "Desde Flota" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const ver = async () => (await resumen(ag)).equipos.find((x) => x.equipo_id === e.id)!;
    // Vuelve a mandar el anterior.
    expect(await ver()).toMatchObject({ lectura: 1000, ultimo: { nivel: 1, lectura: 1000 } });
    expect((await ver()).proximo).toMatchObject({ nivel: 2, en_lectura: 1250 });
    const historial = (await ag.get(`${P}/equipos/${e.id}/servicios`)).body.servicios;
    expect(
      historial.map((s: { lectura: number; lectura_anulada: boolean }) => [
        s.lectura,
        s.lectura_anulada,
      ])
    ).toEqual([
      [1250, true],
      [1000, false],
    ]);
    // El mismo servicio se puede anotar de nuevo, y el que quedó sin lectura se puede anular.
    await registrar(e.id, segundo, ag);
    expect((await ver()).proximo).toMatchObject({ nivel: 1, en_lectura: 1500 });
    expect((await anular(malo.id, ag)).status).toBe(200);
  });

  it("si era su único servicio, el equipo queda sin datos", async () => {
    const e = await equipoConPlan();
    await registrar(e.id);
    await withTenant(a.tenant.id, (c) =>
      c.query(
        `UPDATE equipo_lecturas SET anulada_en = now(), motivo_anulacion = 'error'
          WHERE equipo_id = $1`,
        [e.id]
      )
    );
    expect(await fila(e.id)).toMatchObject({
      estado: "sin_datos",
      motivo: "sin_servicio",
      ultimo: null,
    });
  });

  it("el reintento de una lectura responde aunque el equipo se haya quitado después", async () => {
    const e = await equipoConPlan();
    const pedido = { valor: 100, cliente_uuid: randomUUID() };
    expect((await admin.post(urlLecturas(e.id)).send(pedido)).status).toBe(201);
    await admin.patch(`${R}/equipos/${e.id}/quitar`).send({ motivo: "Baja" });
    expect((await admin.post(urlLecturas(e.id)).send(pedido)).status).toBe(200);
  });

  it("el medidor solo se define si el dato llega a guardarse", async () => {
    const sin = await admin.post(`${R}/equipos`).send({ placa_codigo: "NM-1", tipo: "Sin plan M" });
    await withTenant(a.tenant.id, (c) =>
      c.query("UPDATE equipos SET tipo_medidor = NULL WHERE id = $1", [sin.body.id])
    );
    expect((await admin.post(`${P}/servicios`).send(servicio(sin.body.id))).status).toBe(409);
    const r = await withTenant(a.tenant.id, (c) =>
      c.query("SELECT tipo_medidor FROM equipos WHERE id = $1", [sin.body.id])
    );
    expect(r.rows[0].tipo_medidor).toBeNull();
  });
});
