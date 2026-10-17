/** Permisos de precios (combustible y urea), de la auditoría de Precios.
 *
 *  Decidido con Kenif: el encargado de urea SÍ lee el catálogo de precios de
 *  urea (los formularios de entrada y de compra en ruta autocompletan desde
 *  ahí, y la ruta pide solo la pestaña "urea"), pero NO lo carga ni lo anula:
 *  eso es lo que "cero segregación" le quita. Los demás perfiles de cancha ni
 *  leen ni escriben los precios de combustible. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("permisos de precios", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let slug: string;
  let tanque: number;
  let seq = 0;

  async function persona(rol: string, overrides: Record<string, boolean> = {}) {
    const agente = request.agent(app);
    const dni = String(87900000 + Math.floor(Math.random() * 90000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `A ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    for (const [pestana, permitido] of Object.entries(overrides)) {
      await withTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
           VALUES ($1,$2,'combustible',$3,$4)`,
          [tenantId, alta.body.id, pestana, permitido]
        )
      );
    }
    const entrar = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entrar.status).toBe(200);
    return agente;
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    tanque = await withTenant(tenantId, async (client) => {
      const f = await client.query(
        `INSERT INTO combustible (tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total)
         VALUES ($1,$2,'Tanque perm','diesel_b5','gal','fijo',5000) RETURNING id`,
        [tenantId, idUnico("TQ")]
      );
      return f.rows[0].id;
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("quien no es admin u operador no escribe precios; el encargado de urea lee el catálogo de urea pero no lo carga", async () => {
    const base = "/api/erp/combustible";
    const perfiles: [string, request.Agent][] = [
      ["conductor_ruta", await persona("conductor_ruta")],
      ["grifero", await persona("grifero")],
      ["lectura", await persona("lectura")],
      ["encargado_urea", await persona("encargado_urea")],
      ["operador solo urea:precios", await persona("operador", { "tanques:precios": false })],
      ["operador solo tanques:precios", await persona("operador", { "urea:precios": false })],
    ];
    const llamadas: [string, (a: request.Agent) => request.Test][] = [
      ["GET precios", (a) => a.get(`${base}/precios`)],
      [
        "GET vigente",
        (a) => a.get(`${base}/precios/vigente?tipo_combustible=diesel_b5&combustible_id=${tanque}`),
      ],
      [
        "POST masivo",
        (a) =>
          a.post(`${base}/precios/masivo`).send({
            tipo_combustible: "diesel_b5",
            combustible_ids: [tanque],
            precio_unitario: 5,
          }),
      ],
      ["PATCH anular", (a) => a.patch(`${base}/precios/999999/anular`).send({ motivo: "x" })],
      ["GET urea/precios", (a) => a.get(`${base}/urea/precios`)],
      [
        "POST urea/precios",
        (a) =>
          a
            .post(`${base}/urea/precios`)
            .send({ grifo_id: 1, presentacion: "x", precio_por_bulto: 5 }),
      ],
      [
        "PATCH urea anular",
        (a) => a.patch(`${base}/urea/precios/999999/anular`).send({ motivo: "x" }),
      ],
    ];
    const matriz: Record<string, Record<string, number>> = {};
    for (const [nombre, agente] of perfiles) {
      matriz[nombre] = {};
      for (const [etiqueta, llamar] of llamadas) {
        matriz[nombre][etiqueta] = (await llamar(agente)).status;
      }
    }
    const escrituras = ["POST masivo", "PATCH anular", "POST urea/precios", "PATCH urea anular"];
    // Ningún perfil de cancha escribe, ni siquiera el encargado de urea.
    for (const perfil of ["conductor_ruta", "grifero", "lectura", "encargado_urea"]) {
      for (const llamada of escrituras) {
        expect(matriz[perfil][llamada], `${perfil} ${llamada}`).toBe(403);
      }
      // Los precios de combustible no los lee ninguno de los cuatro.
      expect(matriz[perfil]["GET precios"], `${perfil} GET precios`).toBe(403);
      expect(matriz[perfil]["GET vigente"], `${perfil} GET vigente`).toBe(403);
    }
    // Lo decidido: el catálogo de urea se lee con la pestaña "urea".
    expect(matriz["encargado_urea"]["GET urea/precios"]).toBe(200);
    // Un operador con una sola pestaña de precios no toca el otro producto.
    expect(matriz["operador solo urea:precios"]["GET precios"]).toBe(403);
    expect(matriz["operador solo urea:precios"]["POST masivo"]).toBe(403);
    expect(matriz["operador solo tanques:precios"]["POST urea/precios"]).toBe(403);
    expect(matriz["operador solo tanques:precios"]["PATCH urea anular"]).toBe(403);
  });
});
