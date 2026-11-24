/** Perfiles de mantenimiento «Mecánico» y «Operario» (migrations/0202).
 *
 *  Nacen sin ningún módulo: las rutas de Checklists, IPERC y Órdenes de trabajo hoy solo aceptan
 *  admin/operador, y asignarles el módulo sin el permiso los dejaría viendo pantallas que dan 403. Lo que se
 *  prueba acá es que el alta con el rol nuevo funciona, que el perfil NO hereda módulos de la empresa (ni
 *  Combustible, que es lo que recibe cualquier otro rol de cancha por defecto) y que los demás perfiles no
 *  cambiaron. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, dniUnico } from "./helpers";
import { closeDatabase } from "../src/server/config/database";

describe("roles de mantenimiento: mecánico y operario (0202)", () => {
  const password = "ClaveDePrueba123";
  const admin = request.agent(app);
  let tenantId: string;
  let slug: string;

  async function entrar(rol: string) {
    const agente = request.agent(app);
    const dni = dniUnico();
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: `P ${rol}`, dni, password, rol });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    expect(alta.body.rol).toBe(rol);
    const login = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: slug, identificador: dni, password });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    return { agente, usuario: login.body.usuario ?? login.body };
  }

  beforeAll(async () => {
    const c = await crearTenantDePrueba(password);
    tenantId = c.tenant.id;
    slug = c.tenant.slug;
    await admin
      .post("/api/auth/login")
      .send({ tenantSlug: slug, email: c.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  for (const rol of ["mecanico", "operario"]) {
    it(`${rol}: se da de alta, entra y no recibe ningún módulo`, async () => {
      const { usuario } = await entrar(rol);
      expect(usuario.rol).toBe(rol);
      expect(usuario.modulosPermitidos).toEqual([]);
    });

    it(`${rol}: no puede tocar Combustible ni Equipos aunque la empresa los tenga`, async () => {
      const { agente } = await entrar(rol);
      const combustible = await agente.get("/api/erp/combustible");
      const equipos = await agente.get("/api/erp/equipos");
      expect([401, 403]).toContain(combustible.status);
      expect([401, 403]).toContain(equipos.status);
    });
  }

  it("el alta rechaza un rol inventado", async () => {
    const alta = await admin
      .post("/api/erp/usuarios")
      .send({ nombre: "X", dni: dniUnico(), password, rol: "soldador" });
    expect(alta.status).toBe(400);
  });

  it("los perfiles que ya existían no cambiaron: el encargado de urea sigue entrando a Combustible", async () => {
    const { usuario } = await entrar("encargado_urea");
    expect(usuario.modulosPermitidos).toEqual(["combustible"]);
  });
});
