/** tests/eventos-por-modulo.test.ts
 *
 * El stream de tiempo real manda a cada persona solo los eventos de los módulos que tiene
 * (src/server/shared/utils/eventosPorModulo.ts). Una empresa que contrató pocos módulos no ve el
 * movimiento de los demás. Lo que se fija:
 *
 * 1. La tabla de dueños: el prefijo manda, con dos desvíos (`equipos.*` es de Flota y
 *    `combustible.viaje_actualizado` es de Viajes); un tipo desconocido pasa.
 * 2. Guardián estático: todo evento que el servidor publica tiene un prefijo que está en la tabla
 *    (si alguien publica un módulo nuevo sin registrarlo, falla acá, no en producción).
 * 3. En el stream de una empresa solo con Flota y Viajes: llegan los eventos de Viajes (incluido
 *    `combustible.viaje_actualizado`, que lleva prefijo de Combustible) y de Flota, NO los de
 *    Combustible ni Repuestos; un tipo desconocido pasa.
 * 4. Una empresa con todos los módulos recibe todo, como siempre.
 * 5. La reposición por Last-Event-ID aplica el mismo filtro que el vivo.
 * 6. Se compone con el alcance de Combustible: quien tiene el módulo pero ve solo algunas plantas
 *    recibe el aviso con el contenido vacío (no se descarta).
 */
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";
import { MODULOS } from "../src/modules/registry";
import { publicarEventoTenant } from "../src/server/services/realtimeEvents.service";
import {
  MODULO_POR_PREFIJO,
  debeRecibirEvento,
  moduloDelEvento,
} from "../src/server/shared/utils/eventosPorModulo";

const BEARER = `Bearer ${env.platformAdminToken}`;
const PASSWORD = "ClaveDePrueba123";

describe("eventos por módulo: la tabla de dueños", () => {
  it("el prefijo manda, con dos desvíos explícitos, y lo desconocido pasa", () => {
    expect(moduloDelEvento("repuestos.creado")).toBe("repuestos");
    expect(moduloDelEvento("combustible.despacho_creado")).toBe("combustible");
    expect(moduloDelEvento("ordenes_trabajo.creada")).toBe("ordenes_trabajo");
    // `equipos.*` es de Flota (el módulo se llamaba `equipos`).
    expect(moduloDelEvento("equipos.actualizado")).toBe("flota");
    // Lleva prefijo de Combustible pero es de Viajes.
    expect(moduloDelEvento("combustible.viaje_actualizado")).toBe("viajes");
    expect(moduloDelEvento("viajes.alertas_actualizadas")).toBe("viajes");
    // Un módulo que no conozco: sin dueño.
    expect(moduloDelEvento("modulo_nuevo.algo")).toBeUndefined();
  });

  it("debeRecibirEvento: solo con el módulo dueño; sin lista o sin dueño, pasa", () => {
    expect(debeRecibirEvento("repuestos.creado", ["repuestos"])).toBe(true);
    expect(debeRecibirEvento("repuestos.creado", ["checklists"])).toBe(false);
    // Viajes sin Combustible: sigue recibiendo la actualización de su viaje.
    expect(debeRecibirEvento("combustible.viaje_actualizado", ["flota", "viajes"])).toBe(true);
    // ...y Combustible sin Viajes no.
    expect(debeRecibirEvento("combustible.viaje_actualizado", ["combustible"])).toBe(false);
    expect(debeRecibirEvento("equipos.actualizado", ["flota"])).toBe(true);
    expect(debeRecibirEvento("equipos.actualizado", ["viajes"])).toBe(false);
    expect(debeRecibirEvento("modulo_nuevo.algo", [])).toBe(true);
    expect(debeRecibirEvento("repuestos.creado", undefined)).toBe(true);
  });

  it("guardián: todo evento que el servidor publica tiene un prefijo registrado en la tabla", () => {
    const archivos: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const ruta = join(dir, e.name);
        if (e.isDirectory()) recorrer(ruta);
        else if (e.name.endsWith(".ts")) archivos.push(ruta);
      }
    };
    recorrer(join(__dirname, "..", "src"));

    // `publicarEventoTenant(tenantId, "modulo.tipo", ...)` y las constantes `EVENTO... = "modulo.tipo"`.
    const literal = /publicarEventoTenant\(\s*[A-Za-z_.]+,\s*"([a-z_]+\.[a-z_]+)"/g;
    const constante = /\bEVENTO\w*\s*=\s*"([a-z_]+\.[a-z_]+)"/g;
    const sinDueno: string[] = [];
    let vistos = 0;
    for (const ruta of archivos) {
      const texto = readFileSync(ruta, "utf8");
      for (const re of [literal, constante]) {
        for (const m of texto.matchAll(re)) {
          vistos++;
          if (!(m[1].split(".")[0] in MODULO_POR_PREFIJO)) {
            sinDueno.push(`${ruta.slice(join(__dirname, "..").length + 1)}: ${m[1]}`);
          }
        }
      }
    }
    // Que el guardián de verdad lea algo (si el patrón dejara de coincidir, no probaría nada).
    expect(vistos).toBeGreaterThan(30);
    expect(
      sinDueno,
      `Estos eventos tienen un prefijo sin módulo dueño: regístralo en eventosPorModulo.ts\n${sinDueno.join("\n")}`
    ).toEqual([]);
  });
});

