/** src/server/services/platformCuotas.service.ts
 *
 * Cuotas operativas por tenant: cuántos usuarios activos, cuántos registros
 * por módulo y cuánto ocupan sus backups. Ver
 * docs/architecture/cuotas-por-tenant.md.
 *
 * ── Qué garantiza y qué no ───────────────────────────────────────────────
 *
 * Al excederse se BLOQUEA la creación del recurso siguiente. Nunca se borra,
 * oculta ni degrada nada de lo ya cargado: una cuota es un tope de
 * crecimiento, no una excusa para tocarle los datos a un cliente. Leer y
 * borrar siguen funcionando siempre — si no, un tenant en el límite quedaría
 * atrapado sin forma de bajar por debajo.
 *
 * El chequeo es "contar y después insertar", así que bajo concurrencia real
 * dos requests simultáneos pueden ver el mismo conteo y pasar los dos: el
 * exceso posible está acotado a la cantidad de requests en vuelo, no es
 * ilimitado. Cerrar esa ventana del todo exigiría una fila contador con
 * lock (o un trigger) por tenant y recurso, serializando todas las altas de
 * ese tenant — un costo permanente en el camino caliente para evitar un
 * desvío de unas pocas filas sobre límites de decenas de miles. No vale la
 * pena, y se documenta en vez de fingir una exactitud que no hay.
 *
 * ── Dónde vive cada límite ───────────────────────────────────────────────
 *
 * El default está en código (registry para módulos, las constantes de acá
 * para usuarios/backups); tenant_cuotas (migración 0033) solo guarda
 * EXCEPCIONES. Ver el encabezado de esa migración sobre por qué "sin fila",
 * "fila con número" y "fila con NULL" son tres estados distintos.
 */
import type { PoolClient } from "pg";
import { pool, withTenant } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";
import { MODULOS, obtenerModulo } from "../../modules/registry";
import { RECURSO_RATE_LIMIT, invalidarCacheRateLimit } from "./platformRateLimitCuota";
import { getRedis } from "../config/redis";
import { logger } from "../config/logger";

/** Recursos que no pertenecen a ningún módulo. Los de módulo se derivan del
 *  registry, así que un módulo nuevo con `cuota` declarada aparece acá solo,
 *  sin tocar este archivo (parte del Contrato de Módulo, ADR-0002). */
export const RECURSO_USUARIOS = "usuarios";
export const RECURSO_BACKUP_BYTES = "backup_bytes";

/** Usuarios ACTIVOS, no filas en la tabla: desactivar a alguien tiene que
 *  liberar su cupo, porque "eliminar" un usuario en este sistema es
 *  desactivarlo (nunca un DELETE — hay historial que lo referencia). Si se
 *  contaran las filas, un tenant con rotación de personal se quedaría sin
 *  cupo para siempre. */
const LIMITE_USUARIOS_POR_DEFECTO = 100;

/** 5 GiB de backups acumulados por tenant. A diferencia de los otros
 *  recursos, éste tiene un costo directo y recurrente desde que los backups
 *  van a S3 (se paga por GB-mes almacenado). El tope se mide sobre la suma
 *  de los backups que EXISTEN, así que la retención (GFS) lo baja sola al
 *  podar los viejos. */
const LIMITE_BACKUP_BYTES_POR_DEFECTO = 5 * 1024 * 1024 * 1024;

export interface DefinicionRecurso {
  recurso: string;
  /** Para mostrar en el panel: 'cantidad' se muestra como número,
   *  'bytes' se formatea como tamaño. */
  unidad: "cantidad" | "bytes";
  limitePorDefecto: number;
}

/** Catálogo completo de recursos con cuota. Los de módulo salen del
 *  registry (tanto `cuota`, con `recurso = id del módulo`, como
 *  `cuotasPorRuta`, con su propio `recurso` -- ver el comentario largo en
 *  modules/types.ts); los módulos sin ninguno de los dos (ej. dashboard,
 *  que no crea nada propio) quedan afuera solos. */
