/** Historial de compras del conductor (0134).
 *
 *  El conductor sube el comprobante después de comprar, así que ve el
 *  historial de SUS compras -- y solo esas --, sin anular. "Historial de
 *  compras" es una pestaña propia, autónoma de "Historial de despacho".
 *
 *  Cada ataque con su gemelo legítimo (método de combustible-comprobante-
 *  adversario.test.ts): si el gemelo también fallara, el "no pudo" no probaría
 *  nada. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";

const password = "ClaveDePrueba123";
const base = "/api/erp/combustible";
let seq = 0;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 1, 2]);
const OTRO_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 9, 9]);

type Agente = ReturnType<typeof request.agent>;

describe("combustible: historial de compras del conductor", () => {
  let tenantId: string;
  let slug: string;
  const admin = request.agent(app);
  let proveedor: number;
  let equipo: number;

  const numeroUnico = () => `B${100 + (seq++ % 800)}-${Date.now().toString().slice(-6)}${seq}`;

  const compra = (ag: Agente) =>
    ag.post(`${base}/despachos`).send({
      origen: "compra_externa",
      grifo_id: proveedor,
      tipo_combustible: "diesel_b5",
      tipo_destino: "equipo",
      equipo_id: equipo,
      comprobante_tipo: "boleta",
      comprobante_numero: numeroUnico(),
      cantidad: 40,
      lectura_horometro: 1000 + seq++,
      horas_abastecidas: 12,
      costo_unitario: 17.5,
      despachado_en: new Date().toISOString(),
    });

  async function compraId(ag: Agente) {
    const r = await compra(ag);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  const subir = (ag: Agente, id: number, contenido: Buffer, motivo?: string) => {
    const p = ag
      .post(`${base}/despachos/${id}/comprobante`)
      .attach("archivo", contenido, { filename: "boleta.jpg", contentType: "image/jpeg" });
    if (motivo) p.field("motivo", motivo);
    return p;
  };

  async function persona(rol: string, overrides: Record<string, boolean> = {}) {
    const agente = request.agent(app);
    const dni = String(86100000 + Math.floor(Math.random() * 800000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `H ${rol}`, dni, password, rol });
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
    return { agente, id: alta.body.id as string };
  }

  const ids = (r: request.Response) => (r.body.data as { id: number }[]).map((d) => d.id);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    equipo = (
      await admin
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("VOL"), tipo: "VOLQUETE", tipo_medidor: "horometro" })
    ).body.id;
    proveedor = (await admin.post(`${base}/grifos`).send({ nombre: idUnico("PRIMAX") })).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("el conductor ve solo sus compras; el admin ve todas", async () => {
    const a = await persona("conductor_ruta");
    const b = await persona("conductor_ruta");
    const deA = await compraId(a.agente);
    const deB = await compraId(b.agente);
    const deAdmin = await compraId(admin);

    const verA = await a.agente.get(`${base}/despachos?origen=compra_externa`);
    expect(verA.status, JSON.stringify(verA.body)).toBe(200);
    expect(ids(verA)).toEqual([deA]);

    const verB = await b.agente.get(`${base}/despachos?origen=compra_externa`);
    expect(ids(verB)).toEqual([deB]);

    const verAdmin = await admin.get(`${base}/despachos?origen=compra_externa`);
    expect(ids(verAdmin)).toEqual(expect.arrayContaining([deA, deB, deAdmin]));
  });

  it("el conductor no entra al historial de despachos ni al listado sin filtro", async () => {
    const a = await persona("conductor_ruta");
    expect((await a.agente.get(`${base}/despachos?origen=tanque_propio`)).status).toBe(403);
    expect((await a.agente.get(`${base}/despachos`)).status).toBe(403);
    expect((await a.agente.get(`${base}/despachos/huecos`)).status).toBe(403);
  });

  it("sube y reemplaza el comprobante de su compra; de la ajena, 404", async () => {
    const a = await persona("conductor_ruta");
    const b = await persona("conductor_ruta");
    const deA = await compraId(a.agente);

    // Ataque: otro conductor sobre la compra de A.
    expect((await subir(b.agente, deA, JPEG)).status).toBe(404);
    expect((await b.agente.get(`${base}/despachos/${deA}/comprobante`)).status).toBe(404);

    // Gemelo legítimo: el dueño.
    expect((await subir(a.agente, deA, JPEG)).status).toBe(201);
    expect((await a.agente.get(`${base}/despachos/${deA}/comprobante`)).status).toBe(200);

    // Reemplazar: sin motivo no; con motivo sí; el ajeno tampoco reemplaza.
    expect((await subir(a.agente, deA, OTRO_JPEG)).status).toBe(400);
    expect((await subir(b.agente, deA, OTRO_JPEG, "era mía")).status).toBe(404);
    expect((await subir(a.agente, deA, OTRO_JPEG, "la foto salió cortada")).status).toBe(201);
    // El ajeno sigue sin poder bajarla.
    expect((await b.agente.get(`${base}/despachos/${deA}/comprobante`)).status).toBe(404);
  });

  it("el conductor no anula; el admin sí", async () => {
    const a = await persona("conductor_ruta");
    const deA = await compraId(a.agente);
    const intento = await a.agente
      .patch(`${base}/despachos/${deA}/anular`)
      .send({ motivo: "me equivoqué" });
    expect(intento.status).toBe(403);
    const gemelo = await admin
      .patch(`${base}/despachos/${deA}/anular`)
      .send({ motivo: "compra duplicada" });
    expect(gemelo.status, JSON.stringify(gemelo.body)).toBe(200);
  });

  it("una compra sin dueño (usuario_id nulo) no es de ningún conductor", async () => {
    const a = await persona("conductor_ruta");
    const id = await compraId(a.agente);
    await subir(a.agente, id, JPEG);
    await withTenant(tenantId, (c) =>
      c.query(`UPDATE combustible_despachos SET usuario_id = NULL WHERE id = $1`, [id])
    );
    expect(ids(await a.agente.get(`${base}/despachos?origen=compra_externa`))).not.toContain(id);
    expect((await a.agente.get(`${base}/despachos/${id}/comprobante`)).status).toBe(404);
    expect((await subir(a.agente, id, OTRO_JPEG, "x")).status).toBe(404);
    // Gemelo: el admin la sigue viendo.
    expect(ids(await admin.get(`${base}/despachos?origen=compra_externa`))).toContain(id);
    expect((await admin.get(`${base}/despachos/${id}/comprobante`)).status).toBe(200);
  });

  it("las dos vistas son autónomas: cada una depende de su pestaña", async () => {
    // Sin las vistas del Histórico, que son otro camino a la misma lista.
    const sinHistorico = { "historico:despachos": false, "historico:compras_externas": false };
    const soloCompras = await persona("operador", {
      ...sinHistorico,
      "tanques:historial_despacho": false,
    });
    const soloDespachos = await persona("operador", {
      ...sinHistorico,
      "tanques:historial_compras": false,
    });

    const c = soloCompras.agente;
    expect((await c.get(`${base}/despachos?origen=compra_externa`)).status).toBe(200);
    expect((await c.get(`${base}/despachos?origen=tanque_propio`)).status).toBe(403);
    expect((await c.get(`${base}/despachos`)).status).toBe(403);

    const d = soloDespachos.agente;
    expect((await d.get(`${base}/despachos?origen=tanque_propio`)).status).toBe(200);
    expect((await d.get(`${base}/despachos?origen=compra_externa`)).status).toBe(403);
    expect((await d.get(`${base}/despachos`)).status).toBe(403);
  });

  it("Lectura conserva las dos vistas; el grifero y el encargado de urea no entran a compras", async () => {
    const lectura = await persona("lectura");
    expect((await lectura.agente.get(`${base}/despachos?origen=compra_externa`)).status).toBe(200);
    expect((await lectura.agente.get(`${base}/despachos?origen=tanque_propio`)).status).toBe(200);
    for (const rol of ["grifero", "encargado_urea"]) {
      const p = await persona(rol);
      expect((await p.agente.get(`${base}/despachos?origen=compra_externa`)).status, rol).toBe(403);
    }
  });

  it("guardar la matriz con TODAS las pestañas configurables sigue funcionando (tope del esquema)", async () => {
    const quien = await persona("conductor_ruta");
    const permisos = await admin.get(`/api/erp/usuarios/${quien.id}/permisos`);
    expect(permisos.status, JSON.stringify(permisos.body)).toBe(200);
    const pestanas = (
      permisos.body.pestanas as { modulo: string; pestana: string; permitido: boolean }[]
    ).map(({ modulo, pestana, permitido }) => ({ modulo, pestana, permitido }));
    expect(pestanas.some((p) => p.pestana === "tanques:historial_compras")).toBe(true);

    const guardar = await admin.put(`/api/erp/usuarios/${quien.id}/permisos`).send({
      modulos: permisos.body.modulos,
      pestanas,
      motivo: "prueba de tope",
    });
    expect(guardar.status, JSON.stringify(guardar.body)).toBe(200);
  });

  it("la migración 0134 copia el override de historial_despacho, permitido o negado, sin pisar", async () => {
    const quien = await persona("lectura");
    const otro = await persona("lectura");
    const sql = readFileSync(
      path.join(__dirname, "../migrations/0134_combustible_historial_compras_pestana.sql"),
      "utf8"
    );
    // Solo el INSERT: la ventana NO FORCE es del dueño de la tabla (migrate.ts).
    const inicio = sql.indexOf("INSERT INTO");
    const sentencia = sql.slice(inicio, sql.indexOf(";", inicio) + 1);

    await withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
         VALUES ($1,$2,'combustible','tanques:historial_despacho',true),
                ($1,$3,'combustible','tanques:historial_despacho',false),
                ($1,$3,'combustible','tanques:historial_compras',true)`,
        [tenantId, quien.id, otro.id]
      );
      await c.query(sentencia);
      await c.query(sentencia); // idempotente
      const r = await c.query(
        `SELECT usuario_id, permitido FROM usuario_permisos_pestana
          WHERE modulo = 'combustible' AND pestana = 'tanques:historial_compras'
            AND usuario_id = ANY($1)`,
        [[quien.id, otro.id]]
      );
      const porUsuario = Object.fromEntries(r.rows.map((f) => [f.usuario_id, f.permitido]));
      expect(porUsuario[quien.id]).toBe(true); // copiado
      expect(porUsuario[otro.id]).toBe(true); // ya existía: no se pisa
      expect(r.rows.length).toBe(2);
    });
  });

  // ── Hallazgos de la auditoría red team (A-1 a A-4 y huecos de la migración) ──

  async function compraUrea(ag: Agente) {
    const grifo = (
      await admin.post(`${base}/grifos`).send({
        nombre: idUnico("UREA"),
        abastece_ruta: true,
        abastece_tanque: false,
        abastece_urea: true,
        abastece_urea_ruta: true,
      })
    ).body.id;
    const r = await ag.post(`${base}/despachos`).send({
      cliente_uuid: crypto.randomUUID(),
      producto: "urea",
      origen: "compra_externa",
      grifo_id: grifo,
      tipo_destino: "equipo",
      equipo_id: equipo,
      comprobante_tipo: "boleta",
      comprobante_numero: numeroUnico(),
      presentacion: "caja",
      cantidad_bultos: 1,
      costo_unitario: 50,
      despachado_en: new Date().toISOString(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }

  it("A-1: con urea:vista, el conductor ve solo SUS compras de urea (el admin, todas)", async () => {
    const a = await persona("conductor_ruta");
    const c = await persona("conductor_ruta", { "urea:vista": true });
    const deA = await compraUrea(a.agente);
    const deC = await compraUrea(c.agente);

    const lista = await c.agente.get(`${base}/urea/compras`);
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    const propios = (lista.body as { id: number }[]).map((f) => f.id);
    expect(propios).toContain(deC);
    expect(propios).not.toContain(deA);
    // Gemelo: el admin ve las dos.
    const todas = ((await admin.get(`${base}/urea/compras`)).body as { id: number }[]).map(
      (f) => f.id
    );
    expect(todas).toEqual(expect.arrayContaining([deA, deC]));
  });

  it("A-2: un producto que el servidor no reconoce se rechaza (no esquiva urea:vista)", async () => {
    const c = await persona("conductor_ruta");
    await compraUrea(c.agente);
    for (const q of [
      "producto=UREA",
      "producto=%20urea",
      "producto=urea&producto=combustible",
      "producto[]=urea",
      "producto=cualquiera",
    ]) {
      const r = await c.agente.get(`${base}/despachos?origen=compra_externa&${q}`);
      expect(r.status, q).toBe(400);
    }
    // Lo exacto sigue como antes.
    expect(
      (await c.agente.get(`${base}/despachos?origen=compra_externa&producto=urea`)).status
    ).toBe(403);
    expect(
      (await c.agente.get(`${base}/despachos?origen=compra_externa&producto=combustible`)).status
    ).toBe(200);
  });

  it("A-3: los huecos de talonario no son para el conductor, aunque tenga historial_despacho", async () => {
    const c = await persona("conductor_ruta", { "tanques:historial_despacho": true });
    expect((await c.agente.get(`${base}/despachos/huecos?serie_talonario=X1`)).status).toBe(403);
    // Gemelo: quien sí lo usa lo sigue viendo.
    expect((await admin.get(`${base}/despachos/huecos?serie_talonario=X1`)).status).toBe(200);
  });

  it("A-4: la cookie de sesión cabe holgada aunque TODA pestaña contradiga su default", async () => {
    const quien = await persona("conductor_ruta");
    const permisos = await admin.get(`/api/erp/usuarios/${quien.id}/permisos`);
    const catalogo = permisos.body.pestanas as {
      modulo: string;
      pestana: string;
      permitido: boolean;
    }[];
    await withTenant(tenantId, async (c) => {
      for (const p of catalogo) {
        await c.query(
          `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [tenantId, quien.id, p.modulo, p.pestana, !p.permitido]
        );
      }
    });
    const dni = (
      await withTenant(tenantId, (c) =>
        c.query(`SELECT dni FROM usuarios WHERE id = $1`, [quien.id])
      )
    ).rows[0].dni;
    const login = await request(app)
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(login.status).toBe(200);
    const cookie = ((login.headers["set-cookie"] as unknown as string[]) ?? []).find((c) =>
      c.startsWith("erp_token=")
    );
    // El navegador descarta cookies de más de ~4096 bytes. Con las 51 pestañas
    // en el peor caso mide ~3300: si el catálogo crece y esto se acerca al
    // tope, hay que sacar los overrides del JWT antes de que alguien quede
    // sin sesión sin saber por qué.
    expect(cookie, "cookie de sesión").toBeDefined();
    expect(cookie!.length).toBeLessThan(3800);
  });

  it("Lectura ve el listado SIN filtro de origen (exige las dos pestañas)", async () => {
    const lectura = await persona("lectura");
    expect((await lectura.agente.get(`${base}/despachos`)).status).toBe(200);
    // Gemelo: quitarle una de las dos lo cierra.
    const sinCompras = await persona("lectura", { "tanques:historial_compras": false });
    expect((await sinCompras.agente.get(`${base}/despachos`)).status).toBe(403);
  });

  it("la ruta de plataforma también guarda la matriz completa (tope del esquema)", async () => {
    const quien = await persona("conductor_ruta");
    const permisos = await admin.get(`/api/erp/usuarios/${quien.id}/permisos`);
    const pestanas = (
      permisos.body.pestanas as { modulo: string; pestana: string; permitido: boolean }[]
    ).map(({ modulo, pestana, permitido }) => ({ modulo, pestana, permitido }));
    expect(pestanas.length).toBeGreaterThan(50);
    const r = await request(app)
      .put(`/api/platform/tenants/${tenantId}/usuarios/${quien.id}/pestanas`)
      .set("Authorization", `Bearer ${env.platformAdminToken}`)
      .send({ pestanas });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("la migración 0134 copia un override NEGADO a un destino vacío (y solo ese)", async () => {
    const negado = await persona("lectura");
    const sinOverride = await persona("lectura");
    const sql = readFileSync(
      path.join(__dirname, "../migrations/0134_combustible_historial_compras_pestana.sql"),
      "utf8"
    );
    const inicio = sql.indexOf("INSERT INTO");
    const sentencia = sql.slice(inicio, sql.indexOf(";", inicio) + 1);
    await withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO usuario_permisos_pestana (tenant_id, usuario_id, modulo, pestana, permitido)
         VALUES ($1,$2,'combustible','tanques:historial_despacho',false)`,
        [tenantId, negado.id]
      );
      await c.query(sentencia);
      const r = await c.query(
        `SELECT usuario_id, permitido FROM usuario_permisos_pestana
          WHERE modulo = 'combustible' AND pestana = 'tanques:historial_compras'
            AND usuario_id = ANY($1)`,
        [[negado.id, sinOverride.id]]
      );
      const porUsuario = Object.fromEntries(r.rows.map((f) => [f.usuario_id, f.permitido]));
      expect(porUsuario[negado.id]).toBe(false); // se conserva la negación
      expect(sinOverride.id in porUsuario).toBe(false); // sin override no se inventa fila
    });
  });
});
