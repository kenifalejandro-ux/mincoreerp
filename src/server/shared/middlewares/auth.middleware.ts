/** src/server/shared/middlewares/auth.middleware.ts */

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { withTenant } from "../../config/database";
import { getRedis } from "../../config/redis";
import { logger } from "../../config/logger";
import type { UsuarioPayload } from "../../services/auth.service";
import { permisosPestanasDe } from "../../services/permisosPestanas.service";
import { requerirJwtSecret } from "../utils/jwt-secret";
import { getCachedTokenVersion, setCachedTokenVersion } from "../utils/token-version-cache";
import { asyncHandler } from "../utils/asyncHandler";

const JWT_SECRET = requerirJwtSecret();

export const authMiddleware = asyncHandler(async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Sesión de navegador: cookie httpOnly (no accesible por JS, a salvo de robo por XSS).
    // Header Bearer: vía alterna para clientes no-navegador (scripts, integraciones API).
    const authHeader = req.headers.authorization;
    const tokenCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      env.authCookieName
    ];
    const tokenHeader = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : undefined;
    const token = tokenCookie || tokenHeader;

    if (!token) {
      return res.status(401).json({ ok: false, message: "Token no proporcionado" });
    }

    const payload = jwt.verify(token, JWT_SECRET) as UsuarioPayload;

    // token_version: única verificación de revocación que no depende de
    // Redis. Se cachea 60s (ver token-version-cache.ts) para no consultar
    // Postgres en cada request; ese es el retraso máximo con el que se
    // propaga un logout o una revocación de admin.
    let versionActual = await getCachedTokenVersion(payload.id);
    if (versionActual === undefined) {
      // usuarios tiene RLS (ver migrations/0010_usuarios_rls.sql) — el
      // tenantId ya viene verificado dentro del propio JWT, así que abrir
      // la transacción con withTenant() acá es seguro: no es un dato que
      // el cliente pueda manipular sin invalidar la firma del token.
      const resultado = await withTenant(payload.tenantId, (client) =>
        client.query(
          `SELECT u.token_version FROM usuarios u
           JOIN tenants t ON t.id = u.tenant_id
           WHERE u.id = $1 AND u.tenant_id = $2 AND u.activo = true AND t.activo = true`,
          [payload.id, payload.tenantId]
        )
      );
      if (resultado.rows.length === 0) {
        return res.status(401).json({ ok: false, message: "Sesión inválida" });
      }
      const versionDesdeBd: number = resultado.rows[0].token_version;
      versionActual = versionDesdeBd;
      await setCachedTokenVersion(payload.id, versionDesdeBd);
    }

    if (payload.tokenVersion !== versionActual) {
      return res
        .status(401)
        .json({ ok: false, message: "Sesión inválida, inicia sesión nuevamente" });
    }

    // Una key de Redis por SESIÓN (no por usuario) -- ver
    // emitirSesionCompleta() en auth.service.ts. Esto es lo que permite que
    // un usuario tenga varias sesiones activas a la vez (celular + PC) sin
    // que loguearse en una cierre la otra: cada una tiene su propio
    // sessionId y su propia key, así que nunca se pisan entre sí. Un JWT
    // sin sessionId (emitido antes de este cambio) no matchea ninguna key
    // real y cae acá abajo como sesión inválida -- se resuelve solo en el
    // próximo refresh, no hace falta un caso especial.
    const redis = getRedis();
    if (redis) {
      try {
        const sesionToken = await redis.get(`session:${payload.id}:${payload.sessionId}`);
        if (!sesionToken || sesionToken !== token) {
          return res.status(401).json({ ok: false, message: "Sesión expirada o inválida" });
        }
      } catch (err) {
        logger.warn({ err }, "Error al verificar sesión en Redis, continuando sin Redis");
      }
    }

    // Los permisos de pestaña ya NO viajan en el JWT (ver permisos-pestana-cache.ts): se cargan acá, de un
    // cache de 60 s o de la base. Si un JWT viejo todavía los trae, se ignoran y mandan los de ahora. Si no
    // se pueden leer, el request falla (500): usar solo los predeterminados del perfil abriría una pestaña
    // que el administrador le quitó a mano.
    req.usuario = {
      ...payload,
      permisosPestanas: await permisosPestanasDe(payload.id, payload.tenantId),
    };
    next();
  } catch (err) {
    if (err instanceof Error && err.name === "TokenExpiredError") {
      return res.status(401).json({ ok: false, message: "Token expirado" });
    }
    if (err instanceof Error && err.name === "JsonWebTokenError") {
      return res.status(401).json({ ok: false, message: "Token inválido" });
    }
    logger.error({ err }, "Error en authMiddleware");
    return res.status(500).json({ ok: false, message: "Error de autenticación" });
  }
});