describe("eventos por módulo: el stream", () => {
  type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;
  const empresas: Empresa[] = [];
  let servidor: http.Server;
  let puerto: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      servidor = app.listen(0, () => {
        puerto = (servidor.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  /** Una empresa con exactamente esos módulos habilitados (`null` = todos, como nace). */
  const nueva = async (modulos: string[] | null) => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    if (modulos) {
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
    }
    return e;
  };

  /** Entra y devuelve la cookie (los módulos viajan en el JWT: se entra DESPUÉS de fijarlos). */
  const cookieDe = async (e: Empresa, email: string) => {
    const agente = request.agent(app);
    const login = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const setCookie = login.headers["set-cookie"];
    return (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((c) => c.split(";")[0])
      .join("; ");
  };

  /** Abre el stream y devuelve lo que llegue hasta el timeout (un SSE sano nunca termina). */
  const escuchar = (cookie: string, ms: number, cabeceras: Record<string, string> = {}) =>
    new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: puerto,
          path: "/api/eventos/stream",
          headers: { Cookie: cookie, "Accept-Encoding": "gzip, deflate, br", ...cabeceras },
        },
        (res) => {
          let recibido = "";
          res.on("data", (trozo) => {
            recibido += trozo.toString();
          });
          setTimeout(() => {
            req.destroy();
            resolve(recibido);
          }, ms);
        }
      );
      req.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
      });
      req.end();
    });
  // Un respiro para que la suscripción a Redis quede establecida antes de publicar.
  const respiro = () => new Promise((r) => setTimeout(r, 500));

  it("una empresa solo con Flota y Viajes recibe los eventos de Viajes y de Flota, no los de Combustible ni Repuestos", async () => {
    const e = await nueva(["flota", "viajes"]);
    const cookie = await cookieDe(e, e.usuario.email);

    const escucha = escuchar(cookie, 2500);
    await respiro();
    await publicarEventoTenant(e.tenant.id, "combustible.viaje_actualizado", { viajeId: 1 });
    await publicarEventoTenant(e.tenant.id, "viajes.alertas_actualizadas", {});
    await publicarEventoTenant(e.tenant.id, "equipos.actualizado", { equipoId: 1 });
    await publicarEventoTenant(e.tenant.id, "equipo.creado", { n: 1 }); // tipo sin dueño: pasa
    await publicarEventoTenant(e.tenant.id, "combustible.despacho_creado", { despachoId: 1 });
    await publicarEventoTenant(e.tenant.id, "combustible.alerta_creada", { tipo: "hueco" });
    await publicarEventoTenant(e.tenant.id, "repuestos.creado", { repuestoId: 1 });
    const recibido = await escucha;

    // El de Viajes con prefijo de Combustible SÍ llega: es de Viajes.
    expect(recibido).toContain("event: combustible.viaje_actualizado");
    expect(recibido).toContain("event: viajes.alertas_actualizadas");
    expect(recibido).toContain("event: equipos.actualizado");
    expect(recibido).toContain("event: equipo.creado");
    // Los de módulos que no tiene, no.
    expect(recibido).not.toContain("combustible.despacho_creado");
    expect(recibido).not.toContain("combustible.alerta_creada");
    expect(recibido).not.toContain("repuestos.creado");
  });

  it("una empresa con todos los módulos sigue recibiendo todo", async () => {
    const e = await nueva(null);
    const cookie = await cookieDe(e, e.usuario.email);

    const escucha = escuchar(cookie, 2500);
    await respiro();
    await publicarEventoTenant(e.tenant.id, "repuestos.creado", { repuestoId: 1 });
    await publicarEventoTenant(e.tenant.id, "combustible.despacho_creado", { despachoId: 1 });
    await publicarEventoTenant(e.tenant.id, "combustible.viaje_actualizado", { viajeId: 1 });
    await publicarEventoTenant(e.tenant.id, "ordenes_trabajo.creada", { ordenTrabajoId: 1 });
    const recibido = await escucha;

    for (const tipo of [
      "repuestos.creado",
      "combustible.despacho_creado",
      "combustible.viaje_actualizado",
      "ordenes_trabajo.creada",
    ]) {
      expect(recibido, tipo).toContain(`event: ${tipo}`);
    }
  });

  it("la reposición por Last-Event-ID aplica el mismo filtro que el vivo", async () => {
    const e = await nueva(["flota", "viajes"]);
    const cookie = await cookieDe(e, e.usuario.email);

    // Se publican ANTES de conectar: llegan por la reposición, no en vivo.
    const base = await publicarEventoTenant(e.tenant.id, "equipos.actualizado", { n: 0 });
    await publicarEventoTenant(e.tenant.id, "combustible.viaje_actualizado", { viajeId: 7 });
    await publicarEventoTenant(e.tenant.id, "repuestos.creado", { repuestoId: 7 });
    await publicarEventoTenant(e.tenant.id, "combustible.despacho_creado", { despachoId: 7 });
    expect(base?.id).toBeDefined();

    const recibido = await escuchar(cookie, 1500, { "Last-Event-ID": String(base!.id) });
    expect(recibido).toContain("event: combustible.viaje_actualizado");
    expect(recibido).not.toContain("repuestos.creado");
    expect(recibido).not.toContain("combustible.despacho_creado");
  });

  it("con el módulo pero con alcance restringido en Combustible, el aviso llega con el contenido vacío (no se descarta)", async () => {
    const e = await nueva(null);
    const admin = request.agent(app);
    const login = await admin
      .post("/api/auth/login")
      .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD });
    expect(login.status).toBe(200);

    const email = `${idUnico("op")}@test.local`;
    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Operador de una planta",
      email,
      password: PASSWORD,
      rol: "operador",
      dni: dniUnico(),
    });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    // Alcance «asignado» sin ninguna planta asignada: ve solo lo suyo (nada).
    // `usuarios` tiene RLS: sin el contexto de la empresa (withTenant) la consulta falla.
    await withTenant(e.tenant.id, (client) =>
      client.query(`UPDATE usuarios SET alcance_combustible = 'asignado' WHERE id = $1`, [
        alta.body.id,
      ])
    );
    const cookieOperador = await cookieDe(e, email);
    const cookieAdmin = await cookieDe(e, e.usuario.email);

    const escuchaOp = escuchar(cookieOperador, 2500);
    const escuchaAdmin = escuchar(cookieAdmin, 2500);
    await respiro();
    await publicarEventoTenant(e.tenant.id, "combustible.alerta_creada", {
      tipo: "descuadre_inventario",
      secreto: "SOLO-PARA-QUIEN-VE-TODO",
    });
    const [delOperador, delAdmin] = await Promise.all([escuchaOp, escuchaAdmin]);

    // El admin (alcance total) recibe el contenido.
    expect(delAdmin).toContain("event: combustible.alerta_creada");
    expect(delAdmin).toContain("SOLO-PARA-QUIEN-VE-TODO");
    // El operador con alcance restringido recibe el aviso SIN el contenido.
    expect(delOperador).toContain("event: combustible.alerta_creada");
    expect(delOperador).not.toContain("SOLO-PARA-QUIEN-VE-TODO");
  });
});
