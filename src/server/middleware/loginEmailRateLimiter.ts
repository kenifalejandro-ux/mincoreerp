/** src/server/middleware/loginEmailRateLimiter.ts
 *
 * Límite de POST /api/auth/login por tenantSlug+email — complementa al
 * rateLimiter genérico (form:${path}:${ip}), que es por IP: un atacante
 * repartiendo intentos contra UNA cuenta entre varias IPs (botnet,
 * proxies rotativos) nunca activa ese, cada IP nueva arranca su propio
 * contador. Este mira al sujeto real del ataque -- la cuenta -- sea cual
 * sea la IP de origen.
 *
 * tenantSlug+email, no solo email: el email es único POR TENANT, no
 * global (ver auth.schema.ts) -- dos tenants distintos pueden tener un
 * usuario con el mismo correo, y no deben compartir presupuesto de
 * intentos.
 *
 * Debe montarse DESPUÉS de validate(loginSchema): necesita
 * req.validatedBody ya normalizado (trim + lowercase) para que variar
 * mayúsculas no sirva para esquivar el contador.
 */
import type { Request } from "express";
import { env } from "../config/env";
import { crearLimitador } from "./redisRateLimiter";
import type { LoginInput } from "../schemas/auth.schema";

export default crearLimitador({
  prefijoClave: "login-email",
  windowMs: env.loginEmailRateLimitWindowMs,
  maxRequests: env.loginEmailRateLimitMaxRequests,
  mensaje: "Demasiados intentos con esta cuenta. Esperá un momento antes de volver a intentar.",
  extraerClave: (req: Request) => {
    // Desde 0084 el identificador puede ser un correo o un DNI. La protección
    // es la misma --frenar la fuerza bruta contra UNA cuenta-- y la clave se
    // arma igual con lo que haya venido.
    const body = req.validatedBody as LoginInput | undefined;
    if (!body?.tenantSlug || !body?.identificador) return undefined;
    return `${body.tenantSlug}:${body.identificador.toLowerCase()}`;
  },
});
