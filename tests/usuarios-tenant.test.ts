/** tests/usuarios-tenant.test.ts
 *
 * El admin de una empresa da de alta y de baja a SU propia gente.
 *
 * Antes de esto, los usuarios de un tenant solo se creaban desde el panel de
 * plataforma -- o sea, el dueño del ERP. Con el pedido del cliente (dar
 * acceso al grifero, a los conductores de ruta y al personal de mina) eso
 * dejaba al proveedor de operador permanente de las altas y bajas de personal
 * de cada empresa.
 *
 * El endpoint más importante de acá no es el alta sino el reset de clave:
 * desde la migración 0084 hay usuarios que entran con DNI y NO tienen correo,
 * así que "olvidé mi contraseña" --que manda un enlace por mail-- no existe
 * para ellos. Sin este reset, un grifero que se olvida la clave queda afuera.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("usuarios del tenant: el admin administra a su gente", () => {
  let tenantId: string;
  let slug: string;
  let adminId: string;
  const password = "ClaveDePrueba123";
  const ag = request.agent(app);
  let seq = 0;
  const dniUnico = () => String(81000000 + seq++);

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    adminId = c.usuario.id;
    await ag.post("/api/auth/login").send({ tenantSlug: slug, email: c.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  const crear = (body: Record<string, unknown>) =>
    ag.post("/api/erp/usuarios").send({ nombre: "Persona de Cancha", password, ...body });

  const login = (identificador: string, pass = password) =>
    request(app).post("/api/auth/login").send({ tenantSlug: slug, identificador, password: pass });

  // ── Alta y listado ────────────────────────────────────────────────────

  it("el admin ve la lista de su empresa, con DNI incluido", async () => {
    const dni = dniUnico();
    await crear({ dni });

    const res = await ag.get("/api/erp/usuarios");
    expect(res.status).toBe(200);
    expect(res.body.data.some((u: { dni: string }) => u.dni === dni)).toBe(true);
    // Nunca el hash, ni siquiera para el admin de la propia empresa.
    expect(JSON.stringify(res.body)).not.toContain("password_hash");
  });

  it("la lista NO cruza empresas", async () => {
    const otro = await crearTenantDePrueba(password);
    try {
      const res = await ag.get("/api/erp/usuarios");
      expect(res.body.data.some((u: { id: string }) => u.id === otro.usuario.id)).toBe(false);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("un operador NO puede crear usuarios", async () => {
    // Crear una credencial es dar acceso al sistema: es del admin, no de
    // quien solo carga vales.
    const dni = dniUnico();
    await crear({ dni, rol: "operador" });

    const agOp = request.agent(app);
    await agOp.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });

    expect((await agOp.get("/api/erp/usuarios")).status).toBe(403);
    const alta = await agOp
      .post("/api/erp/usuarios")
      .send({ nombre: "Colado", password, dni: dniUnico() });
    expect(alta.status).toBe(403);
  });

  // ── El reset de clave, que es lo que reemplaza al "olvidé mi contraseña" ──

  it("el admin le pone una clave temporal y el usuario entra con ella", async () => {
    const dni = dniUnico();
    const alta = await crear({ dni });
    const nueva = "ClaveTemporal456";

    const res = await ag.patch(`/api/erp/usuarios/${alta.body.id}/clave`).send({ password: nueva });
    expect(res.status).toBe(200);

    expect((await login(dni, nueva)).status).toBe(200);
    // La anterior deja de servir en el mismo acto.
    expect((await login(dni, password)).status).toBe(401);
  });

  it("la clave temporal obliga a cambiarla al entrar", async () => {
    // Si no, el admin termina sabiendo la contraseña con la que su empleado
    // firma vales -- y la trazabilidad del vale deja de significar nada.
    const dni = dniUnico();
    const alta = await crear({ dni });
    await ag.patch(`/api/erp/usuarios/${alta.body.id}/clave`).send({ password: "Temporal789xyz" });

    const res = await login(dni, "Temporal789xyz");
    expect(res.body.usuario.debeCambiarPassword).toBe(true);
  });

  it("resetear la clave corta las sesiones que esa persona tenga abiertas", async () => {
    // El caso real es el que motiva un reset: alguien más sabía la clave.
    // Cambiarla sin cerrar sesiones lo dejaría adentro.
    const dni = dniUnico();
    const alta = await crear({ dni, rol: "operador" });

    const agU = request.agent(app);
    await agU.post("/api/auth/login").send({ tenantSlug: slug, identificador: dni, password });
    expect((await agU.get("/api/erp/equipos")).status).toBe(200);

    await ag.patch(`/api/erp/usuarios/${alta.body.id}/clave`).send({ password: "OtraClave12345" });

    expect((await agU.get("/api/erp/equipos")).status).toBe(401);
  });

  it("el reset queda en la bitácora, sin la contraseña", async () => {
    const dni = dniUnico();
    const alta = await crear({ dni });
    await ag.patch(`/api/erp/usuarios/${alta.body.id}/clave`).send({ password: "AuditadaXyz123" });

    const log = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT actor_label, detalle FROM platform_audit_log
          WHERE tenant_id = $1 AND accion = 'resetear_clave_usuario' AND usuario_id = $2
          ORDER BY id DESC LIMIT 1`,
        [tenantId, alta.body.id]
      )
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].detalle.identificador).toBe(dni);
    expect(JSON.stringify(log.rows[0].detalle)).not.toContain("AuditadaXyz123");
  });

  it("no se puede resetear la clave de alguien de otra empresa", async () => {
    const otro = await crearTenantDePrueba(password);
    try {
      const res = await ag
        .patch(`/api/erp/usuarios/${otro.usuario.id}/clave`)
        .send({ password: "IntentoCruzado1" });
      // 404, no 403: con RLS la fila directamente no existe para este tenant,
      // y la respuesta no debe confirmar que ese id existe en algún lado.
      expect(res.status).toBe(404);
      // Y la víctima sigue entrando con su clave de siempre.
      const sigue = await request(app)
        .post("/api/auth/login")
        .send({ tenantSlug: otro.tenant.slug, identificador: otro.usuario.email, password });
      expect(sigue.status).toBe(200);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("un operador no puede resetearle la clave a nadie", async () => {
    const dniOp = dniUnico();
    await crear({ dni: dniOp, rol: "operador" });
    const victima = await crear({ dni: dniUnico() });

    const agOp = request.agent(app);
    await agOp.post("/api/auth/login").send({ tenantSlug: slug, identificador: dniOp, password });

    const res = await agOp
      .patch(`/api/erp/usuarios/${victima.body.id}/clave`)
      .send({ password: "EscalarPrivilegios1" });
    expect(res.status).toBe(403);
  });

  // ── Baja ──────────────────────────────────────────────────────────────

  it("dar de baja exige motivo y deja al usuario afuera", async () => {
    const dni = dniUnico();
    const alta = await crear({ dni });

    const sinMotivo = await ag.patch(`/api/erp/usuarios/${alta.body.id}/estado`).send({
      activo: false,
    });
    expect(sinMotivo.status).toBe(400);

    const conMotivo = await ag
      .patch(`/api/erp/usuarios/${alta.body.id}/estado`)
      .send({ activo: false, motivo: "Dejó la empresa" });
    expect(conMotivo.status).toBe(200);
    expect(conMotivo.body.activo).toBe(false);

    expect((await login(dni)).status).toBe(401);
  });

  it("reactivar no pide motivo", async () => {
    // Volver a habilitar a alguien no es una acción correctiva: la que hay
    // que poder explicar después es la baja.
    const dni = dniUnico();
    const alta = await crear({ dni });
    await ag
      .patch(`/api/erp/usuarios/${alta.body.id}/estado`)
      .send({ activo: false, motivo: "Licencia" });

    const res = await ag.patch(`/api/erp/usuarios/${alta.body.id}/estado`).send({ activo: true });
    expect(res.status).toBe(200);
    expect((await login(dni)).status).toBe(200);
  });

  it("el admin no puede desactivarse a sí mismo", async () => {
    // Si pudiera, se quedaría afuera de su propia empresa y necesitaría al
    // proveedor para volver a entrar.
    const res = await ag
      .patch(`/api/erp/usuarios/${adminId}/estado`)
      .send({ activo: false, motivo: "Error de dedo" });
    expect(res.status).toBe(400);
  });

  it("no se puede dar de baja a alguien de otra empresa", async () => {
    const otro = await crearTenantDePrueba(password);
    try {
      const res = await ag
        .patch(`/api/erp/usuarios/${otro.usuario.id}/estado`)
        .send({ activo: false, motivo: "Ajeno" });
      expect(res.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  // ── Sin sesión no hay nada ────────────────────────────────────────────

  it("sin sesión no se lista ni se crea", async () => {
    expect((await request(app).get("/api/erp/usuarios")).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/erp/usuarios")
          .send({ nombre: "X", password, dni: "99999999" })
      ).status
    ).toBe(401);
  });
});
