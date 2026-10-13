/** tests/combustible-resumen-diario-alertas.test.ts
 *
 * Entrega 2 de la Bandeja: el resumen diario por correo de las 7:00 de Lima
 * (src/server/services/combustibleResumenAlertas.worker.ts).
 *
 * Método de siempre: cada "no le llegó" va con su GEMELO "sí le llegó", en el
 * mismo tenant y la misma corrida -- un "no" solo podría ser que el envío
 * entero esté roto.
 *
 *  - cada persona recibe los números de SUS grifos, igual que en su Bandeja;
 *  - quien solo tiene alertas "solo en el ERP" no recibe nada;
 *  - una vez por día: la segunda corrida del mismo día no manda nada;
 *  - antes de las 7:00 no sale, ni reclama el día;
 *  - el día siguiente cuenta "lo nuevo" desde el envío anterior: lo de ayer no
 *    vuelve como nuevo, pero sí como "sin resolver".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";
import { CombustibleService } from "../src/modules/combustible/combustible.service";
import {
  correrResumenDiario,
  correrResumenDiarioCoordinado,
  diaYHoraEnLima,
} from "../src/server/services/combustibleResumenAlertas.worker";

const correos = vi.hoisted(
  () => [] as { destinatarios: { email: string }[]; asunto: string; lineas: string[] }[]
);
vi.mock("../src/server/shared/utils/alertaMailer", () => ({
  enviarCorreoAlerta: vi.fn(
    async (a: { destinatarios: { email: string }[]; asunto: string; lineas: string[] }) => {
      correos.push({ destinatarios: a.destinatarios, asunto: a.asunto, lineas: a.lineas });
    }
  ),
}));

const PASSWORD = "ClaveDePrueba123";
const service = new CombustibleService();

afterAll(async () => {
  await closeDatabase();
});

/** Un instante de "hoy" a partir de las 7:00 de Lima y POSTERIOR a las alertas
 *  recién creadas: si en Lima todavía no son las 7, las 7:05 de hoy (que es
 *  futuro); si ya pasaron, dentro de un segundo. */
function momentoDeResumen(): Date {
  const ahora = new Date(Date.now() + 1000);
  const { fecha, hora } = diaYHoraEnLima(ahora);
  return hora >= 7 ? ahora : new Date(`${fecha}T07:05:00-05:00`);
}

const masUnDia = (fecha: string) =>
  new Date(new Date(`${fecha}T12:00:00Z`).getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);

