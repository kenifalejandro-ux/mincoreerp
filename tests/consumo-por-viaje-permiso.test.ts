/** tests/consumo-por-viaje-permiso.test.ts
 *
 * "Consumo por viaje" pasó de ser una vista del Histórico (`historico:por_viaje`) a
 * una pestaña de Viajes con su permiso propio (`viajes:consumo`, migración 0167).
 * Lo que se fija:
 *
 * 1. Que la migración copie el permiso de cada persona sin cambiarlo (permitido y
 *    negado), sin pisar lo ya decidido, sin tocar otras pestañas y sin copiar el de
 *    un usuario que ya no existe.
 * 2. Que el servidor responda con el permiso nuevo: el administrador, el operador y
 *    Lectura lo ven por defecto; el conductor no; un permiso negado a mano bloquea
 *    combustible pero NO urea (esa va con `urea:vista`).
 * 3. Que la vista ya no exista en el Histórico.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";
import { PESTANAS_CONFIGURABLES } from "../src/server/services/permisosPestanas.service";

const PASSWORD = "ClaveDePrueba123";
const SQL = fs.readFileSync(
  path.resolve(__dirname, "../migrations/0167_permiso_consumo_por_viaje.sql"),
  "utf-8"
);

type Empresa = Awaited<ReturnType<typeof crearTenantDePrueba>>;

describe("Consumo por viaje dentro de Viajes", () => {
  const empresas: Empresa[] = [];
  const nueva = async () => {
    const e = await crearTenantDePrueba(PASSWORD);
    empresas.push(e);
    return e;
  };
  afterAll(async () => {
    for (const e of empresas) await borrarTenantDePrueba(e.tenant.id);
    await closeDatabase();
  });

  describe("la migración 0167", () => {
    /** Corre el SQL real sobre copias TEMPORALES de las tablas (ver el comentario de
     *  `conTraspaso` en tests/flota-viajes-modulos.test.ts): la suite corre en paralelo y
     *  la migración recorre todas las filas de la base. */
    async function conMigracion<T>(
      filas: { usuario: string; pestana: string; permitido: boolean }[],
      existentes: string[],
      leer: (c: import("pg").PoolClient) => Promise<T>,
      pasadas = 1
    ): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL lock_timeout = '10s'");
        await c.query(
          `CREATE TEMP TABLE usuario_permisos_pestana (LIKE public.usuario_permisos_pestana INCLUDING ALL) ON COMMIT DROP`
        );
        await c.query(`CREATE TEMP TABLE usuarios (id uuid PRIMARY KEY) ON COMMIT DROP`);
        const tenant = randomUUID();
        for (const f of filas) {
          await c.query(
            `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
             VALUES ($1, $2, 'combustible', $3, $4)`,
            [tenant, f.usuario, f.pestana, f.permitido]
          );
        }
        for (const u of existentes) await c.query(`INSERT INTO usuarios (id) VALUES ($1)`, [u]);
        for (let i = 0; i < pasadas; i++) await c.query(SQL);
        return await leer(c);
      } finally {
        await c.query("ROLLBACK").catch(() => {});
        c.release();
      }
    }
    const leerTodo = async (c: import("pg").PoolClient) =>
      (
        await c.query(
          `SELECT usuario_id::text AS u, modulo, pestana, permitido
             FROM usuario_permisos_pestana ORDER BY usuario_id::text, pestana`
        )
      ).rows;

    const [a, b, c2, fantasma] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    it("copia el permiso (permitido y negado) a `viajes:consumo`, sin tocar lo demás ni a los usuarios que ya no existen", async () => {
      const filas = await conMigracion(
        [
          { usuario: a, pestana: "historico:por_viaje", permitido: true },
          { usuario: b, pestana: "historico:por_viaje", permitido: false },
          { usuario: c2, pestana: "historico:por_conductor", permitido: true },
          { usuario: fantasma, pestana: "historico:por_viaje", permitido: true },
        ],
        [a, b, c2],
        leerTodo
      );
      const de = (u: string, p: string) =>
        filas.find((f) => f.u === u && f.pestana === p)?.permitido;
      expect(de(a, "viajes:consumo")).toBe(true);
      expect(de(b, "viajes:consumo")).toBe(false);
      // Las otras pestañas no se tocan y no se inventa nada para quien no tenía el permiso.
      expect(filas.some((f) => f.u === c2 && f.pestana === "viajes:consumo")).toBe(false);
      expect(de(c2, "historico:por_conductor")).toBe(true);
      // El usuario que ya no existe no recibe nada (la clave foránea real lo rechazaría).
      expect(filas.some((f) => f.u === fantasma && f.pestana === "viajes:consumo")).toBe(false);
      // La fila vieja se conserva: un navegador abierto antes del despliegue todavía la lee.
      expect(de(a, "historico:por_viaje")).toBe(true);
      expect(de(b, "historico:por_viaje")).toBe(false);
    });

    it("es idempotente y no pisa un `viajes:consumo` que la persona ya tenía", async () => {
      const filas = (pasadas: number) =>
        conMigracion(
          [
            { usuario: a, pestana: "historico:por_viaje", permitido: true },
            // Ya decidido a mano, distinto del viejo: la migración no lo cambia.
            { usuario: a, pestana: "viajes:consumo", permitido: false },
            { usuario: b, pestana: "historico:por_viaje", permitido: false },
          ],
          [a, b],
          leerTodo,
          pasadas
        );
      const una = await filas(1);
      const dos = await filas(2);
      expect(dos).toEqual(una);
      expect(una.find((f) => f.u === a && f.pestana === "viajes:consumo")?.permitido).toBe(false);
      expect(una.find((f) => f.u === b && f.pestana === "viajes:consumo")?.permitido).toBe(false);
    });
  });

  describe("el servidor", () => {
    const sesion = async (e: Empresa, email = e.usuario.email) => {
      const agente = request.agent(app);
      await agente
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD })
        .expect(200);
      return agente;
    };
    /** Da de alta a alguien del perfil dado y, si se pide, le pone un permiso de pestaña a mano. */
    const persona = async (
      e: Empresa,
      rol: string,
      permiso?: { pestana: string; permitido: boolean }
    ) => {
      const admin = await sesion(e);
      const email = `${idUnico(rol)}@test.local`;
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: `Perfil ${rol}`,
        email,
        password: PASSWORD,
        rol,
        dni: String(Math.floor(10000000 + Math.random() * 89999999)),
      });
      expect(alta.status, JSON.stringify(alta.body)).toBe(201);
      if (permiso) {
        const actuales = (await admin.get(`/api/erp/usuarios/${alta.body.id}/permisos`)).body;
        const res = await admin.put(`/api/erp/usuarios/${alta.body.id}/permisos`).send({
          modulos: actuales.modulos.map(
            (m: { modulo: string; asignado: boolean; nivel: string }) => ({
              modulo: m.modulo,
              asignado: m.asignado,
              nivel: m.nivel,
            })
          ),
          pestanas: [{ modulo: "combustible", ...permiso }],
          motivo: "test: permiso de Consumo por viaje",
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      return sesion(e, email);
    };
    const consumo = (a: request.Agent, producto: string) =>
      a.get(`/api/erp/viajes/consumo?producto=${producto}`);

    it("administrador, operador y Lectura lo ven por defecto; el conductor no", async () => {
      const e = await nueva();
      expect((await consumo(await sesion(e), "combustible")).status).toBe(200);
      expect((await consumo(await persona(e, "operador"), "combustible")).status).toBe(200);
      expect((await consumo(await persona(e, "lectura"), "combustible")).status).toBe(200);
      expect((await consumo(await persona(e, "conductor_ruta"), "combustible")).status).toBe(403);
    });

    it("negarle `viajes:consumo` a un operador le cierra combustible, pero urea sigue con su propio permiso", async () => {
      const e = await nueva();
      const sinPermiso = await persona(e, "operador", {
        pestana: "viajes:consumo",
        permitido: false,
      });
      expect((await consumo(sinPermiso, "combustible")).status).toBe(403);
      expect((await consumo(sinPermiso, "urea")).status).toBe(200);
    });
  });

  describe("casos de borde del permiso", () => {
    const sesion2 = async (e: Empresa, email: string) => {
      const a = request.agent(app);
      await a
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email, password: PASSWORD })
        .expect(200);
      return a;
    };
    const alta = async (
      e: Empresa,
      rol: string,
      pestanas: { pestana: string; permitido: boolean }[]
    ) => {
      const admin = request.agent(app);
      await admin
        .post("/api/auth/login")
        .send({ tenantSlug: e.tenant.slug, email: e.usuario.email, password: PASSWORD })
        .expect(200);
      const email = `${idUnico(rol)}@test.local`;
      const creado = await admin.post("/api/erp/usuarios").send({
        nombre: `Perfil ${rol}`,
        email,
        password: PASSWORD,
        rol,
        dni: String(Math.floor(10000000 + Math.random() * 89999999)),
      });
      expect(creado.status).toBe(201);
      const actuales = (await admin.get(`/api/erp/usuarios/${creado.body.id}/permisos`)).body;
      const res = await admin.put(`/api/erp/usuarios/${creado.body.id}/permisos`).send({
        modulos: actuales.modulos.map(
          (m: { modulo: string; asignado: boolean; nivel: string }) => ({
            modulo: m.modulo,
            asignado: m.asignado,
            nivel: m.nivel,
          })
        ),
        pestanas: pestanas.map((p) => ({ modulo: "combustible", ...p })),
        motivo: "test: borde de Consumo por viaje",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return sesion2(e, email);
    };

    it("un perfil de cancha al que se le dio `viajes:consumo` a mano lo ve, y con él el submenú Viajes (el cliente debe coincidir)", async () => {
      const e = await nueva();
      const conductor = await alta(e, "conductor_ruta", [
        { pestana: "viajes:consumo", permitido: true },
      ]);
      expect((await conductor.get("/api/erp/viajes/consumo?producto=combustible")).status).toBe(
        200
      );
      // Darle una acción abre el submenú: la lista de viajes también responde.
      expect((await conductor.get("/api/erp/viajes")).status).toBe(200);
    });

    it("con el submenú Urea apagado, un permiso suelto de `urea:vista` no sirve: el consumo de urea da 403", async () => {
      const e = await nueva();
      const operador = await alta(e, "operador", [
        { pestana: "urea", permitido: false },
        { pestana: "urea:vista", permitido: true },
      ]);
      expect((await operador.get("/api/erp/viajes/consumo?producto=urea")).status).toBe(403);
      expect((await operador.get("/api/erp/viajes/consumo?producto=combustible")).status).toBe(200);
    });
  });

  it("el Histórico ya no tiene la vista `por_viaje` y Viajes sí tiene `consumo`", () => {
    const nombres = PESTANAS_CONFIGURABLES.map((p) => `${p.modulo}:${p.pestana}`);
    expect(nombres).not.toContain("combustible:historico:por_viaje");
    expect(nombres).toContain("combustible:viajes:consumo");
    const consumo = PESTANAS_CONFIGURABLES.find((p) => p.pestana === "viajes:consumo");
    expect(consumo?.padre).toBe("viajes");
  });
});
