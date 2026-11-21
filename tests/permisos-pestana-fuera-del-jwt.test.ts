/** tests/permisos-pestana-fuera-del-jwt.test.ts
 *
 * Los permisos de pestaña puestos a mano ya NO viajan dentro del JWT (la cookie `erp_token`): cada uno sumaba
 * ~40 bytes y el navegador descarta las cookies de más de ~4096. Ahora los carga authMiddleware en cada
 * request, desde un cache de 60 s o la base. Lo que se fija:
 *
 * 1. La cookie no lleva `permisosPestanas` ni crece con los permisos, aunque TODA pestaña contradiga su
 *    default; el cuerpo del login, del refresh y de /api/auth/me los sigue devolviendo al cliente.
 * 2. Los permisos rigen de inmediato tras guardarlos, sin volver a entrar (antes tardaba hasta que el JWT se
 *    renovaba).
 * 3. Un JWT viejo que todavía trae permisos adentro no los hace valer: mandan los de ahora.
 * 4. El cache: guarda, devuelve e invalida.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";

import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { getRedis } from "../src/server/config/redis";
import { env } from "../src/server/config/env";
import {
  getCachedPermisosPestana,
  invalidateCachedPermisosPestana,
  setCachedPermisosPestana,
} from "../src/server/shared/utils/permisos-pestana-cache";
import { requerirJwtSecret } from "../src/server/shared/utils/jwt-secret";

const PASSWORD = "ClaveDePrueba123";

type Agente = ReturnType<typeof request.agent>;

describe("Permisos de pestaña fuera del JWT", () => {
  let empresa: Awaited<ReturnType<typeof crearTenantDePrueba>>;
  let admin: Agente;
  let operadorId: string;
  let operadorEmail: string;

  const entrar = async (email: string) => {
    const ag = request.agent(app);
    const res = await ag
      .post("/api/auth/login")
      .send({ tenantSlug: empresa.tenant.slug, email, password: PASSWORD });
    expect(res.status).toBe(200);
    return { ag, res };
  };
  const cookieDeSesion = (res: request.Response) =>
    ((res.headers["set-cookie"] as unknown as string[]) ?? []).find((c) =>
      c.startsWith(`${env.authCookieName}=`)
    )!;
  const tokenDeCookie = (cookie: string) => cookie.split(";")[0].split("=").slice(1).join("=");
  /** Deja a la persona con los permisos de pestaña que se le pasen (el resto, como estaba). */
  const darPermisos = async (
    decidir: (p: {
      modulo: string;
      pestana: string;
      permitido: boolean;
      predeterminado: boolean;
    }) => boolean
  ) => {
    const permisos = await admin.get(`/api/erp/usuarios/${operadorId}/permisos`);
    const r = await admin.put(`/api/erp/usuarios/${operadorId}/permisos`).send({
      modulos: permisos.body.modulos.map(
        (m: { modulo: string; asignado: boolean; nivel: string }) => ({
          modulo: m.modulo,
          asignado: m.asignado,
          nivel: m.nivel,
        })
      ),
      pestanas: permisos.body.pestanas.map(
        (p: { modulo: string; pestana: string; permitido: boolean; predeterminado: boolean }) => ({
          modulo: p.modulo,
          pestana: p.pestana,
          permitido: decidir(p),
        })
      ),
      motivo: "Prueba de permisos",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  beforeAll(async () => {
    empresa = await crearTenantDePrueba(PASSWORD);
    admin = (await entrar(empresa.usuario.email)).ag;
    operadorEmail = `operador-${empresa.tenant.slug}@test.local`;
    const alta = await admin.post("/api/erp/usuarios").send({
      nombre: "Operador de prueba",
      email: operadorEmail,
      password: PASSWORD,
      rol: "operador",
    });
    expect(alta.status, JSON.stringify(alta.body)).toBe(201);
    operadorId = alta.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(empresa.tenant.id);
    await closeDatabase();
  });

  it("la cookie no lleva permisos de pestaña ni crece con ellos, y el cuerpo los sigue devolviendo", async () => {
    // El peor caso: TODA pestaña contradice su valor por defecto.
    await darPermisos((p) => !p.permitido);
    const { ag, res } = await entrar(operadorEmail);

    const cookie = cookieDeSesion(res);
    const payload = jwt.decode(tokenDeCookie(cookie)) as Record<string, unknown>;
    expect(payload.rol).toBe("operador");
    expect(payload).not.toHaveProperty("permisosPestanas");
    // Antes, con todas las pestañas contradichas, la cookie pasaba de 3300 bytes; ahora no depende de ellas.
    expect(cookie.length).toBeLessThan(1600);

    // El cliente los recibe en el cuerpo: login, /me y refresh.
    const enLogin = res.body.usuario.permisosPestanas as Record<string, boolean>;
    expect(Object.keys(enLogin).length).toBeGreaterThan(10);
    const me = await ag.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.usuario.permisosPestanas).toEqual(enLogin);
    const refresco = await ag.post("/api/auth/refresh");
    expect(refresco.status).toBe(200);
    expect(refresco.body.usuario.permisosPestanas).toEqual(enLogin);
    expect(cookieDeSesion(refresco)).toBeDefined();
    expect(
      jwt.decode(tokenDeCookie(cookieDeSesion(refresco))) as Record<string, unknown>
    ).not.toHaveProperty("permisosPestanas");

    // Se deja al operador con los permisos predeterminados de su perfil para los demás tests.
    await darPermisos((p) => p.predeterminado);
  });

  it("un permiso rige de inmediato, sin volver a entrar", async () => {
    // Sin el permiso de registrar compras: el formulario de compras da 403.
    await darPermisos((p) =>
      p.modulo === "combustible" && p.pestana === "cisternas:registrar_compra" ? false : p.permitido
    );
    const { ag } = await entrar(operadorEmail);
    expect((await ag.get("/api/erp/combustible/compras-cisterna/formulario")).status).toBe(403);

    // El admin se lo da: la sesión ya abierta lo usa en el siguiente request (antes hacía falta renovar el JWT).
    await darPermisos((p) =>
      p.modulo === "combustible" && p.pestana === "cisternas:registrar_compra" ? true : p.permitido
    );
    expect((await ag.get("/api/erp/combustible/compras-cisterna/formulario")).status).toBe(200);
  });

  it("un JWT viejo que trae permisos adentro no los hace valer", async () => {
    // El operador NO tiene registrar compras...
    await darPermisos((p) =>
      p.modulo === "combustible" && p.pestana === "cisternas:registrar_compra" ? false : p.permitido
    );
    const { res } = await entrar(operadorEmail);
    const payload = jwt.decode(tokenDeCookie(cookieDeSesion(res))) as Record<string, unknown> & {
      id: string;
      sessionId: string;
    };
    // ...y se arma un token "viejo" firmado como antes, con el permiso adentro.
    const { exp: _exp, iat: _iat, ...sinFechas } = payload as Record<string, unknown>;
    const viejo = jwt.sign(
      {
        ...sinFechas,
        permisosPestanas: { "combustible:cisternas:registrar_compra": true },
      },
      requerirJwtSecret(),
      { expiresIn: "5m" }
    );
    const redis = getRedis();
    if (redis) await redis.set(`session:${payload.id}:${payload.sessionId}`, viejo, "EX", 300);
    const r = await request(app)
      .get("/api/erp/combustible/compras-cisterna/formulario")
      .set("Authorization", `Bearer ${viejo}`);
    expect(r.status).toBe(403);
    // Y los de la base sí valen: con el permiso dado de verdad, el mismo token pasa.
    await darPermisos((p) =>
      p.modulo === "combustible" && p.pestana === "cisternas:registrar_compra" ? true : p.permitido
    );
    const pasa = await request(app)
      .get("/api/erp/combustible/compras-cisterna/formulario")
      .set("Authorization", `Bearer ${viejo}`);
    expect(pasa.status).toBe(200);
  });

  it("el cache guarda, devuelve e invalida, y lo leído de la base queda guardado", async () => {
    const id = `cache-${empresa.tenant.slug}`;
    expect(await getCachedPermisosPestana(id)).toBeUndefined();
    await setCachedPermisosPestana(id, { "combustible:cisternas": false });
    expect(await getCachedPermisosPestana(id)).toEqual({ "combustible:cisternas": false });
    await invalidateCachedPermisosPestana(id);
    expect(await getCachedPermisosPestana(id)).toBeUndefined();

    // Tras un request de la persona real, sus permisos quedan en el cache.
    await invalidateCachedPermisosPestana(operadorId);
    const { ag } = await entrar(operadorEmail);
    await invalidateCachedPermisosPestana(operadorId);
    await ag.get("/api/auth/me");
    const enCache = await getCachedPermisosPestana(operadorId);
    expect(enCache).toBeDefined();
    const enBase = await withTenant(empresa.tenant.id, (c) =>
      c.query(`SELECT count(*)::int AS n FROM usuario_permisos_pestana WHERE usuario_id = $1`, [
        operadorId,
      ])
    );
    expect(Object.keys(enCache!).length).toBe(enBase.rows[0].n);
  });
});
