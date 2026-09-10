/** tests/auth-acceso-por-dni.test.ts
 *
 * Pedido del cliente (reunión 2026-09-09): *"en vez de crearle un usuario con
 * correo... solamente con DNI y contraseña. O sea, no sería un usuario, sino
 * un acceso donde ellos puedan registrar"*.
 *
 * El grifero y los conductores de ruta no tienen correo corporativo. Exigirles
 * uno significa inventarlo -- y un correo inventado no recibe nada, así que la
 * recuperación de contraseña no funcionaría, solo lo parecería.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("auth: entrar con DNI (migración 0084)", () => {
  let tenantId: string;
  let slug: string;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  let seq = 0;
  const dniUnico = () => String(80000000 + seq++);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await ag.post("/api/auth/login").send({ tenantSlug: slug, email: c.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const crearUsuario = (body: Record<string, unknown>) =>
    ag.post("/api/erp/usuarios").send({ nombre: "Grifero de Cancha", password, ...body });

  const login = (identificador: string, pass = password) =>
    request(app).post("/api/auth/login").send({ tenantSlug: slug, identificador, password: pass });

  // ── El caso que motivó todo ───────────────────────────────────────────

  it("un usuario SIN correo, solo con DNI, se crea y entra", async () => {
    const dni = dniUnico();
    const alta = await crearUsuario({ dni });
    expect(alta.status).toBe(201);
    expect(alta.body.dni).toBe(dni);
    expect(alta.body.email).toBeNull();

    const res = await login(dni);
    expect(res.status).toBe(200);
    expect(res.body.usuario.dni).toBe(dni);
  });

  it("el correo sigue funcionando igual que siempre", async () => {
    // Lo importante de este test: no romper a nadie que ya entraba.
    const email = `con.correo.${Date.now()}@test.local`;
    expect((await crearUsuario({ email })).status).toBe(201);
    const res = await login(email);
    expect(res.status).toBe(200);
    expect(res.body.usuario.email).toBe(email);
  });

  it("`email` se sigue aceptando como alias, para no romper la cola offline", async () => {
    // Un cliente viejo --una pestaña con el bundle anterior, un script-- manda
    // `email`. Los dos nombres caen en el mismo campo.
    const email = `alias.${Date.now()}@test.local`;
    await crearUsuario({ email });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email, password });
    expect(res.status).toBe(200);
  });

  // ── Lo que NO debe pasar ──────────────────────────────────────────────

  it("sin correo NI DNI el alta se rechaza: ese usuario no podría entrar nunca", async () => {
    const res = await crearUsuario({});
    expect(res.status).toBe(400);
  });

  it("el DNI es único DENTRO del tenant", async () => {
    const dni = dniUnico();
    expect((await crearUsuario({ dni })).status).toBe(201);
    const repetido = await crearUsuario({ dni });
    expect(repetido.status).toBe(409);
  });

  it("el mismo DNI puede existir en OTRA empresa", async () => {
    // El ERP es SaaS: la misma persona puede trabajar para dos empresas.
    // El DNI la identifica dentro de la suya, no en el mundo.
    const dni = dniUnico();
    expect((await crearUsuario({ dni })).status).toBe(201);

    const otro = await crearTenantDePrueba(password);
    const agB = request.agent(app);
    await agB
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    try {
      const res = await agB
        .post("/api/erp/usuarios")
        .send({ nombre: "Otro Grifero", password, dni });
      expect(res.status).toBe(201);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("un DNI de otro tenant NO sirve para entrar acá", async () => {
    const otro = await crearTenantDePrueba(password);
    const agB = request.agent(app);
    await agB
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });
    const dni = dniUnico();
    await agB.post("/api/erp/usuarios").send({ nombre: "Ajeno", password, dni });
    try {
      // Mismo DNI, tenant equivocado.
      const res = await login(dni);
      expect(res.status).toBe(401);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("contraseña incorrecta con DNI da 401, igual que con correo", async () => {
    const dni = dniUnico();
    await crearUsuario({ dni });
    const res = await login(dni, "OtraClaveDistinta123");
    expect(res.status).toBe(401);
  });

  it("un DNI escrito en el campo no matchea contra el correo de nadie", async () => {
    // Se busca por UNA columna según haya "@" o no, nunca por las dos en OR:
    // un OR dejaría entrar con un valor que coincide con la otra columna de
    // otra persona, y además haría inútil el índice.
    const dni = dniUnico();
    await crearUsuario({ dni });
    const res = await login(`${dni}@test.local`);
    expect(res.status).toBe(401);
  });

  // ── La auditoría tiene que poder nombrarlo ────────────────────────────

  it("las acciones de un usuario sin correo quedan atribuidas por DNI", async () => {
    // Sin el fallback, la bitácora mostraría vacío justo para los usuarios
    // cuyas acciones más interesa poder atribuir: el grifero que despacha.
    const dni = dniUnico();
    await crearUsuario({ dni, rol: "admin" });

    const agG = request.agent(app);
    const entro = await agG
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(entro.status).toBe(200);

    // Cualquier acción auditada de módulo.
    const eq = await agG
      .post("/api/erp/equipos")
      .send({ placa_codigo: `VQ-${dni}`, tipo: "Volquete" });
    expect(eq.status).toBe(201);

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT actor_label FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'equipos.crear'
          ORDER BY id DESC LIMIT 1`,
        [tenantId]
      )
    );
    expect(log.rows[0].actor_label).toBe(dni);
  });
});
