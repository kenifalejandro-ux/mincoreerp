/** tests/permisos-por-perfil.test.ts
 *
 * Las **autonomías** (entrega 3, migración 0089): un perfil = tipo de usuario
 * + qué módulos ve + con qué nivel. Diseño: docs/architecture/
 * cuentas-perfiles-y-administracion.md §10.
 *
 * Lo que se fija acá:
 *
 * 1. Que "consultas" signifique de verdad no poder escribir, en TODOS los
 *    módulos y sin que nadie tenga que acordarse de proteger un endpoint
 *    nuevo.
 * 2. Que un administrador no pueda darle a nadie --ni a sí mismo-- un módulo
 *    que su empresa no contrató, ni editar sus propios permisos.
 * 3. Que quitar acceso sea INMEDIATO (se cierran las sesiones) y darlo no
 *    necesite echar a nadie.
 * 4. Que dar de alta a alguien con correo no le ponga una clave: la define
 *    ella desde la invitación.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";

describe("permisos por perfil (autonomías)", () => {
  let empresa: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  let admin: ReturnType<typeof request.agent>;
  /** Una persona de oficina a la que se le mueven los permisos. */
  let operadorId: string;
  const emailOperador = () => `operador-${empresa.tenant.slug}@test.local`;

  const sesionDe = async (email: string, password: string) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, email, password });
    expect(res.status).toBe(200);
    return agente;
  };

  const permisos = async (usuarioId: string) => {
    const res = await admin.get(`/api/erp/usuarios/${usuarioId}/permisos`);
    expect(res.status).toBe(200);
    return res.body as {
      rol: string;
      modulos: { modulo: string; asignado: boolean; nivel: string }[];
    };
  };

  /** Deja los módulos como están salvo el que se indica. */
  const ponerNivel = async (
    usuarioId: string,
    modulo: string,
    cambio: { asignado: boolean; nivel?: "operar" | "consultas" }
  ) => {
    const actuales = await permisos(usuarioId);
    return admin.put(`/api/erp/usuarios/${usuarioId}/permisos`).send({
      modulos: actuales.modulos.map((m) =>
        m.modulo === modulo
          ? { modulo, asignado: cambio.asignado, nivel: cambio.nivel ?? m.nivel }
          : { modulo: m.modulo, asignado: m.asignado, nivel: m.nivel }
      ),
      motivo: "prueba automatizada",
    });
  };

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    admin = await sesionDe(empresa.usuario.email, PASSWORD);

    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Operador de prueba",
      email: emailOperador(),
      password: PASSWORD,
      rol: "operador",
    });
    expect(alta.status).toBe(201);
    operadorId = alta.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(empresa.tenant.id);
    await closeDatabase();
  });

  // ── 1. Qué significa cada nivel ───────────────────────────────────────

  it("por defecto un módulo asignado es para operar", async () => {
    const actuales = await permisos(operadorId);
    const combustible = actuales.modulos.find((m) => m.modulo === "combustible");

    expect(combustible).toBeDefined();
    expect(combustible!.asignado).toBe(true);
    expect(combustible!.nivel).toBe("operar");
  });

  it("con nivel 'consultas' puede ver pero no escribir", async () => {
    const cambio = await ponerNivel(operadorId, "combustible", {
      asignado: true,
      nivel: "consultas",
    });
    expect(cambio.status).toBe(200);

    // Sesión nueva: el nivel viaja en el token, así que hay que tomar uno.
    const operador = await sesionDe(emailOperador(), PASSWORD);

    const consulta = await operador.get("/api/erp/combustible");
    expect(consulta.status).toBe(200);

    const escritura = await operador.post("/api/erp/combustible").send({
      nombre: "Tanque que no debería crearse",
      capacidad_litros: 1000,
    });
    expect(escritura.status).toBe(403);
    expect(escritura.body.message).toMatch(/consultar/i);
  });

  it("sin acceso no ve el módulo en absoluto", async () => {
    const cambio = await ponerNivel(operadorId, "combustible", { asignado: false });
    expect(cambio.status).toBe(200);

    const operador = await sesionDe(emailOperador(), PASSWORD);
    const consulta = await operador.get("/api/erp/combustible");

    expect(consulta.status).toBe(403);
    // "No disponible", no "solo podés consultar": el segundo mensaje ya
    // admitiría que el módulo existe y que alguien más lo usa.
    expect(consulta.body.message).toMatch(/no disponible/i);
  });

  it("volver a darle el módulo lo deja operar de nuevo", async () => {
    const cambio = await ponerNivel(operadorId, "combustible", {
      asignado: true,
      nivel: "operar",
    });
    expect(cambio.status).toBe(200);

    const operador = await sesionDe(emailOperador(), PASSWORD);
    expect((await operador.get("/api/erp/combustible")).status).toBe(200);
  });

  // ── 2. Lo que un administrador NO puede hacer ─────────────────────────

  it("no puede asignar un módulo que la empresa no contrató", async () => {
    await withTenant(empresa.tenant.id, (client) =>
      client.query(
        `UPDATE tenant_modulos SET estado = 'deshabilitado' WHERE tenant_id = $1 AND modulo = 'documentos'`,
        [empresa.tenant.id]
      )
    );

    try {
      // Ni siquiera aparece en la lista de lo que se puede repartir.
      const lista = await permisos(operadorId);
      expect(lista.modulos.some((m) => m.modulo === "documentos")).toBe(false);

      // El alta le había asignado todos los módulos del tenant; se saca la
      // fila para que lo que se mide sea si el PUT la vuelve a crear.
      await withTenant(empresa.tenant.id, (client) =>
        client.query(
          `DELETE FROM usuario_modulos WHERE usuario_id = $1 AND modulo = 'documentos'`,
          [operadorId]
        )
      );

      // Mandarlo a mano no lo asigna.
      const res = await admin.put(`/api/erp/usuarios/${operadorId}/permisos`).send({
        modulos: [{ modulo: "documentos", asignado: true, nivel: "operar" }],
      });
      expect(res.status).toBe(200);

      const despues = await withTenant(empresa.tenant.id, (client) =>
        client.query(
          `SELECT 1 FROM usuario_modulos WHERE usuario_id = $1 AND modulo = 'documentos'`,
          [operadorId]
        )
      );
      expect(despues.rowCount).toBe(0);
    } finally {
      await withTenant(empresa.tenant.id, (client) =>
        client.query(
          `UPDATE tenant_modulos SET estado = 'habilitado' WHERE tenant_id = $1 AND modulo = 'documentos'`,
          [empresa.tenant.id]
        )
      );
    }
  });

  it("no puede cambiarse los permisos a sí mismo", async () => {
    const res = await admin.put(`/api/erp/usuarios/${empresa.usuario.id}/permisos`).send({
      modulos: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/otro administrador/i);
  });

  it("quien no es admin no puede tocar permisos de nadie", async () => {
    const operador = await sesionDe(emailOperador(), PASSWORD);

    expect((await operador.get(`/api/erp/usuarios/${operadorId}/permisos`)).status).toBe(403);
    expect(
      (await operador.put(`/api/erp/usuarios/${operadorId}/permisos`).send({ modulos: [] })).status
    ).toBe(403);
  });

  // ── 3. Quitar es inmediato; dar puede esperar ─────────────────────────

  it("quitar acceso cierra las sesiones abiertas de esa persona", async () => {
    const operador = await sesionDe(emailOperador(), PASSWORD);
    expect((await operador.get("/api/auth/me")).status).toBe(200);

    const cambio = await ponerNivel(operadorId, "equipos", { asignado: false });
    expect(cambio.body.recorta).toBe(true);

    // Sin esto, alguien a quien le acaban de quitar el acceso lo conserva
    // hasta que su token se renueve solo.
    expect((await operador.get("/api/auth/me")).status).toBe(401);
  });

  it("darle un módulo más no lo echa de su sesión", async () => {
    const operador = await sesionDe(emailOperador(), PASSWORD);

    const cambio = await ponerNivel(operadorId, "equipos", { asignado: true, nivel: "operar" });
    expect(cambio.body.recorta).toBe(false);

    expect((await operador.get("/api/auth/me")).status).toBe(200);
  });

  it("el cambio queda en la bitácora con el antes y el después", async () => {
    await ponerNivel(operadorId, "repuestos", { asignado: true, nivel: "consultas" });

    const fila = await pool.query(
      `SELECT detalle FROM platform_audit_log
        WHERE accion = 'cambiar_permisos_usuario' AND tenant_id = $1
        ORDER BY creado_en DESC LIMIT 1`,
      [empresa.tenant.id]
    );

    const detalle = fila.rows[0].detalle;
    expect(
      detalle.antes.modulos.find((m: { modulo: string }) => m.modulo === "repuestos").nivel
    ).toBe("operar");
    expect(
      detalle.despues.modulos.find((m: { modulo: string }) => m.modulo === "repuestos").nivel
    ).toBe("consultas");
    expect(detalle.motivo).toBe("prueba automatizada");
  });

  // ── 4. Alta por invitación ────────────────────────────────────────────

  describe("alta de alguien con correo", () => {
    const emailNuevo = () => `invitado-${empresa.tenant.slug}@test.local`;

    it("no le pone clave: le manda una invitación", async () => {
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: "Persona invitada",
        email: emailNuevo(),
        rol: "operador",
      });

      expect(alta.status).toBe(201);
      expect(alta.body.modo).toBe("invitacion-enviada");

      // La cuenta existe pero todavía no tiene clave, así que no puede entrar.
      const cuenta = (
        await pool.query(`SELECT id, password_hash FROM cuentas WHERE email = $1`, [emailNuevo()])
      ).rows[0];
      expect(cuenta).toBeDefined();
      expect(cuenta.password_hash).toBeNull();

      const intento = await request(app).post("/api/auth/login").send({
        tenantSlug: empresa.tenant.slug,
        email: emailNuevo(),
        password: "LoQueSea12345",
      });
      expect(intento.status).toBe(401);

      // Y hay un enlace esperándola, que es lo que le deja definir la suya.
      const invitacion = await pool.query(
        `SELECT expira_en FROM reset_tokens WHERE cuenta_id = $1 AND usado_en IS NULL`,
        [cuenta.id]
      );
      expect(invitacion.rowCount).toBe(1);
      // Una semana, no una hora: la pide un admin, no la persona.
      const horas =
        (new Date(invitacion.rows[0].expira_en).getTime() - Date.now()) / (60 * 60 * 1000);
      expect(horas).toBeGreaterThan(24);
    });

    it("sin correo (personal de cancha) sigue siendo clave para dictar", async () => {
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: "Grifero de cancha",
        dni: "11223344",
        password: "ClaveDeCancha123",
        rol: "grifero",
      });

      expect(alta.status).toBe(201);
      expect(alta.body.modo).toBe("clave-temporal");
    });

    it("sin correo y sin clave, el alta se rechaza", async () => {
      const alta = await admin.post("/api/erp/usuarios").send({
        nombre: "Nadie",
        dni: "99887766",
        rol: "grifero",
      });

      expect(alta.status).toBe(400);
    });
  });
});
