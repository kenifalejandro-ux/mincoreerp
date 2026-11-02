import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { closeDatabase } from "../src/server/config/database";
import { MODULOS_ERP } from "../src/modules/registry";

const BEARER = `Bearer ${env.platformAdminToken}`;

describe("panel de plataforma: módulos por tenant y por usuario", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";

  afterAll(async () => {
    if (tenantId) await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("un tenant nuevo arranca con todos los módulos del registry habilitados", async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;

    const res = await request(app)
      .get(`/api/platform/tenants/${tenantId}/modulos`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);
    // Contra el registry y no un número fijo -- un módulo nuevo no debe
    // romper este test, solo agregarse a la cuenta.
    expect(res.body.modulos).toHaveLength(MODULOS_ERP.length);
    expect(res.body.modulos.every((m: { estado: string }) => m.estado === "habilitado")).toBe(true);
  });

  it("desactivar un módulo del tenant lo saca de modulosPermitidos en el próximo login, y bloquea la ruta con 403", async () => {
    const configuraciones = [
      ...["repuestos", "combustible", "documentos", "dashboard", "flota", "checklists"].map(
        (modulo) => ({
          modulo,
          estado: "habilitado",
        })
      ),
      { modulo: "iperc", estado: "deshabilitado" },
    ];

    const desactivar = await request(app)
      .put(`/api/platform/tenants/${tenantId}/modulos`)
      .set("Authorization", BEARER)
      .send({ configuraciones });
    expect(desactivar.status).toBe(200);
    const iperc = desactivar.body.modulos.find((m: { modulo: string }) => m.modulo === "iperc");
    expect(iperc.estado).toBe("deshabilitado");

    const usuarios = await request(app)
      .get(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", BEARER);
    const admin = usuarios.body.usuarios[0];

    const agent = request.agent(app);
    const login = await agent
      .post("/api/auth/login")
      .send({ tenantSlug, email: admin.email, password });
    expect(login.status).toBe(200);
    expect(login.body.usuario.modulosPermitidos).not.toContain("iperc");
    expect(login.body.usuario.modulosPermitidos).toContain("repuestos");

    const bloqueado = await agent.get("/api/erp/iperc");
    expect(bloqueado.status).toBe(403);

    const permitido = await agent.get("/api/erp/repuestos");
    expect(permitido.status).toBe(200);

    // Reactivar para no ensuciar el resto de la suite / dejarlo como estaba.
    const reactivar = await request(app)
      .put(`/api/platform/tenants/${tenantId}/modulos`)
      .set("Authorization", BEARER)
      .send({
        configuraciones: [
          "repuestos",
          "combustible",
          "documentos",
          "dashboard",
          "flota",
          "checklists",
          "iperc",
        ].map((modulo) => ({ modulo, estado: "habilitado" })),
      });
    expect(reactivar.status).toBe(200);
  });

  it("asignar módulos a un usuario específico: solo ve lo que tiene asignado, no todo lo que su tenant tiene habilitado", async () => {
    const emailOperador = `${idUnico("operador-modulos")}@test.local`;
    const crear = await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", BEARER)
      .send({ nombre: "Operador módulos", email: emailOperador, password, rol: "operador" });
    expect(crear.status).toBe(201);
    // Por defecto hereda todo lo habilitado del tenant.
    expect(crear.body.usuario.modulosPermitidos).toContain("iperc");
    const usuarioId = crear.body.usuario.id;

    const restringir = await request(app)
      .put(`/api/platform/tenants/${tenantId}/usuarios/${usuarioId}/modulos`)
      .set("Authorization", BEARER)
      .send({ modulos: ["repuestos"] });
    expect(restringir.status).toBe(200);
    expect(
      restringir.body.modulos.find((m: { modulo: string }) => m.modulo === "repuestos").asignado
    ).toBe(true);
    expect(
      restringir.body.modulos.find((m: { modulo: string }) => m.modulo === "combustible").asignado
    ).toBe(false);

    const agent = request.agent(app);
    const login = await agent
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailOperador, password });
    expect(login.status).toBe(200);
    expect(login.body.usuario.modulosPermitidos).toEqual(["repuestos"]);

    const permitido = await agent.get("/api/erp/repuestos");
    expect(permitido.status).toBe(200);
    const bloqueado = await agent.get("/api/erp/combustible");
    expect(bloqueado.status).toBe(403);
  });

  it("desactivar un usuario por la ruta anidada de plataforma revoca su sesión de inmediato", async () => {
    const emailUsuario = `${idUnico("desactivar")}@test.local`;
    const crear = await request(app)
      .post(`/api/platform/tenants/${tenantId}/usuarios`)
      .set("Authorization", BEARER)
      .send({ nombre: "A desactivar", email: emailUsuario, password, rol: "operador" });
    const usuarioId = crear.body.usuario.id;

    const agent = request.agent(app);
    const login = await agent
      .post("/api/auth/login")
      .send({ tenantSlug, email: emailUsuario, password });
    expect(login.status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(200);

    const desactivar = await request(app)
      .patch(`/api/platform/tenants/${tenantId}/usuarios/${usuarioId}/estado`)
      .set("Authorization", BEARER)
      .send({ activo: false });
    expect(desactivar.status).toBe(200);
    expect(desactivar.body.usuario.activo).toBe(false);

    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("una operación de plataforma sobre un usuario que no pertenece al tenant indicado da 404, no filtra data de otro tenant", async () => {
    const otro = await crearTenantDePrueba(password);
    try {
      const res = await request(app)
        .patch(`/api/platform/tenants/${tenantId}/usuarios/${otro.usuario.id}/estado`)
        .set("Authorization", BEARER)
        .send({ activo: false });
      expect(res.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });
});
