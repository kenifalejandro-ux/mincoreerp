/** tests/combustible-precios-redteam.test.ts
 *
 * Red team de la API de Precios de combustible tras cerrar el alta individual
 * (POST /precios). Los casos de ids desbordados en /masivo y de ids mal
 * formados en /anular (500 que ya existían) van en el PR de validación de entradas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

const BASE = "/api/erp/combustible";
const MASIVO = `${BASE}/precios/masivo`;

describe("red team: precios de combustible", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let slug: string;
  let otroTenantId: string;
  let tanque: number;
  let tanqueAjeno: number;
  let proveedorRuta: number;
  let proveedorInactivo: number;
  let proveedorSoloUrea: number;
  let proveedorAjeno: number;
  let seq = 0;

  async function crearTanque(tid: string): Promise<number> {
    return withTenant(tid, async (c) => {
      const f = await c.query(
        `INSERT INTO combustible (tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total)
         VALUES ($1,$2,'Tanque RT','diesel_b5','gal','fijo',5000) RETURNING id`,
        [tid, idUnico("TQ")]
      );
      return f.rows[0].id;
    });
  }
  const contar = (tid: string) =>
    withTenant(
      tid,
      async (c) => (await c.query(`SELECT count(*)::int n FROM combustible_precios`)).rows[0].n
    );

  async function persona(rol: string, overrides: Record<string, boolean> = {}) {
    const agente = request.agent(app);
    const dni = String(86100000 + Math.floor(Math.random() * 90000) + seq++);
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `RT ${rol}`, dni, password, rol });
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
    const e = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(e.status).toBe(200);
    return agente;
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
    tanque = await crearTanque(tenantId);
    proveedorRuta = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("RUTA") })).body.id;
    proveedorInactivo = (await admin.post(`${BASE}/grifos`).send({ nombre: idUnico("INACT") })).body
      .id;
    await withTenant(tenantId, (cl) =>
      cl
        .query(`UPDATE combustible_grifos SET activo=false WHERE id=$1`, [proveedorInactivo])
        .catch(() => null)
    );
    proveedorSoloUrea = (
      await admin.post(`${BASE}/grifos`).send({
        nombre: idUnico("UREA"),
        abastece_ruta: false,
        abastece_tanque: false,
        abastece_urea: true,
      })
    ).body.id;
    const otro = await crearTenantDePrueba(password);
    otroTenantId = otro.tenant.id;
    const ag = request.agent(app);
    await ag
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    tanqueAjeno = await crearTanque(otroTenantId);
    proveedorAjeno = (await ag.post(`${BASE}/grifos`).send({ nombre: idUnico("AJ") })).body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await borrarTenantDePrueba(otroTenantId);
    await closeDatabase();
  });

  const valido = () => ({
    tipo_combustible: "diesel_b5",
    combustible_ids: [tanque],
    precio_unitario: 20,
  });

  describe("1. el alta individual no existe", () => {
    it("POST /precios y variantes dan 404 con todos los roles y sin sesión", async () => {
      const cuerpo = { tipo_combustible: "diesel_b5", combustible_id: tanque, precio_unitario: 20 };
      const antes = await contar(tenantId);
      const perfiles: [string, request.Agent][] = [
        ["admin", admin],
        ["operador", await persona("operador")],
        ["lectura", await persona("lectura")],
        ["grifero", await persona("grifero")],
        ["conductor_ruta", await persona("conductor_ruta")],
        ["encargado_urea", await persona("encargado_urea")],
        ["anonimo", request.agent(app)],
      ];
      for (const [nombre, a] of perfiles) {
        for (const url of [
          `${BASE}/precios`,
          `${BASE}/precios/`,
          `${BASE}/precios?x=1`,
          `${BASE}/PRECIOS`,
        ]) {
          const r = await a.post(url).send(cuerpo);
          // anonimo: 401 es aceptable (corta antes por auth); lo que no puede es 2xx/400/500.
          // 401 sin sesión y 403 de Lectura (el guard de módulo corta antes que el 404): ambos
          // son rechazos válidos. Lo que nunca puede salir es 2xx, 400 o 500.
          const ok = [401, 403, 404];
          expect(ok, `${nombre} POST ${url} -> ${r.status} ${JSON.stringify(r.body)}`).toContain(
            r.status
          );
        }
      }
      expect(await contar(tenantId)).toBe(antes);
    });

    it("PUT/PATCH/DELETE sobre /precios y /precios/:id no existen", async () => {
      const b = { precio_unitario: 1 };
      for (const [m, u] of [
        ["put", `${BASE}/precios`],
        ["patch", `${BASE}/precios`],
        ["put", `${BASE}/precios/1`],
        ["patch", `${BASE}/precios/1`],
        ["delete", `${BASE}/precios/1`],
        ["post", `${BASE}/precios/1`],
      ] as const) {
        const r = await (admin as any)[m](u).send(b);
        expect([400, 404], `${m} ${u} -> ${r.status}`).toContain(r.status);
      }
    });
  });

  describe("2. validación de /masivo", () => {
    it("rechazos de forma: nada queda insertado y nunca 500", async () => {
      const antes = await contar(tenantId);
      const casos: [string, unknown][] = [
        ["precio 0", { ...valido(), precio_unitario: 0 }],
        ["precio negativo", { ...valido(), precio_unitario: -5 }],
        ["precio 0.001", { ...valido(), precio_unitario: 0.001 }],
        ["precio 1e9", { ...valido(), precio_unitario: 1e9 }],
        ["precio string", { ...valido(), precio_unitario: "17.5" }],
        ["precio null", { ...valido(), precio_unitario: null }],
        ["precio ausente", { tipo_combustible: "diesel_b5", combustible_ids: [tanque] }],
        ["tipo inválido", { ...valido(), tipo_combustible: "agua" }],
        ["ids vacío", { ...valido(), combustible_ids: [] }],
        ["ids duplicados", { ...valido(), combustible_ids: [tanque, tanque] }],
        ["ids no enteros", { ...valido(), combustible_ids: [1.5] }],
        ["ids negativos", { ...valido(), combustible_ids: [-1] }],
        ["ids strings", { ...valido(), combustible_ids: ["1"] }],
        ["sin destino", { tipo_combustible: "diesel_b5", precio_unitario: 20 }],
        ["mezcla", { ...valido(), grifo_ids: [proveedorRuta] }],
        [
          "mas de 50",
          { ...valido(), combustible_ids: Array.from({ length: 51 }, (_, i) => i + 1) },
        ],
        ["fecha inválida", { ...valido(), vigente_desde: "ayer" }],
        ["fecha sin zona", { ...valido(), vigente_desde: "2026-01-01" }],
        ["body array", [valido()]],
        ["body vacío", {}],
      ];
      const malos: string[] = [];
      for (const [nombre, body] of casos) {
        const r = await admin.post(MASIVO).send(body as object);
        if (r.status !== 400) malos.push(`${nombre} -> ${r.status}`);
      }
      expect(await contar(tenantId)).toBe(antes);
      expect(malos, "casos que no dieron 400").toEqual([]);
    });

    it("precio NaN/Infinity (JSON no los admite) no produce 500", async () => {
      for (const crudo of [
        '{"tipo_combustible":"diesel_b5","combustible_ids":[1],"precio_unitario":NaN}',
        '{"tipo_combustible":"diesel_b5","combustible_ids":[1],"precio_unitario":Infinity}',
        '{"tipo_combustible":"diesel_b5","combustible_ids":[1],"precio_unitario":1e999}',
      ]) {
        const r = await admin.post(MASIVO).set("Content-Type", "application/json").send(crudo);
        expect([400, 413], crudo + " -> " + r.status).toContain(r.status);
      }
    });

    it("cuerpo gigante -> 413, no 500", async () => {
      const r = await admin.post(MASIVO).send({ ...valido(), basura: "x".repeat(2_000_000) });
      expect([400, 413]).toContain(r.status);
    });

    it("destinos inválidos: ajeno, inexistente, sin ruta, inactivo, mezcla buena+mala al final", async () => {
      const antes = await contar(tenantId);
      const antesAjeno = await contar(otroTenantId);
      const casos: [string, object][] = [
        ["tanque ajeno", { ...valido(), combustible_ids: [tanqueAjeno] }],
        ["tanque bueno + ajeno al final", { ...valido(), combustible_ids: [tanque, tanqueAjeno] }],
        ["tanque inexistente", { ...valido(), combustible_ids: [2_000_000_000] }],
        [
          "tanque bueno + 49 inexistentes",
          {
            ...valido(),
            combustible_ids: [tanque, ...Array.from({ length: 49 }, (_, i) => 1_900_000_000 + i)],
          },
        ],
        [
          "proveedor ajeno",
          { tipo_combustible: "diesel_b5", grifo_ids: [proveedorAjeno], precio_unitario: 20 },
        ],
        [
          "proveedor solo urea",
          { tipo_combustible: "diesel_b5", grifo_ids: [proveedorSoloUrea], precio_unitario: 20 },
        ],
        [
          "proveedor ruta + solo urea al final",
          {
            tipo_combustible: "diesel_b5",
            grifo_ids: [proveedorRuta, proveedorSoloUrea],
            precio_unitario: 20,
          },
        ],
        [
          "proveedor inexistente",
          { tipo_combustible: "diesel_b5", grifo_ids: [2_000_000_000], precio_unitario: 20 },
        ],
      ];
      for (const [nombre, body] of casos) {
        const r = await admin.post(MASIVO).send(body);
        expect(r.status, `${nombre} -> ${r.status} ${JSON.stringify(r.body)}`).toBe(400);
      }
      expect(await contar(tenantId)).toBe(antes);
      expect(await contar(otroTenantId)).toBe(antesAjeno);
    });

    it("un proveedor de ruta inactivo no recibe precio: 400 y nada insertado", async () => {
      const antes = await contar(tenantId);
      const r = await admin.post(MASIVO).send({
        tipo_combustible: "diesel_b5",
        grifo_ids: [proveedorInactivo],
        precio_unitario: 20,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(await contar(tenantId)).toBe(antes);
    });

    it("vigente_desde extremos: ni 500 (se reporta qué aceptó)", async () => {
      for (const f of [
        "0001-01-01T00:00:00Z",
        "1900-01-01T00:00:00Z",
        "9999-12-31T23:59:59Z",
        "2100-01-01T00:00:00Z",
      ]) {
        const r = await admin.post(MASIVO).send({ ...valido(), vigente_desde: f });
        expect(r.status, f).not.toBe(500);
      }
    });

    it("precio con decimales de más (20.123456789) no revienta", async () => {
      const r = await admin.post(MASIVO).send({ ...valido(), precio_unitario: 20.123456789 });
      expect(r.status).not.toBe(500);
    });

    it("50 destinos exactos es el máximo: 50 tanques válidos pasan o 400 por inexistentes, nunca 500", async () => {
      const r = await admin.post(MASIVO).send({
        ...valido(),
        combustible_ids: Array.from({ length: 50 }, (_, i) => 1_800_000_000 + i),
      });
      expect(r.status).toBe(400);
    });
  });

  describe("3. permisos", () => {
    it("lectura, grifero, conductor_ruta, encargado_urea: 403 en escritura, también con override tanques:precios", async () => {
      const antes = await contar(tenantId);
      const sembrado = await admin.post(MASIVO).send(valido());
      expect(sembrado.status).toBe(201);
      const precioId = sembrado.body[0].id;
      const roles = ["lectura", "grifero", "conductor_ruta", "encargado_urea"];
      for (const rol of roles) {
        for (const ov of [{}, { "tanques:precios": true }] as Record<string, boolean>[]) {
          const a = await persona(rol, ov);
          const m = await a.post(MASIVO).send(valido());
          expect([403, 401], `${rol} ${JSON.stringify(ov)} masivo -> ${m.status}`).toContain(
            m.status
          );
          const an = await a.patch(`${BASE}/precios/${precioId}/anular`).send({ motivo: "x" });
          expect([403, 401], `${rol} ${JSON.stringify(ov)} anular -> ${an.status}`).toContain(
            an.status
          );
        }
      }
      expect(await contar(tenantId)).toBe(antes + 1);
    });

    it("lecturas: grifero/conductor/encargado_urea sin override no leen /precios ni /precios/vigente", async () => {
      for (const rol of ["grifero", "conductor_ruta", "encargado_urea"]) {
        const a = await persona(rol);
        const l = await a.get(`${BASE}/precios`);
        const v = await a.get(
          `${BASE}/precios/vigente?tipo_combustible=diesel_b5&combustible_id=${tanque}`
        );
        expect(l.status, `${rol} /precios`).toBe(403);
        expect(v.status, `${rol} /precios/vigente`).toBe(403);
      }
    });

    it("vigente-formulario: no devuelve precio de un tanque ajeno ni de proveedor sin ruta", async () => {
      const a = await persona("conductor_ruta");
      const q = (extra: string) =>
        a.get(
          `${BASE}/precios/vigente-formulario?tipo_combustible=diesel_b5&fecha=${encodeURIComponent(new Date().toISOString())}&${extra}`
        );
      for (const extra of [
        `combustible_id=${tanqueAjeno}`,
        `grifo_id=${proveedorAjeno}`,
        `grifo_id=${proveedorSoloUrea}`,
      ]) {
        const r = await q(extra);
        expect(r.status).not.toBe(500);
        if (r.status === 200) expect(r.body.precio ?? null).toBeNull();
      }
    });

    it("lectura con override en true NO escribe (requireRole fijo)", async () => {
      const a = await persona("lectura", { "tanques:precios": true });
      expect((await a.post(MASIVO).send(valido())).status).toBe(403);
    });
  });

  describe("4. anular", () => {
    let precioId: number;
    beforeAll(async () => {
      precioId = (await admin.post(MASIVO).send(valido())).body[0].id;
    });

    it("exige motivo", async () => {
      for (const body of [
        {},
        { motivo: "" },
        { motivo: "   " },
        { motivo: "x".repeat(501) },
        { motivo: 5 },
      ]) {
        const r = await admin.patch(`${BASE}/precios/${precioId}/anular`).send(body);
        expect(r.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("precio de otro tenant -> 404 y no queda anulado", async () => {
      const ag = request.agent(app);
      const otro = await withTenant(otroTenantId, async (c) => {
        const t = await c
          .query(`SELECT slug FROM tenants WHERE id=$1`, [otroTenantId])
          .catch(() => null);
        return t;
      });
      void ag;
      void otro;
      const idAjeno = await withTenant(otroTenantId, async (c) => {
        const f = await c.query(
          `INSERT INTO combustible_precios (tenant_id, tipo_combustible, combustible_id, precio_unitario, vigente_desde, usuario_id)
           SELECT $1,'diesel_b5',$2,20,now(),(SELECT id FROM usuarios WHERE tenant_id=$1 LIMIT 1) RETURNING id`,
          [otroTenantId, tanqueAjeno]
        );
        return f.rows[0].id;
      });
      const r = await admin.patch(`${BASE}/precios/${idAjeno}/anular`).send({ motivo: "ataque" });
      expect(r.status).toBe(404);
      const sigue = await withTenant(otroTenantId, (c) =>
        c.query(`SELECT anulada_en FROM combustible_precios WHERE id=$1`, [idAjeno])
      );
      expect(sigue.rows[0].anulada_en).toBeNull();
    });

    it("anula una vez (200) y la segunda da 409; bitácora con motivo", async () => {
      const r1 = await admin
        .patch(`${BASE}/precios/${precioId}/anular`)
        .send({ motivo: "error de carga" });
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      const r2 = await admin
        .patch(`${BASE}/precios/${precioId}/anular`)
        .send({ motivo: "otra vez" });
      expect(r2.status).toBe(409);
      const log = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT detalle, usuario_id FROM platform_audit_log
            WHERE tenant_id=$1 AND accion='combustible.precio_anular' AND (detalle->>'precioId')::int=$2`,
          [tenantId, precioId]
        )
      );
      expect(log.rows).toHaveLength(1);
      expect(log.rows[0].detalle.motivo).toBe("error de carga");
      expect(log.rows[0].usuario_id).toBeTruthy();
    });
  });

  describe("5. bitácora", () => {
    const entradas = () =>
      withTenant(
        tenantId,
        async (c) =>
          (
            await c.query(
              `SELECT count(*)::int n FROM platform_audit_log WHERE tenant_id=$1 AND accion='combustible.precio_crear'`,
              [tenantId]
            )
          ).rows[0].n
      );

    it("un rechazo no deja entradas fantasma y un éxito deja una por precio con el usuario correcto", async () => {
      const antes = await entradas();
      const mal = await admin
        .post(MASIVO)
        .send({ ...valido(), combustible_ids: [tanque, 2_000_000_000] });
      expect(mal.status).toBe(400);
      expect(await entradas()).toBe(antes);

      const op = await persona("operador");
      const ok = await op.post(MASIVO).send({ ...valido(), precio_unitario: 31 });
      expect(ok.status).toBe(201);
      const log = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT usuario_id FROM platform_audit_log WHERE tenant_id=$1 AND accion='combustible.precio_crear' AND (detalle->>'precioId')::int=$2`,
          [tenantId, ok.body[0].id]
        )
      );
      expect(log.rows).toHaveLength(1);
      expect(log.rows[0].usuario_id).toBe(ok.body[0].usuario_id);
    });
  });

  describe("6. rutas hermanas de urea (solo informativo)", () => {
    it("POST /urea/precios: ¿acepta cualquier precio / ids ajenos?", async () => {
      const base = { grifo_id: proveedorSoloUrea, presentacion: "bulto" };
      const casos: object[] = [
        { ...base, precio_por_bulto: 0 },
        { ...base, precio_por_bulto: -1 },
        { ...base, precio_por_bulto: 1e9 },
        { ...base, precio_por_bulto: 0.001 },
        { ...base, grifo_id: proveedorAjeno, precio_por_bulto: 10 },
        { ...base, grifo_id: proveedorRuta, precio_por_bulto: 10 },
      ];
      for (const c of casos) {
        const r = await admin.post(`${BASE}/urea/precios`).send(c);
        expect(r.status).not.toBe(500);
      }
    });
  });
});
