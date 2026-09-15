/** tests/ordenes-doble-firma.test.ts
 *
 * Órdenes administrativas y doble firma (entrega 5, migración 0091). Diseño:
 * docs/architecture/cuentas-perfiles-y-administracion.md §11.
 *
 * Lo que se fija acá:
 *
 * 1. Que con la doble firma APAGADA nada cambie para el que administra: la
 *    orden se crea y se aplica, y la pantalla responde como siempre.
 * 2. Que con la doble firma ENCENDIDA no se aplique nada hasta que firme otro
 *    administrador, y que nadie firme lo suyo.
 * 3. Que cortar el acceso siga siendo inmediato: una cuenta robada no espera
 *    al segundo firmante.
 * 4. Que la orden quede como documento -- correlativo, las dos firmas, el
 *    antes y el después -- aunque se rechace o falle.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";
import { env } from "../src/server/config/env";

const PASSWORD = "ClaveDePrueba123";

// El pool se cierra UNA vez, al final del archivo: hay dos describe de nivel
// superior, y cerrarlo en el afterAll del primero dejaba al segundo sin base.
afterAll(async () => {
  await closeDatabase();
});

describe("órdenes administrativas y doble firma", () => {
  let empresa: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  /** Dos administradores: la doble firma no existe sin dos. */
  let admin1: ReturnType<typeof request.agent>;
  let admin2: ReturnType<typeof request.agent>;
  let admin2Id: string;
  let operadorId: string;
  const emailAdmin2 = () => `segundo-admin-${empresa.tenant.slug}@test.local`;

  const sesionDe = async (identificador: string, password: string) => {
    const agente = request.agent(app);
    const res = await agente
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, identificador, password });
    expect(res.status).toBe(200);
    return agente;
  };

  const encenderDobleFirma = async (encender: boolean) => {
    await withTenant(empresa.tenant.id, () =>
      pool.query(`UPDATE tenants SET doble_firma = $2 WHERE id = $1`, [empresa.tenant.id, encender])
    );
  };

  const ordenes = async (agente: ReturnType<typeof request.agent>) => {
    const res = await agente.get("/api/erp/administracion/ordenes");
    expect(res.status).toBe(200);
    return res.body.ordenes as {
      id: string;
      correlativo: string;
      tipo: string;
      estado: string;
      firmasRequeridas: number;
      solicitanteNombre: string;
      aprobadorNombre: string | null;
      antes: Record<string, unknown> | null;
      payload: Record<string, unknown>;
    }[];
  };

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    admin1 = await sesionDe(empresa.usuario.email, PASSWORD);

    // El segundo administrador, con clave propia para poder entrar.
    const alta = await admin1.post("/api/erp/usuarios").send({
      nombre: "Segunda administradora",
      email: emailAdmin2(),
      password: PASSWORD,
      rol: "admin",
    });
    expect(alta.status).toBe(201);
    admin2Id = alta.body.id;
    admin2 = await sesionDe(emailAdmin2(), PASSWORD);

    const operador = await admin1.post("/api/erp/usuarios").send({
      nombre: "Operador cualquiera",
      dni: "77665544",
      password: "ClaveOperador123",
      rol: "operador",
    });
    expect(operador.status).toBe(201);
    operadorId = operador.body.id;
  });

  afterAll(async () => {
    await encenderDobleFirma(false);
    await borrarTenantDePrueba(empresa.tenant.id);
  });

  // ── 1. Con la doble firma apagada ─────────────────────────────────────

  it("toda acción deja una orden con correlativo, aunque se aplique de una", async () => {
    const lista = await ordenes(admin1);

    expect(lista.length).toBeGreaterThanOrEqual(2);
    expect(lista.every((o) => o.estado === "aplicada")).toBe(true);
    // ORD-2026-000001 y siguientes, por empresa y por año.
    expect(lista[0].correlativo).toMatch(/^ORD-\d{4}-\d{6}$/);
    expect(lista.some((o) => o.tipo === "alta_usuario")).toBe(true);
  });

  it("el correlativo no se repite ni se saltea", async () => {
    const numeros = (await ordenes(admin1))
      .map((o) => Number(o.correlativo.split("-")[2]))
      .sort((a, b) => a - b);

    expect(new Set(numeros).size).toBe(numeros.length);
    expect(numeros[0]).toBe(1);
    expect(numeros[numeros.length - 1]).toBe(numeros.length);
  });

  // ── 2. Con la doble firma encendida ───────────────────────────────────

  describe("con doble firma", () => {
    beforeAll(async () => {
      await encenderDobleFirma(true);
    });

    afterAll(async () => {
      await encenderDobleFirma(false);
    });

    it("un alta queda pendiente y no crea a nadie", async () => {
      const antes = await admin1.get("/api/erp/usuarios");

      const res = await admin1.post("/api/erp/usuarios").send({
        nombre: "Persona que todavía no existe",
        dni: "10203040",
        password: "ClaveDePrueba456",
        rol: "operador",
      });

      expect(res.status).toBe(202);
      expect(res.body.orden.estado).toBe("pendiente");
      expect(res.body.orden.firmasRequeridas).toBe(2);
      expect(res.body.message).toContain(res.body.orden.correlativo);

      const despues = await admin1.get("/api/erp/usuarios");
      expect(despues.body.data).toHaveLength(antes.body.data.length);
    });

    it("quien la pidió no la puede firmar", async () => {
      const pendiente = (await ordenes(admin1)).find((o) => o.estado === "pendiente")!;

      const res = await admin1
        .post(`/api/erp/administracion/ordenes/${pendiente.id}/aprobar`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/pediste vos/i);
    });

    it("el otro administrador la firma y recién ahí se aplica", async () => {
      const pendiente = (await ordenes(admin1)).find((o) => o.estado === "pendiente")!;

      const res = await admin2
        .post(`/api/erp/administracion/ordenes/${pendiente.id}/aprobar`)
        .send({ motivo: "Revisado, entra al turno noche" });

      expect(res.status).toBe(200);
      expect(res.body.orden.estado).toBe("aplicada");

      const lista = await admin1.get("/api/erp/usuarios");
      expect(lista.body.data.some((u: { dni: string }) => u.dni === "10203040")).toBe(true);
    });

    it("la orden aplicada guarda quién la pidió y quién la firmó", async () => {
      const aplicada = (await ordenes(admin1)).find(
        (o) => o.tipo === "alta_usuario" && o.estado === "aplicada" && o.firmasRequeridas === 2
      )!;

      expect(aplicada.solicitanteNombre).toBe("Admin de prueba");
      expect(aplicada.aprobadorNombre).toBe("Segunda administradora");
    });

    it("una segunda orden sobre la misma persona da 409", async () => {
      const primera = await admin1
        .patch(`/api/erp/usuarios/${operadorId}/clave`)
        .send({ password: "ClaveNueva123456" });
      expect(primera.status).toBe(202);

      const segunda = await admin1
        .patch(`/api/erp/usuarios/${operadorId}/clave`)
        .send({ password: "OtraClaveMas12345" });

      expect(segunda.status).toBe(409);
      expect(segunda.body.message).toMatch(/pendiente/i);

      // Se limpia para los tests que siguen.
      const pendiente = (await ordenes(admin1)).find((o) => o.estado === "pendiente")!;
      await admin2
        .post(`/api/erp/administracion/ordenes/${pendiente.id}/rechazar`)
        .send({ motivo: "limpieza de la prueba" });
    });

    it("rechazar deja la orden como documento, con el motivo", async () => {
      const rechazada = (await ordenes(admin1)).find((o) => o.estado === "rechazada")!;

      expect(rechazada).toBeDefined();
      expect(rechazada.aprobadorNombre).toBe("Segunda administradora");
    });

    it("cortar el acceso de un no administrador es inmediato", async () => {
      // Una sola firma: una cuenta robada no espera al segundo firmante.
      const res = await admin1
        .patch(`/api/erp/usuarios/${operadorId}/estado`)
        .send({ estado: "inactivo", motivo: "se fue de la empresa" });

      expect(res.status).toBe(200);
      expect(res.body.orden.estado).toBe("aplicada");
      expect(res.body.orden.firmasRequeridas).toBe(1);
      expect(res.body.estado).toBe("inactivo");
    });

    it("reactivar a esa misma persona sí necesita dos firmas", async () => {
      const res = await admin1
        .patch(`/api/erp/usuarios/${operadorId}/estado`)
        .send({ estado: "activo" });

      expect(res.status).toBe(202);
      expect(res.body.orden.firmasRequeridas).toBe(2);

      const aprobada = await admin2
        .post(`/api/erp/administracion/ordenes/${res.body.orden.id}/aprobar`)
        .send({});
      expect(aprobada.status).toBe(200);
    });

    it("cualquier cambio sobre un ADMINISTRADOR necesita dos firmas", async () => {
      // Hasta cortarle el acceso: si una sola firma alcanzara, un admin saca
      // al otro y se queda solo.
      const res = await admin1
        .patch(`/api/erp/usuarios/${admin2Id}/estado`)
        .send({ estado: "inactivo", motivo: "prueba sobre un admin" });

      // Con dos administradores, bajar a uno deja uno solo: ni siquiera se
      // puede pedir.
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/un solo administrador/i);
    });

    it("la orden guarda el antes, para que el que firma vea el cambio", async () => {
      const res = await admin1.put(`/api/erp/usuarios/${admin2Id}/permisos`).send({
        modulos: [{ modulo: "combustible", asignado: true, nivel: "consultas" }],
        motivo: "prueba del antes y después",
      });
      expect(res.status).toBe(202);

      const orden = (await ordenes(admin1)).find((o) => o.id === res.body.orden.id)!;
      expect(orden.antes).toBeTruthy();
      expect(orden.antes!.rol).toBe("admin");
      expect(Array.isArray(orden.antes!.modulos)).toBe(true);
      expect(orden.payload.modulos).toBeTruthy();

      await admin2.post(`/api/erp/administracion/ordenes/${orden.id}/rechazar`).send({
        motivo: "era solo una prueba",
      });
    });

    it("una orden vencida no se puede firmar", async () => {
      const res = await admin1
        .patch(`/api/erp/usuarios/${operadorId}/clave`)
        .send({ password: "ClaveQueVaAVencer1" });
      expect(res.status).toBe(202);

      // Se la envejece a mano: esperar 72 horas no es una opción.
      await withTenant(empresa.tenant.id, (client) =>
        client.query(
          `UPDATE ordenes_admin SET expira_en = now() - interval '1 hour' WHERE id = $1`,
          [res.body.orden.id]
        )
      );

      const aprobar = await admin2
        .post(`/api/erp/administracion/ordenes/${res.body.orden.id}/aprobar`)
        .send({});
      expect(aprobar.status).toBe(409);
      expect(aprobar.body.message).toMatch(/venció/i);

      const lista = await ordenes(admin1);
      expect(lista.find((o) => o.id === res.body.orden.id)!.estado).toBe("vencida");
    });

    it("no se puede firmar dos veces la misma orden", async () => {
      const res = await admin1
        .patch(`/api/erp/usuarios/${operadorId}/clave`)
        .send({ password: "ClaveParaFirmarDos1" });
      expect(res.status).toBe(202);

      const primera = await admin2
        .post(`/api/erp/administracion/ordenes/${res.body.orden.id}/aprobar`)
        .send({});
      expect(primera.status).toBe(200);

      const segunda = await admin2
        .post(`/api/erp/administracion/ordenes/${res.body.orden.id}/aprobar`)
        .send({});
      expect(segunda.status).toBe(409);
    });
  });

  // ── 3. Encender y apagar la doble firma ───────────────────────────────

  it("apagarla necesita dos firmas; encenderla, una", async () => {
    const encender = await admin1
      .put("/api/erp/administracion/doble-firma")
      .send({ dobleFirma: true, motivo: "prueba de encendido" });
    expect(encender.status).toBe(200);
    expect(encender.body.dobleFirma).toBe(true);

    const apagar = await admin1
      .put("/api/erp/administracion/doble-firma")
      .send({ dobleFirma: false, motivo: "prueba de apagado" });
    expect(apagar.status).toBe(202);
    expect(apagar.body.orden.firmasRequeridas).toBe(2);

    const firmada = await admin2
      .post(`/api/erp/administracion/ordenes/${apagar.body.orden.id}/aprobar`)
      .send({});
    expect(firmada.status).toBe(200);

    const estado = await admin1.get("/api/erp/administracion/doble-firma");
    expect(estado.body.dobleFirma).toBe(false);
  });

  it("no se puede encender con un solo administrador", async () => {
    const sola = await crearTenantDePrueba(PASSWORD);
    try {
      const agente = request.agent(app);
      await agente.post("/api/auth/login").send({
        tenantSlug: sola.tenant.slug,
        email: sola.usuario.email,
        password: PASSWORD,
      });

      const res = await agente
        .put("/api/erp/administracion/doble-firma")
        .send({ dobleFirma: true, motivo: "no debería poder" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/dos administradores/i);
    } finally {
      await borrarTenantDePrueba(sola.tenant.id);
    }
  });

  // ── 4. Quién puede ver y firmar ───────────────────────────────────────

  it("las órdenes son solo para administradores", async () => {
    // Uno propio: al operador de arriba le resetearon la clave varias veces
    // en los tests de órdenes, y con la clave vieja no entraría.
    const clave = "ClaveDeLectura123";
    const alta = await admin1.post("/api/erp/usuarios").send({
      nombre: "Alguien de solo lectura",
      dni: "66778899",
      password: clave,
      rol: "lectura",
    });
    expect(alta.status).toBe(201);

    const operador = request.agent(app);
    const entro = await operador.post("/api/auth/login").send({
      tenantSlug: empresa.tenant.slug,
      identificador: "66778899",
      password: clave,
    });
    expect(entro.status).toBe(200);

    expect((await operador.get("/api/erp/administracion/ordenes")).status).toBe(403);
  });

  it("ninguna empresa ve las órdenes de otra", async () => {
    const otra = await crearTenantDePrueba(PASSWORD);
    try {
      const agente = request.agent(app);
      await agente.post("/api/auth/login").send({
        tenantSlug: otra.tenant.slug,
        email: otra.usuario.email,
        password: PASSWORD,
      });

      const suyas = await agente.get("/api/erp/administracion/ordenes");
      expect(suyas.status).toBe(200);
      // Su propio tenant recién creado no tiene ninguna.
      expect(suyas.body.ordenes).toHaveLength(0);
    } finally {
      await borrarTenantDePrueba(otra.tenant.id);
    }
  });
});