export function recursosConCuota(): DefinicionRecurso[] {
  return [
    {
      recurso: RECURSO_USUARIOS,
      unidad: "cantidad",
      limitePorDefecto: LIMITE_USUARIOS_POR_DEFECTO,
    },
    {
      recurso: RECURSO_BACKUP_BYTES,
      unidad: "bytes",
      limitePorDefecto: LIMITE_BACKUP_BYTES_POR_DEFECTO,
    },
    ...MODULOS.filter((m) => m.cuota).map((m) => ({
      recurso: m.id,
      unidad: "cantidad" as const,
      limitePorDefecto: m.cuota!.porDefecto,
    })),
    // Varias rutas pueden crecer el mismo recurso (Viajes: «/» y «/crear-mio»): una sola definición
    // por recurso, o el panel lo mostraría repetido.
    ...[
      ...new Map(
        MODULOS.flatMap((m) => m.cuotasPorRuta ?? []).map((c) => [c.recurso, c] as const)
      ).values(),
    ].map((c) => ({
      recurso: c.recurso,
      unidad: "cantidad" as const,
      limitePorDefecto: c.porDefecto,
    })),
  ];
}

function definicionDe(recurso: string): DefinicionRecurso | undefined {
  return recursosConCuota().find((r) => r.recurso === recurso);
}

/** Qué tabla contar para un recurso de módulo -- busca primero en `cuota`
 *  (recurso = id del módulo) y después en `cuotasPorRuta` (recurso = su
 *  propio id declarado). `undefined` si el recurso no es de ningún
 *  módulo (ej. 'usuarios', 'backup_bytes', o uno inexistente). */
function tablaDeRecurso(recurso: string): string | undefined {
  const modulo = obtenerModulo(recurso);
  if (modulo?.cuota) return modulo.cuota.tabla;

  for (const m of MODULOS) {
    const porRuta = m.cuotasPorRuta?.find((c) => c.recurso === recurso);
    if (porRuta) return porRuta.tabla;
  }
  return undefined;
}

/** De dónde salió el límite que se está aplicando. Se expone en el panel
 *  porque "500 equipos" sin saber si viene del plan o de una excepción
 *  negociada es un dato a medias: cambiar el plan mueve uno y no el otro. */
export type OrigenLimite = "override" | "plan" | "registry";

export interface LimiteResuelto {
  limite: number | null;
  origen: OrigenLimite;
}

/** Resuelve el límite de UN recurso con los tres niveles de precedencia:
 *
 *    1. tenant_cuotas   → excepción negociada con ese cliente
 *    2. plan del tenant → MYPE / Pequeña / Mediana / Corporativo
 *    3. registry        → default de última instancia
 *
 *  En los niveles 1 y 2, `NULL` significa ILIMITADO a propósito y no "sin
 *  dato" — por eso lo que decide es la EXISTENCIA de la fila, no que el
 *  valor sea distinto de null. Confundir esos dos casos haría que
 *  "ilimitado" cayera al nivel siguiente y terminara aplicando un tope.
 *
 *  Una sola query para los dos primeros niveles: esto corre en cada POST
 *  (ver requireCuota), así que no puede costar dos round trips — y encima
 *  con caché por delante (ver resolverLimite más abajo), que evita incluso
 *  esa única query en el caso común. */