describe("combustible: resumen diario de alertas por correo", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  const tanques: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };
  const jefes: Record<"A" | "B" | "C" | "Todo", string> = { A: "", B: "", C: "", Todo: "" };

  async function persona(nombre: string, grifos?: number[]) {
    const email = `${nombre}-${slug}@test.local`.toLowerCase();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre, email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    const id = alta.body.id as string;
    const actuales = (await admin.get(`/api/erp/usuarios/${id}/permisos`)).body as {
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
      alertasCorreo: { modulo: string; recibeAlertas: boolean }[];
    };
    const r = await admin.put(`/api/erp/usuarios/${id}/permisos`).send({
      modulos: actuales.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.modulo === "combustible" ? true : m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: actuales.alertasCorreo.map((a) => ({
        modulo: a.modulo,
        recibeAlertas: a.modulo === "combustible" ? true : a.recibeAlertas,
      })),
      alcanceCombustible: grifos
        ? { todo: false, sedes: [], surtidores: [], grifos }
        : { todo: true, sedes: [], grifos: [], surtidores: [] },
      motivo: "prueba automatizada: resumen diario",
    });
    expect(r.status).toBe(200);
    return email;
  }

  async function tanque(grifo: number) {
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
    });
    expect(r.status).toBe(201);
    return r.body.id as number;
  }

  const alerta = (tipo: string, combustibleId: number) =>
    withTenant(tenantId, (client) =>
      service.crearAlertas(client, tenantId, [
        { tipo, combustibleId, detalle: { prueba: true } } as never,
      ])
    );

  const correoDe = (email: string) =>
    correos.filter((c) => c.destinatarios.some((d) => d.email === email));
  const texto = (email: string) => correoDe(email)[0]?.lineas.join("\n") ?? "";

  let primerMomento: Date;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    const sesion = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password: PASSWORD });
    expect(sesion.status).toBe(200);

    const sedes = (await admin.get("/api/erp/sedes")).body.sedes;
    const grifoA = sedes[0].grifos[0].id as number;
    const nuevoGrifo = async (nombre: string) =>
      (await admin.post("/api/erp/administracion/grifos").send({ sede_id: sedes[0].id, nombre }))
        .body.id as number;
    const grifoB = await nuevoGrifo("Punto B");
    const grifoC = await nuevoGrifo("Punto C");
    tanques.A = await tanque(grifoA);
    tanques.B = await tanque(grifoB);
    tanques.C = await tanque(grifoC);

    jefes.A = await persona("jefeA", [grifoA]);
    jefes.B = await persona("jefeB", [grifoB]);
    jefes.C = await persona("jefeC", [grifoC]);
    jefes.Todo = await persona("jefeTodo");

    // Grifo A: una que espera al resumen, una grave (ya avisada al momento) y
    // una sin resolver desde hace 3 días.
    await alerta("descuadre_ciclo", tanques.A);
    await alerta("nivel_bajo", tanques.A);
    const [vieja] = await alerta("tanque_sin_medir", tanques.A);
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE combustible_alertas SET creado_en = now() - interval '3 days' WHERE id = $1`,
        [vieja.id]
      )
    );
    // Grifo B: otra que espera al resumen.
    await alerta("descuadre_ventana", tanques.B);
    // Grifo C: solo una informativa ("solo en el ERP").
    await alerta("historial_sin_contrastar", tanques.C);

    primerMomento = momentoDeResumen();
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  beforeEach(() => {
    correos.length = 0;
  });

  it("cada persona recibe los números de SUS grifos, en un correo propio", async () => {
    const r = await correrResumenDiario({ ahora: primerMomento, soloTenantId: tenantId });
    expect(r.correos).toBe(3);
    // Uno por persona: cada uno tiene sus números.
    for (const c of correos) expect(c.destinatarios).toHaveLength(1);

    // Grifo A: su resumen, sin lo de B.
    const a = texto(jefes.A);
    expect(a).toContain("• Descuadre acumulado del ciclo: 1");
    expect(a).not.toContain("ventana");
    expect(a).toContain("Además hubo 1 alerta(s) grave(s)");
    expect(a).toContain("Llevan más de 2 días sin resolver: 1");
    expect(a).toContain("• Tanque sin medir: 1");

    // Grifo B: el gemelo al revés.
    const b = texto(jefes.B);
    expect(b).toContain("• Descuadre acumulado en la ventana: 1");
    expect(b).not.toContain("ciclo");
    expect(b).not.toContain("Tanque sin medir");

    // Quien ve todo, ve las dos.
    const todo = texto(jefes.Todo);
    expect(todo).toContain("• Descuadre acumulado del ciclo: 1");
    expect(todo).toContain("• Descuadre acumulado en la ventana: 1");

    // Grifo C solo tiene una informativa: no se le escribe.
    expect(correoDe(jefes.C)).toHaveLength(0);
  });

  it("DOS corridas simultáneas por la ruta del worker mandan el resumen UNA vez", async () => {
    // La ruta real (lock + fila de 0127), no la variante de tests: en
    // producción pueden llegar a la vez dos instancias, o dos pasadas.
    // Pasado mañana: ese día todavía no se reclamó y las alertas ya existen
    // (siguen sin resolver), así que a los tres les toca su correo.
    const pasadoManana = new Date(
      `${masUnDia(masUnDia(diaYHoraEnLima(primerMomento).fecha))}T07:00:00-05:00`
    );
    const [x, y] = await Promise.all([
      correrResumenDiarioCoordinado({ ahora: pasadoManana, soloTenantId: tenantId }),
      correrResumenDiarioCoordinado({ ahora: pasadoManana, soloTenantId: tenantId }),
    ]);
    expect(x.correos + y.correos).toBe(3);
    expect(correos).toHaveLength(3);
    // Y el alcance también rige por esta ruta.
    expect(correoDe(jefes.C)).toHaveLength(0);
    expect(texto(jefes.B)).not.toContain("Descuadre acumulado del ciclo");
  });

  it("una sola vez por día: la segunda corrida del mismo día no manda nada", async () => {
    const r = await correrResumenDiario({
      // Misma fecha de Lima aunque se corra tarde: pasada la medianoche sería
      // otro día, y "no manda nada" se cumpliría sin probar nada.
      ahora: new Date(
        Math.min(
          primerMomento.getTime() + 30 * 60_000,
          new Date(`${diaYHoraEnLima(primerMomento).fecha}T23:59:59-05:00`).getTime()
        )
      ),
      soloTenantId: tenantId,
    });
    expect(r.correos).toBe(0);
    expect(correos).toHaveLength(0);
  });

  it("al día siguiente: antes de las 7 no sale; a las 7, lo de ayer ya no es nuevo pero sigue sin resolver", async () => {
    const manana = masUnDia(diaYHoraEnLima(primerMomento).fecha);

    const temprano = await correrResumenDiario({
      ahora: new Date(`${manana}T06:59:00-05:00`),
      soloTenantId: tenantId,
    });
    expect(temprano.correos).toBe(0);

    // El gemelo: a las 7:00 sí sale (y prueba que las 6:59 no reclamaron el día).
    const siete = await correrResumenDiario({
      ahora: new Date(`${manana}T07:00:00-05:00`),
      soloTenantId: tenantId,
    });
    expect(siete.correos).toBe(3);

    const a = texto(jefes.A);
    expect(a).toContain("No hubo alertas nuevas para revisar desde el resumen anterior.");
    expect(a).not.toContain("Además hubo");
    expect(a).toContain("Sin resolver en total: 3");
    expect(correoDe(jefes.C)).toHaveLength(0);
  });
});

describe("combustible: resumen diario cuando todavía nadie está marcado", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(PASSWORD);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    const sesion = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password: PASSWORD });
    expect(sesion.status).toBe(200);
    const tanque = await admin.post("/api/erp/combustible").send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "L",
      tipo_punto: "fijo",
      capacidad_total: 20000,
      nivel_actual: 10000,
      requiere_documento: false,
      modo_vigilancia: "sin_vigilar",
    });
    expect(tanque.status).toBe(201);
    await withTenant(tenantId, (client) =>
      service.crearAlertas(client, tenantId, [
        { tipo: "descuadre_ciclo", combustibleId: tanque.body.id, detalle: {} } as never,
      ])
    );
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  beforeEach(() => {
    correos.length = 0;
  });

  it("sin destinatarios a las 7:00 no se quema el día: si alguien se marca a las 9:00, sale", async () => {
    // Horas explícitas de Lima, no "ahora + 2 h": con el reloj después de las
    // 22:00 eso caía al día siguiente antes de las 7:00 y el test fallaba.
    const dia = masUnDia(diaYHoraEnLima(momentoDeResumen()).fecha);
    const alas7 = new Date(`${dia}T07:00:00-05:00`);
    const r1 = await correrResumenDiario({ ahora: alas7, soloTenantId: tenantId });
    expect(r1.correos).toBe(0);

    const email = `jefe-tarde-${slug}@test.local`.toLowerCase();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "Jefe tarde", email, password: PASSWORD, rol: "operador" });
    expect(alta.status).toBe(201);
    const p = (await admin.get(`/api/erp/usuarios/${alta.body.id}/permisos`)).body as {
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
      alertasCorreo: { modulo: string }[];
    };
    const marcar = await admin.put(`/api/erp/usuarios/${alta.body.id}/permisos`).send({
      modulos: p.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.modulo === "combustible" ? true : m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: p.alertasCorreo.map((a) => ({
        modulo: a.modulo,
        recibeAlertas: a.modulo === "combustible",
      })),
      motivo: "prueba automatizada: marcarse después de las 7:00",
    });
    expect(marcar.status).toBe(200);

    // Mismo día, un poco después: ahora sí hay a quién mandarle.
    const r2 = await correrResumenDiario({
      ahora: new Date(`${dia}T09:00:00-05:00`),
      soloTenantId: tenantId,
    });
    expect(r2.correos).toBe(1);
    expect(correos[0].destinatarios[0].email).toBe(email);
  });
});
