/** src/server/shared/utils/permisos-pestana-cache.ts
 *
 * Cache corta (60 s) de los permisos de pestaña puestos a mano de cada usuario (`usuario_permisos_pestana`),
 * para que authMiddleware los tenga en cada request sin consultar Postgres cada vez. Mismo patrón que
 * token-version-cache.ts: Redis si está disponible, memoria como respaldo.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────
 *
 * Antes este mapa viajaba DENTRO del JWT (cookie `erp_token`). Cada permiso puesto a mano suma unos 40 bytes
 * y el navegador descarta las cookies de más de ~4096: con muchas pestañas contradiciendo su valor por
 * defecto, alguien podía quedar sin sesión sin saber por qué (ver el test A-4 de
 * tests/combustible-historial-compras-conductor.test.ts). Ahora el JWT no lo lleva: el servidor lo lee de acá
 * (y de la base si falta) y se lo pone a `req.usuario`; el cliente lo sigue recibiendo en el cuerpo del login,
 * del refresh y de `/api/auth/me`.
 *
 * ── Cuánto tarda un cambio ───────────────────────────────────────────────
 *
 * Guardar permisos (administración de la empresa o panel de plataforma) INVALIDA la entrada de esa persona:
 * rige en el siguiente request. Si algún camino no invalidara, el tope es el TTL (60 s), no los 30 minutos del
 * JWT de antes. Si Redis no responde, el respaldo en memoria hace lo mismo dentro de este proceso.
 */
import { getRedis } from "../../config/redis";

export type MapaDePermisosPestana = Record<string, boolean>;

const TTL_SEGUNDOS = 60;
const TTL_MS = TTL_SEGUNDOS * 1000;
const memoryCache = new Map<string, { permisos: MapaDePermisosPestana; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (now >= entry.expiresAt) memoryCache.delete(key);
  }
}, 5 * 60_000).unref();

const redisKey = (usuarioId: string) => `permpest:${usuarioId}`;

/** Los permisos en cache, o `undefined` si no hay (hay que leerlos de la base). */
export async function getCachedPermisosPestana(
  usuarioId: string
): Promise<MapaDePermisosPestana | undefined> {
  const redis = getRedis();
  if (redis) {
    try {
      const valor = await redis.get(redisKey(usuarioId));
      if (valor === null) return undefined;
      return JSON.parse(valor) as MapaDePermisosPestana;
    } catch {
      // Redis falló o la entrada no se pudo leer: seguimos con la memoria como respaldo.
    }
  }
  const guardado = memoryCache.get(usuarioId);
  if (guardado && Date.now() < guardado.expiresAt) return guardado.permisos;
  return undefined;
}

export async function setCachedPermisosPestana(
  usuarioId: string,
  permisos: MapaDePermisosPestana
): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(redisKey(usuarioId), JSON.stringify(permisos), "EX", TTL_SEGUNDOS);
      return;
    } catch {
      // sigue al respaldo en memoria
    }
  }
  memoryCache.set(usuarioId, { permisos, expiresAt: Date.now() + TTL_MS });
}

/** Se llama DESPUÉS de guardar (ya con el cambio confirmado): el siguiente request lee lo nuevo. */
export async function invalidateCachedPermisosPestana(usuarioId: string): Promise<void> {
  memoryCache.delete(usuarioId);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(redisKey(usuarioId));
    } catch {
      // no crítico: la entrada en Redis igual expira sola a los 60 s
    }
  }
}
