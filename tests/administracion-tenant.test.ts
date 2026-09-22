/** tests/administracion-tenant.test.ts
 *
 * El menú **Administración** de cada empresa (entrega 4, migración 0090):
 * estado del perfil, celular y log de eventos. Diseño: docs/architecture/
 * cuentas-perfiles-y-administracion.md §10.
 *
 * Lo que se fija acá:
 *
 * 1. Que "bloqueado" y "dado de baja" sigan siendo cosas distintas, porque se
 *    resuelven distinto: uno se desbloquea, al otro hay que reactivarlo.
 * 2. Que el bloqueo automático frene a quien prueba claves sin dejar afuera
 *    al grifero que se equivocó dos veces.
 * 3. Que el log de eventos muestre lo de ESTA empresa y nada de otra.
 * 4. Que `activo` y `estado` nunca se contradigan: hay código en producción
 *    leyendo el booleano (los avisos anti-fraude de combustible salen de ahí).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { withTenant, closeDatabase } from "../src/server/config/database";

const PASSWORD = "ClaveDePrueba123";

describe("menú Administración", () => {
  let empresa: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  let admin: ReturnType<typeof request.agent>;
  let griferoId: string;
  const dniGrifero = "55667788";
  const claveGrifero = "ClaveDelGrifero1";

  const sesionDe = async (email: string, password: string) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, email, password });
    expect(res.status).toBe(200);
    return agente;
  };

  const estadoEnBase = async (usuarioId: string) =>
    (
      await withTenant(empresa.tenant.id, (client) =>
        client.query(
          `SELECT activo, estado, intentos_fallidos, bloqueado_en, celular
             FROM usuarios WHERE id = $1`,
          [usuarioId]
        )
      )
    ).rows[0];

  const entrarConDni = (password: string) =>
    request(app).post("/api/auth/login").send({
      tenantSlug: empresa.tenant.slug,
      identificador: dniGrifero,
      password,
    });

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    admin = await sesionDe(empresa.usuario.email, PASSWORD);

    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Grifero del turno noche",
      dni: dniGrifero,
      password: claveGrifero,
      rol: "grifero",
    });
    expect(alta.status).toBe(201);
    griferoId = alta.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(empresa.tenant.id);
    await closeDatabase();
  });

  // ── 1. Los tres estados ───────────────────────────────────────────────

  it("el listado trae estado, celular y el booleano viejo", async () => {
    const res = await admin.get("/api/erp/usuarios");
    expect(res.status).toBe(200);

    const grifero = res.body.data.find((u: { id: string }) => u.id === griferoId);
    expect(grifero.estado).toBe("activo");
    expect(grifero.activo).toBe(true);
    expect(grifero.celular).toBeNull();
  });

  it("se le puede cargar el celular sin tocarle nada más", async () => {
    const res = await admin.patch(`/api/erp/usuarios/${griferoId}`).send({ celular: "987654321" });

    expect(res.status).toBe(200);
    expect(res.body.celular).toBe("987654321");
    expect(res.body.estado).toBe("activo");
  });

  it("dar de baja deja 'inactivo', no 'bloqueado'", async () => {
    const res = await admin
      .patch(`/api/erp/usuarios/${griferoId}/estado`)
      .send({ estado: "inactivo", motivo: "prueba de baja" });
    expect(res.status).toBe(200);

    const fila = await estadoEnBase(griferoId);
    expect(fila.estado).toBe("inactivo");
    // El booleano lo mantiene el trigger: hay código leyéndolo todavía.
    expect(fila.activo).toBe(false);

    const vuelta = await admin
      .patch(`/api/erp/usuarios/${griferoId}/estado`)
      .send({ estado: "activo" });
    expect(vuelta.status).toBe(200);
    expect((await estadoEnBase(griferoId)).activo).toBe(true);
  });

  it("el `activo` de antes sigue funcionando y significa baja", async () => {
    // Una pestaña abierta con el bundle viejo, o la cola offline, pueden
    // seguir mandando el booleano.
    const res = await admin
      .patch(`/api/erp/usuarios/${griferoId}/estado`)
      .send({ activo: false, motivo: "prueba del alias viejo" });
    expect(res.status).toBe(200);

    const fila = await estadoEnBase(griferoId);
    expect(fila.estado).toBe("inactivo");

    await admin.patch(`/api/erp/usuarios/${griferoId}/estado`).send({ activo: true });
  });

  it("bajar a alguien exige motivo", async () => {
    const res = await admin
      .patch(`/api/erp/usuarios/${griferoId}/estado`)
      .send({ estado: "inactivo" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/motivo/i);
  });

  // ── 2. Bloqueo automático y desbloqueo ────────────────────────────────

  it("erra la clave unas veces y todavía puede entrar", async () => {
    for (let intento = 0; intento < 3; intento++) {
      expect((await entrarConDni("EstaNoEsLaClave1")).status).toBe(401);
    }

    const fila = await estadoEnBase(griferoId);
    expect(fila.intentos_fallidos).toBe(3);
    expect(fila.estado).toBe("activo");

    // Tres errores no dejan a un grifero afuera de su turno.
    expect((await entrarConDni(claveGrifero)).status).toBe(200);
    // Y entrar bien borra la cuenta de errores.
    expect((await estadoEnBase(griferoId)).intentos_fallidos).toBe(0);
  });

  it("a los diez errores seguidos queda bloqueado", async () => {
    for (let intento = 0; intento < 10; intento++) {
      expect((await entrarConDni("EstaNoEsLaClave1")).status).toBe(401);
    }

    const fila = await estadoEnBase(griferoId);
    expect(fila.estado).toBe("bloqueado");
    expect(fila.activo).toBe(false);
    expect(fila.bloqueado_en).not.toBeNull();

    // Ni con la clave correcta: bloqueado es bloqueado.
    const conLaBuena = await entrarConDni(claveGrifero);
    expect(conLaBuena.status).toBe(401);
    // Y el mensaje es el de siempre: decirle "estás bloqueado" a quien está
    // probando claves le confirma que ese DNI existe.
    expect(conLaBuena.body.message).toMatch(/credenciales/i);
  });

  it("el admin lo desbloquea y vuelve a entrar", async () => {
    const res = await admin
      .patch(`/api/erp/usuarios/${griferoId}/estado`)
      .send({ estado: "activo" });
    expect(res.status).toBe(200);

    const fila = await estadoEnBase(griferoId);
    expect(fila.estado).toBe("activo");
    // Sin esto se volvería a bloquear con el primer error.
    expect(fila.intentos_fallidos).toBe(0);
    expect(fila.bloqueado_en).toBeNull();

    expect((await entrarConDni(claveGrifero)).status).toBe(200);
  });

  it("los errores de una cuenta con correo NO bloquean el perfil", async () => {
    // La clave de quien entra con correo es de su CUENTA: contar esos errores
    // en un perfil bloquearía el acceso a una empresa por intentos que pueden
    // venir de otra.
    for (let intento = 0; intento < 12; intento++) {
      await request(app).post("/api/auth/login").send({
        tenantSlug: empresa.tenant.slug,
        email: empresa.usuario.email,
        password: "ClaveEquivocada123",
      });
    }

    const fila = await estadoEnBase(empresa.usuario.id);
    expect(fila.estado).toBe("activo");
    expect(fila.intentos_fallidos).toBe(0);
  });

  // ── 3. Log de eventos ─────────────────────────────────────────────────

  it("muestra lo que se hizo en esta empresa", async () => {
    const res = await admin.get("/api/erp/administracion/eventos");

    expect(res.status).toBe(200);
    expect(res.body.eventos.length).toBeGreaterThan(0);
    // Todo lo de arriba dejó rastro: el alta del grifero, las bajas, el
    // celular.
    const acciones = res.body.eventos.map((e: { accion: string }) => e.accion);
    expect(acciones).toContain("crear_usuario");
    expect(acciones).toContain("cambiar_estado_usuario");
    expect(acciones).toContain("actualizar_usuario");
  });

  it("filtra por fecha y por acción", async () => {
    // El "hasta"/"desde" se interpreta como fecha en la sesión de Postgres,
    // que corre en America/Lima -- NO en UTC. Entre las 19:00 y la medianoche
    // en Lima, toISOString() ya da el día siguiente (UTC va 5h adelante), y
    // "hoy" en UTC buscaba eventos desde mañana a medianoche en Lima: vacío.
    const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Lima" });

    const porAccion = await admin.get("/api/erp/administracion/eventos?accion=crear_usuario");
    expect(
      porAccion.body.eventos.every((e: { accion: string }) => e.accion === "crear_usuario")
    ).toBe(true);

    // El "hasta" incluye el día entero, no corta a la medianoche del inicio.
    const deHoy = await admin.get(`/api/erp/administracion/eventos?desde=${hoy}&hasta=${hoy}`);
    expect(deHoy.body.eventos.length).toBeGreaterThan(0);

    const deAntes = await admin.get(
      "/api/erp/administracion/eventos?desde=2020-01-01&hasta=2020-01-02"
    );
    expect(deAntes.body.eventos).toHaveLength(0);
  });

  it("no muestra ni un evento de otra empresa", async () => {
    const otra = await crearTenantDePrueba(PASSWORD);
    try {
      // Algo que pasa en la otra empresa y no tiene que aparecer acá.
      const agenteOtra = request.agent(app);
      await agenteOtra.post("/api/auth/login").send({
        tenantSlug: otra.tenant.slug,
        email: otra.usuario.email,
        password: PASSWORD,
      });
      await agenteOtra.post("/api/erp/usuarios").send({
        nombre: "Alguien de la otra empresa",
        dni: "10101010",
        password: "ClaveAjena1234",
        rol: "operador",
      });

      const mios = await admin.get("/api/erp/administracion/eventos?limite=500");
      const nombres = JSON.stringify(mios.body.eventos);
      expect(nombres).not.toContain("Alguien de la otra empresa");
      expect(nombres).not.toContain(otra.tenant.id);
    } finally {
      await borrarTenantDePrueba(otra.tenant.id);
    }
  });

  it("solo lo ve un administrador", async () => {
    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Operador sin permisos de admin",
      dni: "12121212",
      password: "ClaveOperador12",
      rol: "operador",
    });
    expect(alta.status).toBe(201);

    const operador = request.agent(app);
    await operador.post("/api/auth/login").send({
      tenantSlug: empresa.tenant.slug,
      identificador: "12121212",
      password: "ClaveOperador12",
    });

    expect((await operador.get("/api/erp/administracion/eventos")).status).toBe(403);
  });

  it("pagina sin repetir ni saltear filas", async () => {
    const primera = await admin.get("/api/erp/administracion/eventos?limite=2");
    expect(primera.body.eventos).toHaveLength(2);
    expect(primera.body.siguiente).toBeTruthy();

    const segunda = await admin.get(
      `/api/erp/administracion/eventos?limite=2&antesDe=${primera.body.siguiente}`
    );
    const idsPrimera = primera.body.eventos.map((e: { id: string }) => e.id);
    const idsSegunda = segunda.body.eventos.map((e: { id: string }) => e.id);
    expect(idsSegunda.some((id: string) => idsPrimera.includes(id))).toBe(false);
  });

  it("el tope de la página no lo decide el cliente", async () => {
    const res = await admin.get("/api/erp/administracion/eventos?limite=999999");
    expect(res.status).toBe(200);
    expect(res.body.eventos.length).toBeLessThanOrEqual(500);
  });
});
