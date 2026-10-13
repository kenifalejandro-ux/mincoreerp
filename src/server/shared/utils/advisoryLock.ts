/** src/server/shared/utils/advisoryLock.ts
 *
 * Ejecuta una tarea solo si nadie más la está corriendo en este instante,
 * usando un advisory lock TRANSACCIONAL de Postgres (`pg_try_advisory_xact_lock`
 * — se libera solo al COMMIT/ROLLBACK, nunca hace falta un unlock explícito).
 *
 * Pensado para los workers periódicos (particionado, retención de backups,
 * retención de auditoría): hoy corren con setInterval sin ninguna
 * coordinación, así que agregar una segunda instancia del server
 * duplicaría ese trabajo. El outbox worker no lo necesita — ya usa
 * `SELECT ... FOR UPDATE SKIP LOCKED` por fila (ver platformOutbox.service.ts),
 * que resuelve lo mismo a nivel de dato en vez de a nivel de proceso.
 *
 * ── Por qué xact-lock y no un lock de sesión ─────────────────────────────
 *
 * La primera versión de este archivo usaba `pg_try_advisory_lock` +
 * `pg_advisory_unlock` (mismo mecanismo que migrate.ts al arrancar): un
 * lock de SESIÓN, que vive atado a la conexión física de Postgres que lo
 * pidió, sin importar cuántas transacciones corran de por medio.
 *
 * Eso es incompatible con un pooler externo en modo transacción (PgBouncer
 * transaction pooling, el modo recomendado para escalar conexiones — ver
 * docs/architecture/escalabilidad-preventiva.md): ahí, PgBouncer solo
 * garantiza que un cliente mantenga la MISMA conexión de backend mientras
 * dura una transacción explícita. Tomar el lock y soltarlo como dos
 * sentencias sueltas (sin BEGIN/COMMIT alrededor) corre el riesgo real de
 * que PgBouncer las despache contra dos conexiones de backend distintas —
 * el lock quedaría tomado para siempre en una conexión que nadie vuelve a
 * tocar, hasta que PgBouncer la resetee.
 *
 * Un advisory lock TRANSACCIONAL no tiene ese problema: se libera solo al
 * COMMIT o ROLLBACK de la transacción que lo tomó, así que mientras el
 * BEGIN/COMMIT ocurran sobre el mismo client (como acá) da igual cuántas
 * conexiones de backend distintas use PgBouncer entre una transacción y la
 * siguiente — dentro de UNA transacción, PgBouncer sí la ata a un solo
 * backend de punta a punta.
 *
 * La consecuencia práctica: el trabajo protegido (`fn`) tiene que correr
 * DENTRO de esa misma transacción — recibe el `client` para eso. Si
 * necesitara su propia transacción larga, el lock se liberaría recién al
 * final de TODA esa transacción, no apenas termine el trabajo — por eso el
 * worker de retención de auditoría, que borra en lotes, pide el lock una
 * vez POR LOTE en vez de una sola vez para toda la corrida (ver
 * platformAuditRetention.worker.ts).
 */
import type { PoolClient } from "pg";
import { pool } from "../../config/database";
import { logger } from "../../config/logger";

/** Cada worker que use esto necesita su propio ID, fijo y arbitrario —
 *  compartir uno haría que se bloqueen entre sí sin motivo. */
export const LOCK_IDS = {
  particionado: 483921,
  backupRetention: 483922,
  auditRetention: 483923,
  backupDrill: 483924,
  backupWriteDrill: 483925,
  eventosTiempoRealRetention: 483926,
  idempotencyKeysRetention: 483927,
  combustibleConciliacion: 483928,
  combustibleResumenAlertas: 483929,
} as const;

/** Corre `fn(client)` solo si logra tomar el lock `lockId`, dentro de una
 *  transacción que se abre y cierra acá mismo; si otra instancia ya lo
 *  tiene, no hace nada y devuelve `undefined`. `fn` DEBE hacer su trabajo
 *  con el `client` que recibe (no con `pool` directo): son dos conexiones
 *  distintas, y usar `pool` dejaría ese trabajo corriendo por fuera de la
 *  transacción que sostiene el lock — sin ninguna protección real.
 *
 *  `siempreRollback`: por default (`false`) un `fn` que resuelve sin error
 *  termina en COMMIT, como siempre. En `true`, termina SIEMPRE en ROLLBACK
 *  — incluso si `fn` no tiró error — y `fn` sigue devolviendo su resultado
 *  igual. Pensado para tareas que deliberadamente no deben dejar rastro
 *  (ver platformBackupWriteDrill.worker.ts): un restore de prueba que
 *  necesita ejercitar el camino real de escritura sin que nada de lo que
 *  escribe sobreviva, pase lo que pase. */
export async function runSiPrimero<T>(
  lockId: number,
  fn: (client: PoolClient) => Promise<T>,
  opciones?: { siempreRollback?: boolean }
): Promise<T | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ tomado: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS tomado",
      [lockId]
    );
    if (!rows[0].tomado) {
      await client.query("ROLLBACK");
      logger.debug({ lockId }, "Lock ya tomado por otra instancia, se salta esta corrida");
      return undefined;
    }
    try {
      const resultado = await fn(client);
      await client.query(opciones?.siempreRollback ? "ROLLBACK" : "COMMIT");
      return resultado;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}
