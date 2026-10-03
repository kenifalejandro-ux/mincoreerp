/** tests/alertas-correo-por-modulo.test.ts
 *
 * A quién se le avisa por correo, por módulo (migración 0107).
 *
 * Antes de esto "destinatario" no era un dato: se deducía de ser
 * administrador. Lo que se fija acá es justamente que esa deducción YA NO
 * EXISTE, en las dos direcciones -- porque las dos son formas de que una
 * alerta deje de servir:
 *
 *   - un administrador sin la marca NO recibe nada (antes recibía todo, y
 *     terminaba filtrando los correos a una carpeta);
 *   - alguien que no administra nada SÍ recibe si está marcado (el jefe de
 *     planta que mira los tanques todo el día).
 *
 * Y los dos casos en que una marca puesta no alcanza, que son los que se
 * escapan solos: quien perdió el módulo, y quien no tiene correo porque entra
 * con DNI (0084). Si esos dos fallaran, el síntoma sería silencio -- nadie se
 * enteraría de que nadie se enteró.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";
import {
  findDestinatariosAlertas,
  modulosSinDestinatarios,
} from "../src/server/shared/utils/destinatariosAlertas";

const PASSWORD = "ClaveDePrueba123";

describe("alertas por correo: el destinatario es una marca, no un rol", () => {
  let empresa: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  let admin: ReturnType<typeof request.agent>;
  /** Gente de oficina con correo, a la que se le mueven las marcas. */
  let jefeId: string;
  let jefeEmail: string;
  /** Personal de cancha: entra con DNI y no tiene correo (0084). */
  let grifieroId: string;

  const permisos = async (usuarioId: string) => {
    const res = await admin.get(`/api/erp/usuarios/${usuarioId}/permisos`);
    expect(res.status).toBe(200);
    return res.body as {
      rol: string;
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
      alertasCorreo: { modulo: string; recibeAlertas: boolean }[];
      modulosSinDestinatarios: string[];
    };
  };

  /** Manda el estado completo, como la pantalla: módulos tal cual están
   *  (salvo los que se pisen) y las alertas que se indiquen. */
  const guardar = async (
    usuarioId: string,
    cambios: {
      alertas?: Record<string, boolean>;
      modulos?: Record<string, { asignado: boolean; nivel?: string }>;
    }
  ) => {
    const actuales = await permisos(usuarioId);
    return admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
      modulos: actuales.modulos.map((m) => {
        const pisa = cambios.modulos?.[m.modulo];
        return {
          modulo: m.modulo,
          asignado: pisa ? pisa.asignado : m.asignado,
          nivel: pisa?.nivel ?? m.nivel,
        };
      }),
      alertasCorreo: actuales.alertasCorreo.map((a) => ({
        modulo: a.modulo,
        recibeAlertas: cambios.alertas?.[a.modulo] ?? a.recibeAlertas,
      })),
      motivo: "prueba automatizada",
    });
  };

  /** La consulta que de verdad usan las rutas y el worker para armar el `to`
   *  del correo. Se prueba esta y no un endpoint: es la que decide si alguien
   *  se entera o no. */
  const destinatarios = (modulo = "combustible") =>
    withTenant(empresa.tenant.id, (client) =>
      findDestinatariosAlertas(client, empresa.tenant.id, modulo)
    );

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    admin = request.agent(app);
    const sesion = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, email: empresa.usuario.email, password: PASSWORD });
    expect(sesion.status).toBe(200);

    jefeEmail = `jefe-${empresa.tenant.slug}@test.local`;
    const altaJefe = await admin.post("/api/erp/usuarios").send({
      nombre: "Jefe de planta",
      email: jefeEmail,
      password: PASSWORD,
      rol: "operador",
    });
    expect(altaJefe.status).toBe(201);
    jefeId = altaJefe.body.id;

    const altaGrifero = await admin.post("/api/erp/usuarios").send({
      nombre: "Grifero de cancha",
      dni: "81999001",
      password: PASSWORD,
      rol: "grifero",
    });
    expect(altaGrifero.status).toBe(201);
    grifieroId = altaGrifero.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(empresa.tenant.id);
    await closeDatabase();
  });

  // ── 1. El default: sin marca no se avisa ──────────────────────────────

  it("una empresa nueva arranca sin destinatarios, ni siquiera el administrador", async () => {
    // Esto es el cambio de fondo. El admin tiene el módulo y antes habría
    // recibido todo por ser admin; ahora no hay fila, así que no recibe.
    // El default implícito es exactamente lo que 0107 vino a sacar.
    expect(await destinatarios()).toEqual([]);

    const vista = await permisos(jefeId);
    expect(vista.alertasCorreo.find((a) => a.modulo === "combustible")?.recibeAlertas).toBe(false);
  });

  it("avisa en pantalla que un módulo habilitado quedó sin nadie mirándolo", async () => {
    const sinNadie = await withTenant(empresa.tenant.id, (client) =>
      modulosSinDestinatarios(client, empresa.tenant.id)
    );
    expect(sinNadie).toContain("combustible");
  });

  it("solo se ofrecen los módulos que de verdad mandan correos", async () => {
    // Una casilla "Recibe alertas" en Checklists o IPERC, que no envían nada,
    // sería una promesa falsa; y el aviso de "nadie lo recibe" sería una falsa
    // alarma permanente en toda empresa nueva.
    const vista = await permisos(jefeId);
    expect(vista.alertasCorreo.map((a) => a.modulo)).toEqual(["combustible"]);
    expect(vista.modulosSinDestinatarios).toEqual(["combustible"]);
  });

  it("marcar un módulo que no envía correos se ignora", async () => {
    // El GET se resuelve ANTES del .send(): anidar un request del mismo agent
    // adentro de otro lo rompe con ECONNREFUSED (ver a4be70f y cd4d9f8).
    const actuales = await permisos(jefeId);
    const res = await admin.put(`/api/erp/usuarios/${jefeId}/permisos`).send({
      modulos: actuales.modulos.map((m) => ({
        modulo: m.modulo,
        asignado: m.asignado,
        nivel: m.nivel,
      })),
      alertasCorreo: [{ modulo: "checklists", recibeAlertas: true }],
      motivo: "prueba automatizada",
    });
    expect(res.status).toBe(200);

    const filas = await withTenant(empresa.tenant.id, (client) =>
      client.query(`SELECT 1 FROM usuario_alertas_correo WHERE usuario_id = $1`, [jefeId])
    );
    expect(filas.rowCount).toBe(0);
  });

  // ── 2. La marca, independiente del rol ────────────────────────────────

  it("alguien que no administra nada recibe las alertas si está marcado", async () => {
    const res = await guardar(jefeId, { alertas: { combustible: true } });
    expect(res.status).toBe(200);

    const lista = await destinatarios();
    expect(lista.map((d) => d.id)).toEqual([jefeId]);
    expect(lista[0].email).toBe(jefeEmail);

    // Y el módulo deja de estar sin vigilancia.
    const sinNadie = await withTenant(empresa.tenant.id, (client) =>
      modulosSinDestinatarios(client, empresa.tenant.id)
    );
    expect(sinNadie).not.toContain("combustible");
  });

  it("la marca sobrevive a un cambio de nivel: mirar no es operar", async () => {
    // Un perfil en "Consultas" puede recibir avisos -- recibir un correo no
    // es escribir nada.
    const res = await guardar(jefeId, {
      modulos: { combustible: { asignado: true, nivel: "consultas" } },
    });
    expect(res.status).toBe(200);

    expect((await destinatarios()).map((d) => d.id)).toEqual([jefeId]);
  });

  it("destildar la casilla lo saca de la lista", async () => {
    expect((await guardar(jefeId, { alertas: { combustible: false } })).status).toBe(200);
    expect(await destinatarios()).toEqual([]);

    // Y vuelve a entrar al tildarla: la marca es un interruptor, no algo que
    // se gaste.
    expect((await guardar(jefeId, { alertas: { combustible: true } })).status).toBe(200);
    expect((await destinatarios()).map((d) => d.id)).toEqual([jefeId]);
  });

  // ── 3. Los dos casos donde una marca puesta NO alcanza ────────────────

  it("quitarle el módulo le borra la marca, y no revive al devolvérselo", async () => {
    // Si la fila sobreviviera, reasignarle el módulo meses después lo pondría
    // a recibir correos de nuevo sin que nadie lo decida -- el mismo problema
    // que 0100 ya evitó con el alcance.
    expect((await guardar(jefeId, { modulos: { combustible: { asignado: false } } })).status).toBe(
      200
    );
    expect(await destinatarios()).toEqual([]);

    expect((await guardar(jefeId, { modulos: { combustible: { asignado: true } } })).status).toBe(
      200
    );
    expect(await destinatarios()).toEqual([]);

    const vista = await permisos(jefeId);
    expect(vista.alertasCorreo.find((a) => a.modulo === "combustible")?.recibeAlertas).toBe(false);
  });

  it("a quien entra con DNI y no tiene correo no se lo cuenta como destinatario", async () => {
    // Sin este filtro, nodemailer recibiría un `to` nulo y se caería el envío
    // ENTERO: una sola persona mal configurada dejaría sin aviso a todos los
    // demás de la lista.
    expect((await guardar(grifieroId, { alertas: { combustible: true } })).status).toBe(200);

    const lista = await destinatarios();
    expect(lista.map((d) => d.id)).not.toContain(grifieroId);
    expect(lista.every((d) => d.email)).toBe(true);
  });

  it("a un usuario desactivado no se le manda nada", async () => {
    expect((await guardar(jefeId, { alertas: { combustible: true } })).status).toBe(200);
    expect((await destinatarios()).map((d) => d.id)).toEqual([jefeId]);

    const baja = await admin
      .patch(`/api/erp/usuarios/${jefeId}/estado`)
      .send({ estado: "inactivo", motivo: "prueba automatizada" });
    expect(baja.status).toBe(200);

    expect(await destinatarios()).toEqual([]);
  });

  // ── 4. Quién puede cambiarlo ──────────────────────────────────────────

  it("un operador no puede tocar los destinatarios de nadie", async () => {
    // Elegir quién se entera de los descuadres es una decisión de control
    // interno: si la pudiera cambiar quien opera el módulo, podría dejarse
    // sin testigos antes de cargar algo.
    const reactivar = await admin
      .patch(`/api/erp/usuarios/${jefeId}/estado`)
      .send({ estado: "activo" });
    expect(reactivar.status).toBe(200);

    const operador = request.agent(app);
    const sesion = await operador
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, email: jefeEmail, password: PASSWORD });
    expect(sesion.status).toBe(200);

    const intento = await operador.put(`/api/erp/usuarios/${jefeId}/permisos`).send({
      modulos: [],
      alertasCorreo: [{ modulo: "combustible", recibeAlertas: true }],
      motivo: "no debería poder",
    });
    expect(intento.status).toBe(403);
  });

  it("no se puede marcar un módulo que la persona no tiene", async () => {
    // Enterarse por correo de un módulo al que no se puede entrar no es un
    // permiso que exista: el servidor lo ignora en silencio, igual que hace
    // con un módulo que la empresa no contrató.
    const res = await guardar(jefeId, {
      modulos: { combustible: { asignado: false } },
      alertas: { combustible: true },
    });
    expect(res.status).toBe(200);
    expect(await destinatarios()).toEqual([]);
  });
});
