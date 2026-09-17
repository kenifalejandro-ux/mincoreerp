/** tests/platform-admins.test.ts
 *
 * Cuentas individuales de Platform Admin (migrations/0016_platform_admins.sql).
 *
 * Todo lo que depende de sesión (POST /admin-sesion, revocación, el guard
 * de auto-desactivación, listar/revocar sesiones puntuales) solo se puede
 * ejercer de punta a punta con Redis real. `redisDisponible()` chequea en
 * tiempo de ejecución si terminó habiendo uno (por CI —
 * .github/workflows/ci.yml corre un service container—, por
 * tests/global-setup.redis.ts si `redis-memory-server` está instalado, o
 * por un REDIS_HOST apuntado a mano) y activa el bloque que corresponda:
 * nunca asume un modo fijo, así que este archivo pasa igual con o sin
 * Redis, ejercitando en cada caso el camino real de ese entorno.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, idUnico, extraerCookie, redisDisponible } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase } from "../src/server/config/database";
import {
  verificarCredencialesPlatformAdminService,
  crearPlatformAdminService,
  cambiarEstadoPlatformAdminService,
  esSuperAdminVigente,
} from "../src/server/services/platformAdminAccount.service";
import { AppError } from "../src/server/shared/middlewares/error.middleware";
import {
  crearSesion,
  obtenerSesion,
  revocarSesion,
  revocarSesionesDeAdmin,
} from "../src/server/services/platformSession.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const emailsCreados: string[] = [];

// En minúsculas: platform_admins guarda el email normalizado (ver
// crearPlatformAdminService), así que un prefijo con mayúsculas (ej.
// "e2eLogin") rompería una comparación exacta contra lo que vuelve de la
// API si no se normaliza acá también.
function emailDePrueba(prefijo: string) {
  const email = `${idUnico(prefijo)}@platform-admin-test.local`.toLowerCase();
  emailsCreados.push(email);
  return email;
}

const conRedis = await redisDisponible();

afterAll(async () => {
  if (emailsCreados.length > 0) {
    await pool.query(`DELETE FROM platform_admins WHERE email = ANY($1)`, [emailsCreados]);
  }
  await closeDatabase();
});

describe("platform_admins: CRUD vía HTTP con el secreto compartido (Bearer, sin sesión)", () => {
  it("crea un admin y lo lista", async () => {
    const email = emailDePrueba("admin");
    const crear = await request(app)
      .post("/api/platform/admins")
      .set("Authorization", BEARER)
      .send({ email, password: "ClaveDePrueba123", nombre: "Admin de prueba", rol: "admin" });

    expect(crear.status).toBe(201);
    expect(crear.body.admin.email).toBe(email);
    expect(crear.body.admin.rol).toBe("admin");
    expect(crear.body.admin.activo).toBe(true);

    const listar = await request(app).get("/api/platform/admins").set("Authorization", BEARER);
    expect(listar.status).toBe(200);
    expect(listar.body.admins.some((a: { email: string }) => a.email === email)).toBe(true);
  });

  it("rechaza un correo duplicado con 409", async () => {
    const email = emailDePrueba("duplicado");
    const primero = await request(app)
      .post("/api/platform/admins")
      .set("Authorization", BEARER)
      .send({ email, password: "ClaveDePrueba123", nombre: "Uno", rol: "admin" });
    expect(primero.status).toBe(201);

    const segundo = await request(app)
      .post("/api/platform/admins")
      .set("Authorization", BEARER)
      .send({ email, password: "OtraClave123", nombre: "Dos", rol: "admin" });
    expect(segundo.status).toBe(409);
  });

  it("valida el body y audita el rechazo (password corta)", async () => {
    const email = emailDePrueba("invalido");
    const res = await request(app)
      .post("/api/platform/admins")
      .set("Authorization", BEARER)
      .send({ email, password: "corta", nombre: "X", rol: "admin" });
    expect(res.status).toBe(400);

    const auditoria = await pool.query(
      `SELECT resultado, actor_type, actor_label FROM platform_audit_log
       WHERE accion = 'crear_platform_admin' AND detalle::text LIKE '%' || $1 || '%'
       ORDER BY creado_en DESC LIMIT 5`,
      ["password"]
    );
    expect(
      auditoria.rows.some(
        (r) => r.resultado === "failure" && r.actor_type === "emergency_shared_secret"
      )
    ).toBe(true);
  });

  it("desactiva un admin (soft-delete) y el cambio de estado queda auditado con before/after", async () => {
    const email = emailDePrueba("desactivar");
    const crear = await request(app)
      .post("/api/platform/admins")
      .set("Authorization", BEARER)
      .send({ email, password: "ClaveDePrueba123", nombre: "A desactivar", rol: "admin" });
    const id = crear.body.admin.id;

    const desactivar = await request(app)
      .patch(`/api/platform/admins/${id}/estado`)
      .set("Authorization", BEARER)
      .send({ activo: false, motivo: "prueba automatizada" });
    expect(desactivar.status).toBe(200);
    expect(desactivar.body.admin.activo).toBe(false);

    const auditoria = await pool.query(
      `SELECT detalle FROM platform_audit_log
       WHERE accion = 'cambiar_estado_platform_admin' AND detalle->>'email' = $1
       ORDER BY creado_en DESC LIMIT 1`,
      [email]
    );
    expect(auditoria.rows).toHaveLength(1);
    expect(auditoria.rows[0].detalle.before).toEqual({ activo: true });
    expect(auditoria.rows[0].detalle.after).toEqual({ activo: false });
    expect(auditoria.rows[0].detalle.motivo).toBe("prueba automatizada");

    // No borra la fila — sigue existiendo, solo desactivada.
    const sigueExistiendo = await pool.query(`SELECT activo FROM platform_admins WHERE id = $1`, [
      id,
    ]);
    expect(sigueExistiendo.rows[0].activo).toBe(false);
  });

  it("crear/listar/desactivar admins sin credencial válida da 401, no 403 (no llega a la lógica de rol)", async () => {
    const res = await request(app).get("/api/platform/admins");
    expect(res.status).toBe(401);
  });
});

describe("verificarCredencialesPlatformAdminService (Redis-independiente)", () => {
  it("devuelve el admin con contraseña correcta, null con incorrecta, null si está desactivado", async () => {
    const email = emailDePrueba("credenciales");
    const admin = await crearPlatformAdminService({
      email,
      password: "ClaveCorrecta123",
      nombre: "Credenciales",
      rol: "admin",
    });

    const ok = await verificarCredencialesPlatformAdminService(email, "ClaveCorrecta123");
    expect(ok?.email).toBe(email);

    const mal = await verificarCredencialesPlatformAdminService(email, "otra-clave-cualquiera");
    expect(mal).toBeNull();

    const inexistente = await verificarCredencialesPlatformAdminService(
      "no-existe@platform-admin-test.local",
      "x"
    );
    expect(inexistente).toBeNull();

    await pool.query(`UPDATE platform_admins SET activo = false WHERE id = $1`, [admin.id]);
    const desactivado = await verificarCredencialesPlatformAdminService(email, "ClaveCorrecta123");
    expect(desactivado).toBeNull();
  });
});

describe("esSuperAdminVigente (gate de platformSuperAdminMiddleware, Redis-independiente)", () => {
  it("el secreto compartido siempre es super-admin equivalente", async () => {
    expect(
      await esSuperAdminVigente({
        actorType: "emergency_shared_secret",
        actorLabel: "secreto-compartido",
      })
    ).toBe(true);
  });

  it("un platform_admin con rol super_admin y activo es super-admin vigente", async () => {
    const email = emailDePrueba("super");
    const admin = await crearPlatformAdminService({
      email,
      password: "ClaveDePrueba123",
      nombre: "Super",
      rol: "super_admin",
    });
    expect(
      await esSuperAdminVigente({
        actorType: "platform_admin",
        actorId: admin.id,
        actorLabel: admin.email,
      })
    ).toBe(true);
  });

  it("un platform_admin con rol admin (no super) no es super-admin vigente", async () => {
    const email = emailDePrueba("noSuper");
    const admin = await crearPlatformAdminService({
      email,
      password: "ClaveDePrueba123",
      nombre: "No super",
      rol: "admin",
    });
    expect(
      await esSuperAdminVigente({
        actorType: "platform_admin",
        actorId: admin.id,
        actorLabel: admin.email,
      })
    ).toBe(false);
  });

  it("un super_admin desactivado deja de ser super-admin vigente de inmediato (se revalida contra la base)", async () => {
    const email = emailDePrueba("superDesactivado");
    const admin = await crearPlatformAdminService({
      email,
      password: "ClaveDePrueba123",
      nombre: "Super a desactivar",
      rol: "super_admin",
    });
    const actor = {
      actorType: "platform_admin" as const,
      actorId: admin.id,
      actorLabel: admin.email,
    };
    expect(await esSuperAdminVigente(actor)).toBe(true);

    await pool.query(`UPDATE platform_admins SET activo = false WHERE id = $1`, [admin.id]);
    expect(await esSuperAdminVigente(actor)).toBe(false);
  });
});

describe("protección del último super_admin activo (Redis-independiente)", () => {
  it("desactivar un super_admin cuando hay otro activo funciona normal", async () => {
    const unoEmail = emailDePrueba("guardUno");
    const dosEmail = emailDePrueba("guardDos");
    const uno = await crearPlatformAdminService({
      email: unoEmail,
      password: "ClaveDePrueba123",
      nombre: "Uno",
      rol: "super_admin",
    });
    await crearPlatformAdminService({
      email: dosEmail,
      password: "ClaveDePrueba123",
      nombre: "Dos",
      rol: "super_admin",
    });

    const { admin, before } = await cambiarEstadoPlatformAdminService(uno.id, false);
    expect(before).toBe(true);
    expect(admin.activo).toBe(false);
  });

  it("desactivar al último super_admin activo se rechaza con 400", async () => {
    const email = emailDePrueba("ultimoSuper");
    const admin = await crearPlatformAdminService({
      email,
      password: "ClaveDePrueba123",
      nombre: "Único super",
      rol: "super_admin",
    });

    // Desactiva a todos los demás super_admin de PRUEBA que hayan quedado
    // de otros tests en esta misma corrida, para que este test sea
    // determinista sin depender del orden en que corren los `it` de este
    // archivo. El filtro por dominio @platform-admin-test.local no es
    // cosmético: sin él, esta query corriendo contra la base local (no una
    // efímera de CI) desactivaba en silencio la cuenta real de Kenif
    // (sigma@mincoreerp.com.pe) cada vez que alguien corría este archivo
    // -- bug real, encontrado 2026-09-17 después de que el problema se
    // repitiera varias veces sin explicación (ver
    // incidente_desactivacion_sigma_sin_explicar en memoria).
    await pool.query(
      `UPDATE platform_admins SET activo = false
       WHERE rol = 'super_admin' AND id != $1 AND activo = true
         AND email LIKE '%@platform-admin-test.local'`,
      [admin.id]
    );

    // En CI (base efímera, sin admins reales) esto ya lo deja como el
    // único super_admin activo -> el guard tiene que rechazar con 400. En
    // local, con cuentas reales de plataforma que este test nunca toca
    // (ver el filtro de arriba), puede seguir sin ser el último -> el
    // guard no debería dispararse. Se verifica el conteo real en vez de
    // asumir cuál de los dos casos aplica, para que el test sea correcto
    // en los dos entornos.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total FROM platform_admins WHERE rol = 'super_admin' AND activo = true AND id != $1`,
      [admin.id]
    );
    const esElUltimoSuperAdminActivo = rows[0].total === 0;

    if (esElUltimoSuperAdminActivo) {
      await expect(cambiarEstadoPlatformAdminService(admin.id, false)).rejects.toMatchObject({
        statusCode: 400,
      } satisfies Partial<AppError>);
    } else {
      const { admin: actualizado } = await cambiarEstadoPlatformAdminService(admin.id, false);
      expect(actualizado.activo).toBe(false);
    }
  });

  it("desactivar el último admin con rol 'admin' (no super_admin) no dispara el guard", async () => {
    const email = emailDePrueba("ultimoAdminNoSuper");
    const admin = await crearPlatformAdminService({
      email,
      password: "ClaveDePrueba123",
      nombre: "Único admin",
      rol: "admin",
    });

    const { admin: actualizado } = await cambiarEstadoPlatformAdminService(admin.id, false);
    expect(actualizado.activo).toBe(false);
  });
});

describe.skipIf(conRedis)("sin Redis en este entorno: todo degrada con gracia", () => {
  it("POST /admin-sesion responde 503 (no hay a dónde guardar una sesión revocable sin Redis)", async () => {
    const res = await request(app)
      .post("/api/platform/admin-sesion")
      .send({ email: "x@x.com", password: "x" });
    expect(res.status).toBe(503);
  });

  it("crearSesion/obtenerSesion/revocarSesion/revocarSesionesDeAdmin nunca lanzan sin Redis", async () => {
    const sessionId = await crearSesion("127.0.0.1", {
      actorType: "emergency_shared_secret",
      actorLabel: "x",
    });
    expect(sessionId).toBeNull();
    expect(await obtenerSesion("cualquier-id")).toBeNull();
    expect(await revocarSesion("cualquier-id")).toBe(false);
    await expect(revocarSesionesDeAdmin("cualquier-id")).resolves.toBeUndefined();
  });

  it("POST /sesion (secreto compartido) sigue funcionando igual que siempre sin Redis (cookie legada)", async () => {
    const res = await request(app)
      .post("/api/platform/sesion")
      .send({ token: env.platformAdminToken });
    expect(res.status).toBe(200);
    const cookie = res.headers["set-cookie"];
    expect(cookie).toBeDefined();
  });
});

describe.skipIf(!conRedis)(
  "con Redis real: login individual, revocación y guards de punta a punta",
  () => {
    it("login individual: credenciales correctas dan cookie de sesión; /whoami refleja el admin autenticado", async () => {
      const email = emailDePrueba("e2eLogin");
      await crearPlatformAdminService({
        email,
        password: "ClaveDePrueba123",
        nombre: "E2E Login",
        rol: "admin",
      });

      const agent = request.agent(app);
      const login = await agent
        .post("/api/platform/admin-sesion")
        .send({ email, password: "ClaveDePrueba123" });
      expect(login.status).toBe(200);
      expect(extraerCookie(login.headers["set-cookie"], "platform_session")).toMatch(/^sid\./);

      const whoami = await agent.get("/api/platform/whoami");
      expect(whoami.status).toBe(200);
      expect(whoami.body.actorType).toBe("platform_admin");
      expect(whoami.body.actorLabel).toBe(email);
      expect(whoami.body.esSuperAdmin).toBe(false);

      // La cookie de sesión alcanza para las rutas de negocio, sin Bearer.
      const tenants = await agent.get("/api/platform/tenants");
      expect(tenants.status).toBe(200);
    });

    it("login individual con contraseña incorrecta da 401 y queda auditado", async () => {
      const email = emailDePrueba("e2eLoginMal");
      await crearPlatformAdminService({
        email,
        password: "ClaveCorrecta123",
        nombre: "E2E Login Mal",
        rol: "admin",
      });

      const res = await request(app)
        .post("/api/platform/admin-sesion")
        .send({ email, password: "otra-cosa" });
      expect(res.status).toBe(401);

      const auditoria = await pool.query(
        `SELECT resultado, actor_type FROM platform_audit_log
       WHERE accion = 'platform.session.started' AND detalle->>'via' = 'admin'
       ORDER BY creado_en DESC LIMIT 1`
      );
      expect(auditoria.rows[0].resultado).toBe("failure");
    });

    it("desactivar un admin revoca su sesión de inmediato — el próximo request con la cookie vieja da 401", async () => {
      const email = emailDePrueba("e2eRevocacion");
      const admin = await crearPlatformAdminService({
        email,
        password: "ClaveDePrueba123",
        nombre: "A revocar",
        rol: "admin",
      });

      const agent = request.agent(app);
      const login = await agent
        .post("/api/platform/admin-sesion")
        .send({ email, password: "ClaveDePrueba123" });
      expect(login.status).toBe(200);
      expect((await agent.get("/api/platform/tenants")).status).toBe(200);

      const desactivar = await request(app)
        .patch(`/api/platform/admins/${admin.id}/estado`)
        .set("Authorization", BEARER)
        .send({ activo: false });
      expect(desactivar.status).toBe(200);

      // Misma cookie de antes, ahora sin sesión válida detrás.
      const despues = await agent.get("/api/platform/tenants");
      expect(despues.status).toBe(401);
    });

    it("un admin no puede desactivarse a sí mismo, aunque no sea el último super_admin", async () => {
      const unoEmail = emailDePrueba("e2eAutoUno");
      const dosEmail = emailDePrueba("e2eAutoDos");
      const uno = await crearPlatformAdminService({
        email: unoEmail,
        password: "ClaveDePrueba123",
        nombre: "Auto uno",
        rol: "super_admin",
      });
      await crearPlatformAdminService({
        email: dosEmail,
        password: "ClaveDePrueba123",
        nombre: "Auto dos",
        rol: "super_admin",
      });

      const agent = request.agent(app);
      await agent
        .post("/api/platform/admin-sesion")
        .send({ email: unoEmail, password: "ClaveDePrueba123" });

      const res = await agent
        .patch(`/api/platform/admins/${uno.id}/estado`)
        .send({ activo: false });
      expect(res.status).toBe(400);

      const sigueActivo = await pool.query(`SELECT activo FROM platform_admins WHERE id = $1`, [
        uno.id,
      ]);
      expect(sigueActivo.rows[0].activo).toBe(true);
    });

    it("listar y revocar sesiones activas de un admin puntual", async () => {
      const email = emailDePrueba("e2eSesiones");
      const admin = await crearPlatformAdminService({
        email,
        password: "ClaveDePrueba123",
        nombre: "Con sesiones",
        rol: "admin",
      });

      const agent = request.agent(app);
      await agent.post("/api/platform/admin-sesion").send({ email, password: "ClaveDePrueba123" });

      const listar = await request(app)
        .get(`/api/platform/admins/${admin.id}/sesiones`)
        .set("Authorization", BEARER);
      expect(listar.status).toBe(200);
      expect(listar.body.sesiones).toHaveLength(1);
      const { sessionId } = listar.body.sesiones[0];

      const revocar = await request(app)
        .post(`/api/platform/sesiones/${sessionId}/revocar`)
        .set("Authorization", BEARER);
      expect(revocar.status).toBe(200);
      expect(revocar.body.revocada).toBe(true);

      expect((await agent.get("/api/platform/tenants")).status).toBe(401);

      const listarDespues = await request(app)
        .get(`/api/platform/admins/${admin.id}/sesiones`)
        .set("Authorization", BEARER);
      expect(listarDespues.body.sesiones).toHaveLength(0);
    });
  }
);

describe.skipIf(!conRedis)(
  "clave temporal + cambio obligatorio en el primer login (con Redis real)",
  () => {
    it("un admin recién creado tiene debeCambiarPassword=true en /whoami tras loguearse", async () => {
      const email = emailDePrueba("temporalNuevo");
      await crearPlatformAdminService({
        email,
        password: "ClaveTemporal123",
        nombre: "Con clave temporal",
        rol: "admin",
      });

      const agent = request.agent(app);
      await agent.post("/api/platform/admin-sesion").send({ email, password: "ClaveTemporal123" });

      const whoami = await agent.get("/api/platform/whoami");
      expect(whoami.status).toBe(200);
      expect(whoami.body.debeCambiarPassword).toBe(true);
    });

    it("POST /mi-password con la clave actual correcta cambia la contraseña y apaga el flag", async () => {
      const email = emailDePrueba("cambiaPassword");
      await crearPlatformAdminService({
        email,
        password: "ClaveTemporal123",
        nombre: "Cambia clave",
        rol: "admin",
      });

      const agent = request.agent(app);
      await agent.post("/api/platform/admin-sesion").send({ email, password: "ClaveTemporal123" });

      const cambiar = await agent
        .post("/api/platform/mi-password")
        .send({ passwordActual: "ClaveTemporal123", passwordNueva: "ClaveDefinitiva456" });
      expect(cambiar.status).toBe(200);

      const whoami = await agent.get("/api/platform/whoami");
      expect(whoami.body.debeCambiarPassword).toBe(false);

      // La clave vieja ya no sirve; la nueva sí.
      const loginConVieja = await request(app)
        .post("/api/platform/admin-sesion")
        .send({ email, password: "ClaveTemporal123" });
      expect(loginConVieja.status).toBe(401);

      const loginConNueva = await request(app)
        .post("/api/platform/admin-sesion")
        .send({ email, password: "ClaveDefinitiva456" });
      expect(loginConNueva.status).toBe(200);
    });

    it("POST /mi-password con la clave actual incorrecta da 401 y no cambia nada", async () => {
      const email = emailDePrueba("cambiaPasswordMal");
      await crearPlatformAdminService({
        email,
        password: "ClaveTemporal123",
        nombre: "Cambia clave mal",
        rol: "admin",
      });

      const agent = request.agent(app);
      await agent.post("/api/platform/admin-sesion").send({ email, password: "ClaveTemporal123" });

      const cambiar = await agent
        .post("/api/platform/mi-password")
        .send({ passwordActual: "otra-cosa", passwordNueva: "ClaveDefinitiva456" });
      expect(cambiar.status).toBe(401);

      const loginConVieja = await request(app)
        .post("/api/platform/admin-sesion")
        .send({ email, password: "ClaveTemporal123" });
      expect(loginConVieja.status).toBe(200);
    });

    it("el secreto compartido no puede usar POST /mi-password (400)", async () => {
      const agent = request.agent(app);
      await agent.post("/api/platform/sesion").send({ token: env.platformAdminToken });

      const cambiar = await agent
        .post("/api/platform/mi-password")
        .send({ passwordActual: "x", passwordNueva: "ClaveDefinitiva456" });
      expect(cambiar.status).toBe(400);
    });
  }
);