// ── 5. Lo que puede hacer MINCORE desde la plataforma (§12) ──────────────
//
// Dos salidas de emergencia y una potestad que ninguna empresa tiene. Las
// tres dejan rastro en la bitácora DE LA EMPRESA: una intervención del
// proveedor sobre datos del cliente que el cliente no puede ver no es una
// intervención auditada, es algo que pasó y nadie supo.

describe("plataforma sobre una empresa", () => {
  const BEARER = `Bearer ${env.platformAdminToken}`;
  let empresa: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  let admin: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    admin = request.agent(app);
    const entro = await admin.post("/api/auth/login").send({
      tenantSlug: empresa.tenant.slug,
      email: empresa.usuario.email,
      password: PASSWORD,
    });
    expect(entro.status).toBe(200);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(empresa.tenant.id);
  });

  it("el alta por carta deja el número visible para la empresa", async () => {
    const res = await request(app)
      .post(`/api/platform/tenants/${empresa.tenant.id}/usuarios`)
      .set("Authorization", BEARER)
      .send({
        nombre: "Alta pedida por carta",
        dni: "31313131",
        password: "ClavePorCarta123",
        rol: "operador",
        numeroCarta: "CARTA-2026-014",
      });
    expect(res.status).toBe(201);

    // La empresa lo ve en SU log de eventos: es la respuesta a "¿y este
    // usuario de dónde salió?".
    const eventos = await admin.get("/api/erp/administracion/eventos?accion=crear_usuario");
    const conCarta = eventos.body.eventos.find(
      (e: { detalle: { numeroCarta?: string } }) => e.detalle?.numeroCarta === "CARTA-2026-014"
    );
    expect(conCarta).toBeDefined();
    // Y se ve que lo hizo MINCORE, no alguien de la empresa.
    expect(conCarta.actorTipo).not.toBe("usuario");
  });

  it("break-glass: MINCORE nombra un administrador y queda registrado", async () => {
    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Futuro administrador",
      dni: "32323232",
      password: "ClaveFutura1234",
      rol: "operador",
    });
    expect(alta.status).toBe(201);

    const sinMotivo = await request(app)
      .patch(`/api/platform/tenants/${empresa.tenant.id}/usuarios/${alta.body.id}/rol`)
      .set("Authorization", BEARER)
      .send({ rol: "admin" });
    expect(sinMotivo.status).toBe(400);

    const res = await request(app)
      .patch(`/api/platform/tenants/${empresa.tenant.id}/usuarios/${alta.body.id}/rol`)
      .set("Authorization", BEARER)
      .send({ rol: "admin", motivo: "el otro admin renunció", numeroCarta: "CARTA-2026-015" });

    expect(res.status).toBe(200);
    expect(res.body.usuario.rol).toBe("admin");

    // Dos filas: el intento sin motivo quedó registrado como fallido, y el
    // que se aplicó. Que un break-glass rechazado deje rastro es correcto --
    // alguien intentó nombrar un administrador desde afuera.
    const eventos = await admin.get(
      "/api/erp/administracion/eventos?accion=plataforma.reemplazar_admin"
    );
    const aplicado = eventos.body.eventos.find(
      (e: { resultado: string }) => e.resultado === "success"
    );
    expect(aplicado.detalle.motivo).toBe("el otro admin renunció");
    expect(aplicado.detalle.antes.rol).toBe("operador");
    expect(aplicado.detalle.numeroCarta).toBe("CARTA-2026-015");
  });

  it("desactivar una CUENTA la deja afuera de todas sus empresas", async () => {
    const cuenta = (
      await pool.query(`SELECT id FROM cuentas WHERE email = $1`, [
        empresa.usuario.email.toLowerCase(),
      ])
    ).rows[0];

    const res = await request(app)
      .patch(`/api/platform/cuentas/${cuenta.id}/estado`)
      .set("Authorization", BEARER)
      .send({ activo: false, motivo: "pedido de la persona" });

    expect(res.status).toBe(200);
    expect(res.body.perfilesAfectados).toBeGreaterThanOrEqual(1);

    // Ni siquiera con la clave correcta.
    const intento = await request(app).post("/api/auth/login").send({
      tenantSlug: empresa.tenant.slug,
      email: empresa.usuario.email,
      password: PASSWORD,
    });
    expect(intento.status).toBe(401);

    // Y vuelve a entrar cuando se reactiva.
    const reactivar = await request(app)
      .patch(`/api/platform/cuentas/${cuenta.id}/estado`)
      .set("Authorization", BEARER)
      .send({ activo: true, motivo: "se resolvió" });
    expect(reactivar.status).toBe(200);

    const devuelta = await request(app).post("/api/auth/login").send({
      tenantSlug: empresa.tenant.slug,
      email: empresa.usuario.email,
      password: PASSWORD,
    });
    expect(devuelta.status).toBe(200);
  });
});
