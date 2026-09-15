/** tests/auth-cuentas-y-perfiles.test.ts
 *
 * Una persona, una cuenta, un perfil por empresa (migración 0087).
 * Diseño: docs/architecture/cuentas-perfiles-y-administracion.md
 *
 * Lo que se fija acá, en orden de importancia:
 *
 * 1. QUE NINGUNA EMPRESA PUEDA AVERIGUAR NADA DE OTRA. El login no dice en
 *    qué empresas está una persona hasta que la clave es correcta, y dar de
 *    alta a alguien que ya trabaja en otra empresa se ve exactamente igual
 *    que dar de alta a alguien nuevo.
 * 2. QUE EL ADMIN DE UNA EMPRESA NO PUEDA CAMBIARLE LA CLAVE A ALGUIEN QUE
 *    TAMBIÉN TRABAJA EN OTRA. La clave es de la cuenta: cambiarla sería
 *    darle acceso a las demás empresas de esa persona.
 * 3. QUE EL AISLAMIENTO SIGA INTACTO. La política nueva de RLS deja ver los
 *    perfiles de UNA cuenta ya autenticada, nada más, y solo para leer.
 * 4. Que entrar siga funcionando igual de simple: una empresa, directo;
 *    varias, se elige DESPUÉS de la clave.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, pool, withTenant, withCuenta } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";

describe("auth: cuentas y perfiles por empresa", () => {
  /** Dos empresas y una persona con perfil en las dos: el admin de la
   *  empresa A, dado de alta también en la B. */
  let empresaA: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  let empresaB: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  let perfilEnB: string;
  const CLAVE_QUE_NO_SIRVE = "ClaveDelAltaEnB456";

  const login = (body: Record<string, unknown>) => request(app).post("/api/auth/login").send(body);

  const sesionDe = async (tenantSlug: string, email: string, password = PASSWORD) => {
    const agente = request.agent(app);
    const res = await agente.post("/api/auth/login").send({ tenantSlug, email, password });
    expect(res.status).toBe(200);
    return agente;
  };

  const cuentaDe = async (email: string) =>
    (await pool.query(`SELECT * FROM cuentas WHERE email = $1`, [email.toLowerCase()])).rows[0];

  beforeAll(async () => {
    empresaA = await crearTenantDePrueba(PASSWORD);
    empresaB = await crearTenantDePrueba(PASSWORD);

    // El admin de B da de alta a la persona de A, con OTRA clave. Es el caso
    // que antes de 0087 no existía: el mismo correo en dos empresas.
    const agenteB = await sesionDe(empresaB.tenant.slug, empresaB.usuario.email);
    const alta = await agenteB.post("/api/erp/usuarios").send({
      nombre: "Persona en dos empresas",
      email: empresaA.usuario.email,
      password: CLAVE_QUE_NO_SIRVE,
      rol: "operador",
    });
    expect(alta.status).toBe(201);
    perfilEnB = alta.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(empresaB.tenant.id);
    await borrarTenantDePrueba(empresaA.tenant.id);
    await closeDatabase();
  });

  // ── 1. El modelo ──────────────────────────────────────────────────────

  it("el mismo correo en dos empresas es UNA cuenta con dos perfiles", async () => {
    const cuenta = await cuentaDe(empresaA.usuario.email);
    expect(cuenta).toBeDefined();

    const perfiles = await withCuenta(cuenta.id, async (client) => {
      const r = await client.query(
        `SELECT tenant_id, cuenta_id, password_hash FROM usuarios WHERE cuenta_id = $1`,
        [cuenta.id]
      );
      return r.rows;
    });

    expect(perfiles).toHaveLength(2);
    expect(new Set(perfiles.map((p) => p.tenant_id))).toEqual(
      new Set([empresaA.tenant.id, empresaB.tenant.id])
    );
    // El perfil no guarda clave propia: la clave es de la cuenta.
    expect(perfiles.every((p) => p.password_hash === null)).toBe(true);
  });

  it("dar de alta a alguien que ya existe NO le cambia la clave", async () => {
    // La clave que tipeó el admin de B no sirve: la persona sigue entrando
    // con la suya. Si sirviera, el admin de B habría cambiado la clave con la
    // que esa persona entra a la empresa A.
    const conLaDelAlta = await login({
      tenantSlug: empresaB.tenant.slug,
      email: empresaA.usuario.email,
      password: CLAVE_QUE_NO_SIRVE,
    });
    expect(conLaDelAlta.status).toBe(401);

    const conLaSuya = await login({
      tenantSlug: empresaB.tenant.slug,
      email: empresaA.usuario.email,
      password: PASSWORD,
    });
    expect(conLaSuya.status).toBe(200);
  });

  // ── 2. Entrar sin decir la empresa ────────────────────────────────────

  it("con una sola empresa entra directo, sin preguntar nada", async () => {
    const res = await login({ email: empresaB.usuario.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.elegirEmpresa).toBeUndefined();
    expect(res.body.usuario.tenantId).toBe(empresaB.tenant.id);
  });

  it("con dos empresas pide elegir, y recién DESPUÉS de validar la clave", async () => {
    const res = await login({ email: empresaA.usuario.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeUndefined();
    expect(res.body.elegirEmpresa.empresas).toHaveLength(2);
    expect(res.body.elegirEmpresa.token).toBeTruthy();

    // Todavía no hay sesión: sin empresa no existe una sesión en este sistema.
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
  });

  it("con la clave equivocada no revela NADA de sus empresas", async () => {
    const res = await login({ email: empresaA.usuario.email, password: "OtraCosa12345" });

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(empresaA.tenant.slug);
    expect(JSON.stringify(res.body)).not.toContain(empresaB.tenant.slug);
  });

  it("elegir una empresa emite la sesión de esa empresa", async () => {
    const paso1 = await login({ email: empresaA.usuario.email, password: PASSWORD });
    const agente = request.agent(app);

    const paso2 = await agente.post("/api/auth/elegir-empresa").send({
      token: paso1.body.elegirEmpresa.token,
      tenantId: empresaB.tenant.id,
    });

    expect(paso2.status).toBe(200);
    expect(paso2.body.usuario.tenantId).toBe(empresaB.tenant.id);
    // Y la sesión sirve de verdad, no solo la respuesta.
    const yo = await agente.get("/api/auth/me");
    expect(yo.status).toBe(200);
    expect(yo.body.usuario.tenantId).toBe(empresaB.tenant.id);
  });

  it("no se puede elegir una empresa donde la persona no tiene perfil", async () => {
    const ajena = await crearTenantDePrueba(PASSWORD);
    try {
      const paso1 = await login({ email: empresaA.usuario.email, password: PASSWORD });
      const res = await request(app).post("/api/auth/elegir-empresa").send({
        token: paso1.body.elegirEmpresa.token,
        tenantId: ajena.tenant.id,
      });
      // Genérico: no se confirma ni se niega que esa empresa exista.
      expect(res.status).toBe(401);
    } finally {
      await borrarTenantDePrueba(ajena.tenant.id);
    }
  });

  it("un token de selección inventado no sirve", async () => {
    const res = await request(app)
      .post("/api/auth/elegir-empresa")
      .send({ token: "no.es.un.token.valido.aunque.sea.largo", tenantId: empresaA.tenant.id });
    expect(res.status).toBe(401);
  });

  it("cambiar la clave entre los dos pasos invalida el token de selección", async () => {
    const paso1 = await login({ email: empresaA.usuario.email, password: PASSWORD });
    const cuenta = await cuentaDe(empresaA.usuario.email);
    const hashOriginal = cuenta.password_hash;

    // La clave cambió (otra sesión, una recuperación, un reseteo): el token
    // que se emitió con la anterior deja de servir, sin guardar nada en
    // ninguna tabla.
    await pool.query(`UPDATE cuentas SET password_hash = $1 WHERE id = $2`, [
      "$2b$12$otroHashCualquieraQueNoEsElOriginal000000000000000000000",
      cuenta.id,
    ]);

    const res = await request(app).post("/api/auth/elegir-empresa").send({
      token: paso1.body.elegirEmpresa.token,
      tenantId: empresaA.tenant.id,
    });
    expect(res.status).toBe(401);

    await pool.query(`UPDATE cuentas SET password_hash = $1 WHERE id = $2`, [
      hashOriginal,
      cuenta.id,
    ]);
  });

  // ── 3. Entrar por la dirección de una empresa ─────────────────────────

  it("entrando por la dirección de una empresa, la sesión es de esa empresa", async () => {
    const res = await login({
      tenantSlug: empresaA.tenant.slug,
      email: empresaA.usuario.email,
      password: PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.elegirEmpresa).toBeUndefined();
    expect(res.body.usuario.tenantId).toBe(empresaA.tenant.id);
  });

  it("sin perfil en esa empresa da el MISMO 401, no 'existís en otra'", async () => {
    const ajena = await crearTenantDePrueba(PASSWORD);
    try {
      const res = await login({
        tenantSlug: ajena.tenant.slug,
        email: empresaA.usuario.email,
        password: PASSWORD,
      });
      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.error).toMatch(/credenciales/i);
    } finally {
      await borrarTenantDePrueba(ajena.tenant.id);
    }
  });

  // ── 4. Personal operativo por DNI ─────────────────────────────────────

  describe("accesos por DNI", () => {
    const dni = idUnico("4").replace(/\D/g, "").slice(0, 8);
    const claveGrifero = "ClaveGrifero123";
    let grifero: string;

    beforeAll(async () => {
      const agenteA = await sesionDe(empresaA.tenant.slug, empresaA.usuario.email);
      const alta = await agenteA.post("/api/erp/usuarios").send({
        nombre: "Grifero de cancha",
        dni,
        password: claveGrifero,
        rol: "grifero",
      });
      expect(alta.status).toBe(201);
      grifero = alta.body.id;
    });

    it("el operativo no tiene cuenta: su clave es del perfil", async () => {
      const fila = await withTenant(empresaA.tenant.id, async (client) => {
        const r = await client.query(
          `SELECT cuenta_id, password_hash FROM usuarios WHERE id = $1`,
          [grifero]
        );
        return r.rows[0];
      });
      expect(fila.cuenta_id).toBeNull();
      expect(fila.password_hash).toBeTruthy();
    });

    it("entra con su DNI por la dirección de su empresa", async () => {
      const res = await login({
        tenantSlug: empresaA.tenant.slug,
        identificador: dni,
        password: claveGrifero,
      });
      expect(res.status).toBe(200);
      expect(res.body.usuario.tenantId).toBe(empresaA.tenant.id);
    });

    it("sin empresa le dice por dónde entrar, no 'credenciales inválidas'", async () => {
      // El DNI no es único entre empresas: sin empresa no hay a quién buscar.
      // Decirle "credenciales inválidas" lo mandaría a probar su clave diez
      // veces por un problema que no es de su clave.
      const res = await login({ identificador: dni, password: claveGrifero });
      expect(res.status).toBe(400);
      expect(res.body.message ?? res.body.error).toMatch(/dirección de tu empresa/i);
    });

    it("alguien con cuenta NO entra por DNI aunque lo tenga cargado", async () => {
      // Si entrara, usaría la clave vieja del perfil en vez de la de su
      // cuenta: dos puertas con dos claves para la misma persona.
      await withTenant(empresaA.tenant.id, (client) =>
        client.query(`UPDATE usuarios SET dni = $1 WHERE id = $2`, [
          "87654321",
          empresaA.usuario.id,
        ])
      );

      const res = await login({
        tenantSlug: empresaA.tenant.slug,
        identificador: "87654321",
        password: PASSWORD,
      });
      expect(res.status).toBe(401);
    });
  });

  // ── 5. Bajas, claves y sesiones ───────────────────────────────────────

  it("dar de baja el perfil en una empresa no toca el de la otra", async () => {
    const agenteB = await sesionDe(empresaB.tenant.slug, empresaB.usuario.email);
    const baja = await agenteB
      .patch(`/api/erp/usuarios/${perfilEnB}/estado`)
      .send({ activo: false, motivo: "prueba de baja por empresa" });
    expect(baja.status).toBe(200);

    try {
      // Ya no puede entrar a B...
      const enB = await login({
        tenantSlug: empresaB.tenant.slug,
        email: empresaA.usuario.email,
        password: PASSWORD,
      });
      expect(enB.status).toBe(401);

      // ...y como le queda una sola empresa, entra directo a A.
      const sinEmpresa = await login({ email: empresaA.usuario.email, password: PASSWORD });
      expect(sinEmpresa.status).toBe(200);
      expect(sinEmpresa.body.usuario.tenantId).toBe(empresaA.tenant.id);
    } finally {
      await agenteB.patch(`/api/erp/usuarios/${perfilEnB}/estado`).send({ activo: true });
    }
  });

  it("cambiar la clave cierra las sesiones en TODAS sus empresas", async () => {
    const enA = await sesionDe(empresaA.tenant.slug, empresaA.usuario.email);
    const enB = await sesionDe(empresaB.tenant.slug, empresaA.usuario.email);
    expect((await enA.get("/api/auth/me")).status).toBe(200);
    expect((await enB.get("/api/auth/me")).status).toBe(200);

    const cuenta = await cuentaDe(empresaA.usuario.email);
    const hashOriginal = cuenta.password_hash;

    const token = "t" + idUnico("reset");
    const { createHash } = await import("crypto");
    await pool.query(
      `INSERT INTO reset_tokens (cuenta_id, token_hash, expira_en)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [cuenta.id, createHash("sha256").update(token).digest("hex")]
    );
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "ClaveNuevaDeLaCuenta1" });
    expect(res.status).toBe(200);

    expect((await enA.get("/api/auth/me")).status).toBe(401);
    expect((await enB.get("/api/auth/me")).status).toBe(401);

    // Y la clave nueva vale en las dos empresas, porque es de la persona.
    for (const empresa of [empresaA, empresaB]) {
      const entra = await login({
        tenantSlug: empresa.tenant.slug,
        email: empresaA.usuario.email,
        password: "ClaveNuevaDeLaCuenta1",
      });
      expect(entra.status).toBe(200);
    }

    await pool.query(`UPDATE cuentas SET password_hash = $1 WHERE id = $2`, [
      hashOriginal,
      cuenta.id,
    ]);
  });

  it("la recuperación de clave no pide empresa y apunta a la cuenta", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: empresaA.usuario.email });
    expect(res.status).toBe(200);

    const cuenta = await cuentaDe(empresaA.usuario.email);
    const tokens = await pool.query(
      `SELECT cuenta_id, usuario_id FROM reset_tokens WHERE cuenta_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [cuenta.id]
    );
    expect(tokens.rows[0]).toBeDefined();
    expect(tokens.rows[0].usuario_id).toBeNull();
  });

  it("un admin NO le pone clave a alguien con cuenta: le manda el correo", async () => {
    const cuentaAntes = await cuentaDe(empresaA.usuario.email);
    const agenteB = await sesionDe(empresaB.tenant.slug, empresaB.usuario.email);

    const res = await agenteB
      .patch(`/api/erp/usuarios/${perfilEnB}/clave`)
      .send({ password: "ClaveQueElAdminQuisoPoner1" });

    expect(res.status).toBe(200);
    expect(res.body.modo).toBe("correo-enviado");

    // La clave de la cuenta quedó intacta: el admin de B no puede cambiar la
    // clave con la que esa persona entra a la empresa A.
    const cuentaDespues = await cuentaDe(empresaA.usuario.email);
    expect(cuentaDespues.password_hash).toBe(cuentaAntes.password_hash);

    const conLaDelAdmin = await login({
      tenantSlug: empresaB.tenant.slug,
      email: empresaA.usuario.email,
      password: "ClaveQueElAdminQuisoPoner1",
    });
    expect(conLaDelAdmin.status).toBe(401);
  });

  // ── 6. El aislamiento sigue intacto ───────────────────────────────────

  it("la política de cuenta deja ver los perfiles de esa cuenta y nada más", async () => {
    const cuentaCompartida = await cuentaDe(empresaA.usuario.email);
    const cuentaSolaDeB = await cuentaDe(empresaB.usuario.email);

    const perfiles = await withCuenta(cuentaCompartida.id, async (client) => {
      const r = await client.query(`SELECT cuenta_id FROM usuarios`);
      return r.rows;
    });

    expect(perfiles).toHaveLength(2);
    expect(perfiles.every((p) => p.cuenta_id === cuentaCompartida.id)).toBe(true);
    expect(perfiles.some((p) => p.cuenta_id === cuentaSolaDeB.id)).toBe(false);
  });

  it("la política de cuenta es SOLO de lectura", async () => {
    const cuenta = await cuentaDe(empresaA.usuario.email);

    const afectadas = await withCuenta(cuenta.id, async (client) => {
      const r = await client.query(`UPDATE usuarios SET nombre = nombre WHERE cuenta_id = $1`, [
        cuenta.id,
      ]);
      return r.rowCount;
    });

    expect(afectadas).toBe(0);
  });

  it("una empresa sigue viendo solo sus propios perfiles", async () => {
    const deA = await withTenant(empresaA.tenant.id, async (client) => {
      const r = await client.query(`SELECT DISTINCT tenant_id FROM usuarios`);
      return r.rows;
    });

    expect(deA).toHaveLength(1);
    expect(deA[0].tenant_id).toBe(empresaA.tenant.id);
  });
});
