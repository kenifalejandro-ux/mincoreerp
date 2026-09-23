/** src/server/config/database.ts */

import { Pool, type PoolClient } from "pg";
import { env } from "./env";
import { logger } from "./logger";

// Sin TLS en localhost (no aporta nada). En host remoto sí se cifra, pero
// SIN validar la cadena: el Postgres interno de Railway (*.railway.internal)
// entrega un certificado autofirmado, y la conexión ya viaja por la red
// privada de Railway (cifrada a nivel de infraestructura) — no es un host
// público que necesite verificación de CA.
const hostRemoto =
  Boolean(process.env.DATABASE_URL) || !["localhost", "127.0.0.1", "::1"].includes(env.dbHost);

// Railway provee DATABASE_URL; en local usamos las variables individuales
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: hostRemoto ? { rejectUnauthorized: false } : false,
    }
  : {
      host: env.dbHost,
      user: env.dbUser,
      password: env.dbPass,
      database: env.dbName,
      port: env.dbPort,
      ssl: env.isProduction && hostRemoto ? { rejectUnauthorized: false } : false,
    };

export const pool = new Pool({
  ...poolConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ====================== EVENTOS DEL POOL ======================
pool.on("connect", () => {
  logger.debug("Nueva conexión establecida con PostgreSQL");
});

pool.on("error", (err) => {
  logger.error({ err }, "Error inesperado en el pool de PostgreSQL");
});

pool.on("remove", () => {
  logger.debug("Conexión removida del pool");
});

// ====================== FUNCIÓN DE TEST ======================
export async function testDatabaseConnection(): Promise<boolean> {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query("SELECT NOW() as current_time");

    logger.info({
      message: "✅ Conexión a PostgreSQL exitosa",
      timestamp: result.rows[0].current_time,
      database: env.dbName || "zincel_rp",
    });

    return true;
  } catch (error) {
    logger.error({
      err: error,
      message: "❌ Error al conectar con PostgreSQL",
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (client) client.release();
  }
}

// ====================== AISLAMIENTO MULTI-TENANT (RLS) ======================
// pool.query() puede usar una conexión distinta en cada llamada, así que no
// sirve para setear una variable de sesión que después lean las políticas
// de Row-Level Security (ver migrations/0005_rls_tenant_isolation.sql).
// Por eso acá se reserva un client dedicado del pool para toda la duración
// del request, dentro de una transacción: set_config con is_local=true deja
// app.tenant_id visible solo hasta el COMMIT/ROLLBACK de esta transacción,
// nunca se filtra a la siguiente vez que ese client vuelva al pool.
//
// El filtro por tenant_id en el WHERE de cada query (ver los repositorios)
// sigue siendo el mecanismo principal — esto es la red de seguridad si
// alguna query nueva se olvida de filtrar.
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** El uuid nulo: no es el id de ninguna empresa. `withCuenta` lo usa para
 *  dejar `app.tenant_id` en un valor que no matchea nada, en vez de no
 *  setearlo -- la política `tenant_isolation` de `usuarios` (0010) llama a
 *  `current_setting('app.tenant_id')` SIN missing_ok, así que sin valor la
 *  consulta falla antes de que la otra política pueda decir que sí. */
const TENANT_NINGUNO = "00000000-0000-0000-0000-000000000000";

/** Lee los perfiles de UNA cuenta en todas sus empresas.
 *
 *  Hace falta en un solo lugar del sistema: al entrar, para saber a qué
 *  empresas tiene acceso la persona (ver docs/architecture/
 *  cuentas-perfiles-y-administracion.md §5). El resto del ERP sigue usando
 *  `withTenant`, que no cambió.
 *
 *  Cómo no se rompe el aislamiento: la migración 0087 agrega a `usuarios` una
 *  segunda política, SOLO de lectura, que deja ver las filas cuyo `cuenta_id`
 *  coincida con `app.cuenta_id`. Acá se fija esa variable y se deja
 *  `app.tenant_id` en un uuid que no existe. Resultado: se ven los perfiles de
 *  esa persona y nada más, y cualquier escritura sigue limitada a la política
 *  de empresa.
 *
 *  REGLA: `cuentaId` tiene que venir de una cuenta YA AUTENTICADA (clave
 *  verificada, token de selección validado o SSO resuelto). Nunca de algo que
 *  mandó el cliente sin verificar -- sería dejar que alguien liste los perfiles
 *  de otra persona escribiendo su id. */
export async function withCuenta<T>(
  cuentaId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_NINGUNO]);
    await client.query("SELECT set_config('app.cuenta_id', $1, true)", [cuentaId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ====================== FUNCIÓN PARA CERRAR ======================
export async function closeDatabase(): Promise<void> {
  try {
    await pool.end();
    logger.info("Pool de PostgreSQL cerrado correctamente");
  } catch (error) {
    logger.warn({ err: error }, "Error al cerrar el pool de PostgreSQL");
  }
}
