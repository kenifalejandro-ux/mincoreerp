/** tests/combustible-recepcion-permisos-cisternas.test.ts
 *
 * Los permisos de la recepción viven en Cisternas (migración 0175): registrarla, validarla contra la
 * guía y anularla, y repartir el excedente. Quien tenía el permiso viejo a mano lo conserva; quien no
 * lo tenía sigue sin él; las llaves viejas de Tanques ya no mandan.
 *
 * Método de siempre: cada ataque con su gemelo (el mismo pedido que sí debe funcionar).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";

const BASE = "/api/erp/combustible";
const password = "ClaveDePrueba123";

type Agente = ReturnType<typeof request.agent>;

describe("combustible: permisos de la recepción en Cisternas", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let proveedor: number;
  let sede: number;
  let seq = 0;

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    proveedor = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("PROV") })).body.id;
    sede = (await admin.get("/api/erp/sedes")).body.sedes[0].grifos[0].id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  /** Una persona con su rol y, si se pide, overrides guardados ANTES de que entre (el permiso viaja
   *  en la sesión, y se lee al ingresar). */
  async function persona(rol: string, overrides: Record<string, boolean> = {}) {
    const agente = request.agent(app);
    const dni = String(88900000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `Persona ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    const id = alta.body.id as string;
    for (const [pestana, permitido] of Object.entries(overrides))
      await guardar(id, pestana, permitido);
    expect(
      (
        await agente
          .post("/api/auth/login")
          .send({ tenantSlug: slug, identificador: dni, password })
      ).status
    ).toBe(200);
    return { agente, id };
  }

  const guardar = (usuarioId: string, pestana: string, permitido: boolean) =>
    withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
         VALUES ($1, $2, 'combustible', $3, $4)
         ON CONFLICT (usuario_id, modulo, pestana) DO UPDATE SET permitido = EXCLUDED.permitido`,
        [tenantId, usuarioId, pestana, permitido]
      )
    );

  const filas = (usuarioId: string) =>
    withTenant(
      tenantId,
      async (c) =>
        (
          await c.query<{ pestana: string; permitido: boolean }>(
            `SELECT pestana, permitido FROM usuario_permisos_pestana
            WHERE usuario_id = $1 AND modulo = 'combustible' ORDER BY pestana`,
            [usuarioId]
          )
        ).rows
    );

  async function tanque(capacidad = 50000, nivel = 1000) {
    const r = await admin.post(BASE).send({
      codigo: idUnico("TQ"),
      tanque_nombre: "Tanque",
      tipo_combustible: "diesel_b5",
      unidad: "gal",
      tipo_punto: "fijo",
      capacidad_total: capacidad,
      nivel_actual: nivel,
      requiere_documento: false,
      modo_excedente_recepcion: "flexible",
      grifo_interno_id: sede,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  const recibir = (ag: Agente, tq: number, extra: Record<string, unknown> = {}) =>
    ag.post(`${BASE}/recepciones`).send({
      combustible_id: tq,
      grifo_id: proveedor,
      cantidad: 100,
      costo_unitario: 24.5,
      ...extra,
    });

  describe("por defecto", () => {
    it("el grifero registra la recepción, pero no la valida ni reparte el excedente", async () => {
      const grifero = await persona("grifero");
      const tq = await tanque(1100, 1000);
      // Registrar: sí.
      const ok = await recibir(grifero.agente, tq);
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      // Validar contra la guía: no (es del admin).
      const valida = await grifero.agente
        .patch(`${BASE}/recepciones/${ok.body.id}/validar`)
        .send({ cantidad_documento: 100 });
      expect(valida.status).toBe(403);
      // Anular: no.
      const anula = await grifero.agente
        .patch(`${BASE}/recepciones/${ok.body.id}/anular`)
        .send({ motivo: "x" });
      expect(anula.status).toBe(403);
      // Repartir el excedente: no nace para el grifero.
      const conReparto = await recibir(grifero.agente, tq, {
        cantidad: 500,
        reparto_excedente: [{ destino: "cisterna", cantidad: 400 }],
      });
      expect(conReparto.status, JSON.stringify(conReparto.body)).toBe(403);
      // El gemelo: el admin sí reparte.
      const adminReparte = await recibir(admin, await tanque(1100, 1000), {
        cantidad: 500,
        reparto_excedente: [{ destino: "cisterna", cantidad: 400 }],
      });
      expect(adminReparte.status, JSON.stringify(adminReparte.body)).toBe(201);
    });

    it("el operador registra, anula y reparte; validar contra la guía sigue siendo del admin", async () => {
      const operador = await persona("operador");
      const tq = await tanque(1100, 1000);
      const r = await recibir(operador.agente, tq, {
        cantidad: 500,
        reparto_excedente: [{ destino: "cisterna", cantidad: 400 }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(
        (
          await operador.agente
            .patch(`${BASE}/recepciones/${r.body.id}/validar`)
            .send({ cantidad_documento: 500 })
        ).status
      ).toBe(403);
      const anula = await operador.agente
        .patch(`${BASE}/recepciones/${r.body.id}/anular`)
        .send({ motivo: "se registró mal" });
      expect(anula.status, JSON.stringify(anula.body)).toBe(200);
    });

    it("Lectura no registra ni valida", async () => {
      const lectura = await persona("lectura");
      const tq = await tanque();
      expect((await recibir(lectura.agente, tq)).status).toBe(403);
    });
  });

  describe("permisos guardados a mano", () => {
    it("la llave nueva manda: negarla le quita el registrar al grifero, y su gemelo sin negar entra", async () => {
      const sin = await persona("grifero", { "cisternas:registrar_recepcion": false });
      const con = await persona("grifero");
      const tq = await tanque();
      expect((await recibir(sin.agente, tq)).status).toBe(403);
      expect((await recibir(con.agente, tq)).status).toBe(201);
    });

    it("las llaves viejas de Tanques ya no mandan", async () => {
      // Antes esto le quitaba el registrar al grifero; ahora no cambia nada.
      const grifero = await persona("grifero", { "tanques:registrar_recepcion": false });
      const tq = await tanque();
      expect((await recibir(grifero.agente, tq)).status).toBe(201);
    });

    it("el admin puede darle a un grifero el reparto del excedente, y entonces sí reparte", async () => {
      const grifero = await persona("grifero", { "cisternas:decidir_excedente": true });
      const tq = await tanque(1100, 1000);
      const r = await recibir(grifero.agente, tq, {
        cantidad: 500,
        reparto_excedente: [{ destino: "cisterna", cantidad: 400 }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    });

    it("un permiso hijo no vale sin su pestaña: con Cisternas negada, la recepción tampoco entra", async () => {
      const grifero = await persona("grifero", {
        cisternas: false,
        "cisternas:registrar_recepcion": true,
      });
      const tq = await tanque();
      expect((await recibir(grifero.agente, tq)).status).toBe(403);
    });
  });

  describe("la migración 0175", () => {
    const sql = readFileSync(
      "migrations/0175_combustible_recepcion_permisos_en_cisternas.sql",
      "utf8"
    );
    const correrMigracion = async () => {
      const cliente = await pool.connect();
      try {
        await cliente.query("BEGIN");
        await cliente.query(sql);
        await cliente.query("COMMIT");
      } catch (e) {
        await cliente.query("ROLLBACK");
        throw e;
      } finally {
        cliente.release();
      }
    };

    it("copia lo guardado a mano, con su valor, y no pisa lo que ya estaba en la llave nueva", async () => {
      const grifero = await persona("grifero");
      const operador = await persona("operador");
      await guardar(grifero.id, "tanques:registrar_recepcion", false);
      await guardar(grifero.id, "tanques:gestion_recepciones", true);
      await guardar(operador.id, "tanques:decidir_excedente", false);
      // Algo ya decidido en la llave nueva: la migración no lo pisa.
      await guardar(operador.id, "tanques:registrar_recepcion", true);
      await guardar(operador.id, "cisternas:registrar_recepcion", false);

      await correrMigracion();

      const g = new Map((await filas(grifero.id)).map((f) => [f.pestana, f.permitido]));
      expect(g.get("cisternas:registrar_recepcion")).toBe(false);
      expect(g.get("cisternas:gestion_recepciones")).toBe(true);
      const o = new Map((await filas(operador.id)).map((f) => [f.pestana, f.permitido]));
      expect(o.get("cisternas:decidir_excedente")).toBe(false);
      expect(o.get("cisternas:registrar_recepcion")).toBe(false);
      // Las filas viejas se quedan (un navegador abierto todavía las lee).
      expect(g.get("tanques:registrar_recepcion")).toBe(false);
    });

    it("quien tenía la recepción a mano en un perfil sin Cisternas por defecto la recibe también; lo negado se respeta", async () => {
      const conductor = await persona("conductor_ruta");
      const encargado = await persona("encargado_urea");
      const negado = await persona("encargado_urea");
      const grifero = await persona("grifero");
      await guardar(conductor.id, "tanques:registrar_recepcion", true);
      await guardar(encargado.id, "tanques:gestion_recepciones", true);
      await guardar(negado.id, "tanques:registrar_recepcion", true);
      await guardar(negado.id, "cisternas", false);
      await guardar(grifero.id, "tanques:registrar_recepcion", true);

      await correrMigracion();

      const tiene = async (id: string) =>
        new Map((await filas(id)).map((f) => [f.pestana, f.permitido])).get("cisternas");
      expect(await tiene(conductor.id)).toBe(true);
      expect(await tiene(encargado.id)).toBe(true);
      // Un `cisternas` negado a propósito es una decisión: se respeta.
      expect(await tiene(negado.id)).toBe(false);
      // El grifero ya la trae por defecto: no hace falta guardarla.
      expect(await tiene(grifero.id)).toBeUndefined();
    });

    it("correrla dos veces da lo mismo", async () => {
      const grifero = await persona("grifero");
      await guardar(grifero.id, "tanques:registrar_recepcion", false);
      await correrMigracion();
      const una = await filas(grifero.id);
      await correrMigracion();
      expect(await filas(grifero.id)).toEqual(una);
    });
  });
});