async function resolverLimiteDesdeBase(tenantId: string, recurso: string): Promise<LimiteResuelto> {
  const definicion = definicionDe(recurso);
  if (!definicion) return { limite: null, origen: "registry" }; // recurso desconocido: nada que aplicar

  const fila = await pool.query<{
    hay_override: boolean;
    limite_override: string | null;
    hay_plan: boolean;
    limite_plan: string | null;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM tenant_cuotas WHERE tenant_id = $1 AND recurso = $2) AS hay_override,
       (SELECT limite FROM tenant_cuotas WHERE tenant_id = $1 AND recurso = $2) AS limite_override,
       EXISTS (
         SELECT 1 FROM tenants t JOIN plan_limites pl ON pl.plan_id = t.plan_id
         WHERE t.id = $1 AND pl.recurso = $2
       ) AS hay_plan,
       (SELECT pl.limite FROM tenants t JOIN plan_limites pl ON pl.plan_id = t.plan_id
        WHERE t.id = $1 AND pl.recurso = $2) AS limite_plan`,
    [tenantId, recurso]
  );

  const r = fila.rows[0];

  // BIGINT vuelve como string desde node-pg (mismo caso que tamano_bytes en
  // platformBackup.service.ts), por eso el Number() explícito.
  if (r.hay_override) {
    return {
      limite: r.limite_override === null ? null : Number(r.limite_override),
      origen: "override",
    };
  }
  if (r.hay_plan) {
    return { limite: r.limite_plan === null ? null : Number(r.limite_plan), origen: "plan" };
  }
  return { limite: definicion.limitePorDefecto, origen: "registry" };
}

// ── Caché de resolverLimite() ─────────────────────────────────────────────
//
// Mismo patrón que platformRateLimitCuota.ts (Redis con TTL corto +
// fallback en memoria si Redis no está disponible): el LÍMITE configurado
// cambia poco (solo cuando un admin toca tenant_cuotas o reasigna un plan,
// los dos únicos lugares que llaman a invalidarCacheLimite/
// invalidarCacheLimitesTenant), pero resolverLimite() corre en cada POST
// vía requireCuota — cachearlo es lo que evita pegarle a Postgres en el
// camino caliente de creación de cualquier módulo.
//
// A propósito NO se cachea usoActual(): ese número cambia con cada INSERT
// del propio tenant, y cachearlo rompería la cuota (un tenant podría crear
// de más mientras el conteo cacheado queda desactualizado). El límite
// configurado es la parte estable; el uso es la parte que tiene que leerse
// siempre fresca.
const TTL_REDIS_SEGUNDOS = 300;
const MEMORIA_TTL_MS = 30_000;

const memoria = new Map<string, { valor: LimiteResuelto; expiraEn: number }>();

setInterval(() => {
  const ahora = Date.now();
  for (const [clave, entrada] of memoria) {
    if (ahora >= entrada.expiraEn) memoria.delete(clave);
  }
}, 60_000).unref();

function claveCache(tenantId: string, recurso: string): string {
  return `cuota-limite:${tenantId}:${recurso}`;
}

/** Resuelve el límite de un recurso, con caché por delante. Mismo
 *  resultado que resolverLimiteDesdeBase(), pero en el caso común no toca
 *  Postgres. */
export async function resolverLimite(tenantId: string, recurso: string): Promise<LimiteResuelto> {
  const clave = claveCache(tenantId, recurso);
  const redis = getRedis();

  if (redis) {
    try {
      const cacheado = await redis.get(clave);
      if (cacheado !== null) return JSON.parse(cacheado) as LimiteResuelto;

      const valor = await resolverLimiteDesdeBase(tenantId, recurso);
      await redis.set(clave, JSON.stringify(valor), "EX", TTL_REDIS_SEGUNDOS);
      return valor;
    } catch (err) {
      // Un fallo de Redis no puede bloquear la creación de recursos: se
      // sigue por memoria, igual que hace resolverRateLimitTenant().
      logger.warn(
        { err, tenantId, recurso },
        "Redis falló al resolver el límite de cuota, se usa caché en memoria"
      );
    }
  }

  const enMemoria = memoria.get(clave);
  if (enMemoria && Date.now() < enMemoria.expiraEn) return enMemoria.valor;

  const valor = await resolverLimiteDesdeBase(tenantId, recurso);
  memoria.set(clave, { valor, expiraEn: Date.now() + MEMORIA_TTL_MS });
  return valor;
}

/** Se llama al guardar un override puntual (fijarCuotaTenant). Sin esto,
 *  el cambio no tendría efecto hasta que venciera el TTL. */
export async function invalidarCacheLimite(tenantId: string, recurso: string): Promise<void> {
  const clave = claveCache(tenantId, recurso);
  memoria.delete(clave);

  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(clave);
  } catch (err) {
    logger.warn(
      { err, tenantId, recurso },
      "No se pudo invalidar el caché de cuota; caducará por TTL"
    );
  }
}

/** Se llama al reasignar el plan de un tenant: a diferencia de un override
 *  puntual, cambia el nivel 2 de TODOS los recursos que no tengan
 *  excepción propia — así que hay que invalidar el catálogo entero para
 *  ese tenant, no un solo recurso. La lista de recursos es finita y ya
 *  vive en proceso (recursosConCuota()), así que no hace falta un SCAN
 *  sobre Redis. */
export async function invalidarCacheLimitesTenant(tenantId: string): Promise<void> {
  await Promise.all(recursosConCuota().map((d) => invalidarCacheLimite(tenantId, d.recurso)));
}

/** `null` = ilimitado. Envoltorio de resolverLimite() para los llamadores a
 *  los que no les interesa de qué nivel salió. */
export async function limiteEfectivo(tenantId: string, recurso: string): Promise<number | null> {
  return (await resolverLimite(tenantId, recurso)).limite;
}

/** Cuánto consume HOY el tenant de ese recurso.
 *
 *  `client` opcional: si se pasa, la medición corre dentro de esa misma
 *  transacción (con app.tenant_id ya seteado) en vez de abrir otra. Es lo
 *  que permite contar y después insertar sin soltar la transacción — no
 *  elimina la carrera descrita arriba, pero evita medir contra un estado
 *  distinto del que se va a escribir. */
export async function usoActual(
  tenantId: string,
  recurso: string,
  client?: PoolClient
): Promise<number> {
  if (recurso === RECURSO_BACKUP_BYTES) {
    // tenant_backups no tiene RLS (es tabla de plataforma), así que va por
    // pool directo aunque nos pasen un client de tenant.
    const resultado = await pool.query<{ total: string }>(
      `SELECT COALESCE(sum(tamano_bytes), 0)::text AS total FROM tenant_backups WHERE tenant_id = $1`,
      [tenantId]
    );
    return Number(resultado.rows[0].total);
  }

  const contar = async (c: PoolClient): Promise<number> => {
    if (recurso === RECURSO_USUARIOS) {
      const r = await c.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM usuarios WHERE tenant_id = $1 AND activo = true`,
        [tenantId]
      );
      return Number(r.rows[0].total);
    }

    const tabla = tablaDeRecurso(recurso);
    if (!tabla) return 0;
    // La tabla sale del registry, nunca de un parámetro del request: no hay
    // forma de que un valor del cliente termine interpolado acá.
    const r = await c.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${tabla} WHERE tenant_id = $1`,
      [tenantId]
    );
    return Number(r.rows[0].total);
  };

  // usuarios y las tablas de módulo tienen RLS: sin app.tenant_id seteado la
  // policy evalúa ''::uuid y la query falla (ver ADR-0001).
  return client ? contar(client) : withTenant(tenantId, contar);
}

export interface EstadoCuota {
  recurso: string;
  unidad: "cantidad" | "bytes";
  limite: number | null;
  /** De qué nivel salió el límite: excepción del tenant, plan, o default. */
  origen: OrigenLimite;
  uso: number;
  /** null cuando el recurso es ilimitado. */
  porcentaje: number | null;
  excedido: boolean;
}

/** Uso vs. límite de todos los recursos de un tenant — para el panel y para
 *  la salud del tenant. */
export async function resumenCuotasTenant(tenantId: string): Promise<EstadoCuota[]> {
  const estados: EstadoCuota[] = [];
  for (const definicion of recursosConCuota()) {
    const [resuelto, uso] = await Promise.all([
      resolverLimite(tenantId, definicion.recurso),
      usoActual(tenantId, definicion.recurso),
    ]);
    const { limite, origen } = resuelto;
    estados.push({
      recurso: definicion.recurso,
      unidad: definicion.unidad,
      limite,
      origen,
      uso,
      porcentaje: limite === null || limite === 0 ? null : Math.round((uso / limite) * 100),
      excedido: limite !== null && uso >= limite,
    });
  }
  return estados;
}

export class CuotaExcedidaError extends AppError {
  constructor(
    public readonly recurso: string,
    public readonly limite: number,
    public readonly uso: number,
    public readonly incremento: number
  ) {
    // 403 y no 402 (Payment Required): 402 promete que pagando se
    // desbloquea, y en este sistema no hay billing — un límite se levanta
    // desde el panel, no pagando. Tampoco 429, que es para frecuencia de
    // requests, no para volumen acumulado.
    super(
      403,
      incremento > 1
        ? `Cuota de "${recurso}" excedida: la operación agregaría ${incremento} registros y quedarían ${uso + incremento} sobre un límite de ${limite}.`
        : `Cuota de "${recurso}" excedida: ${uso} de ${limite} en uso.`
    );
    this.name = "CuotaExcedidaError";
  }
}

/** Tira CuotaExcedidaError si crear `incremento` unidades más pasaría el
 *  límite. No hace nada si el recurso es ilimitado o desconocido. */
export async function verificarCuota(
  tenantId: string,
  recurso: string,
  incremento = 1,
  client?: PoolClient
): Promise<void> {
  const { limite } = await resolverLimite(tenantId, recurso);
  if (limite === null) return;

  const uso = await usoActual(tenantId, recurso, client);
  if (uso + incremento > limite) {
    throw new CuotaExcedidaError(recurso, limite, uso, incremento);
  }
}

export interface CuotaConfigurada {
  recurso: string;
  limite: number | null;
  motivo: string | null;
  actualizadoEn: string;
}

/** Fija (o quita) el override de un tenant. `limite: null` = ilimitado;
 *  pasar `undefined` borra la fila y devuelve el tenant al default del
 *  código — que NO es lo mismo (ver la migración 0033). */
export async function fijarCuotaTenant(
  tenantId: string,
  recurso: string,
  limite: number | null | undefined,
  motivo?: string
): Promise<void> {
  // rate_limit_rpm se guarda en la misma tabla y se resuelve con la misma
  // lógica de override, pero NO está en recursosConCuota() a propósito: ese
  // catálogo alimenta la tabla de cuotas de VOLUMEN del panel y las alertas
  // de salud, donde una columna "uso" no significa nada para un ritmo por
  // minuto. Mezclarlos confundiría a quien lee el panel.
  const esRateLimit = recurso === RECURSO_RATE_LIMIT;
  if (!esRateLimit && !definicionDe(recurso)) {
    throw new AppError(400, `Recurso de cuota desconocido: ${recurso}`);
  }

  if (limite === undefined) {
    await pool.query(`DELETE FROM tenant_cuotas WHERE tenant_id = $1 AND recurso = $2`, [
      tenantId,
      recurso,
    ]);
    if (esRateLimit) await invalidarCacheRateLimit(tenantId);
    else await invalidarCacheLimite(tenantId, recurso);
    return;
  }

  await pool.query(
    `INSERT INTO tenant_cuotas (tenant_id, recurso, limite, motivo, actualizado_en)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, recurso)
     DO UPDATE SET limite = EXCLUDED.limite, motivo = EXCLUDED.motivo, actualizado_en = now()`,
    [tenantId, recurso, limite, motivo ?? null]
  );

  // Sin esto el cambio no tendría efecto hasta que venciera el TTL: el admin
  // lo guardaría, no pasaría nada por 5 minutos, y volvería a intentarlo
  // pensando que falló.
  if (esRateLimit) await invalidarCacheRateLimit(tenantId);
  else await invalidarCacheLimite(tenantId, recurso);
}
