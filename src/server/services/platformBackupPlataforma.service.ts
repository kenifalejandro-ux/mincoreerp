/** src/server/services/platformBackupPlataforma.service.ts
 *
 * Backup de la CAPA DE PLATAFORMA — el metadato que ningún backup por
 * tenant contiene y sin el cual, ante una pérdida total de la base, no se
 * podría ni siquiera saber qué tenants existían para restaurarlos.
 * Ver docs/architecture/backups-s3.md.
 *
 * ── Qué entra, y por qué ─────────────────────────────────────────────────
 *
 *   tenants             el registro de qué clientes existen; sin esto no
 *                       hay a dónde restaurar ningún backup de tenant.
 *   platform_admins     quién puede operar el panel (incluido su SSO).
 *   tenant_modulos      qué módulos tiene contratado cada cliente — es
 *   usuario_modulos     información comercial que no vive en ningún otro
 *                       lado.
 *   tenant_sso_config   configuración de login corporativo por tenant;
 *   tenant_scim_config  reconstruirla a mano exige volver a coordinar con
 *                       el IT de cada cliente.
 *
 * ── Qué NO entra, y por qué ──────────────────────────────────────────────
 *
 *   Datos de negocio de los tenants → ya los cubre tenant_backups; ponerlos
 *     también acá duplicaría todo el contenido del sistema en cada backup
 *     de plataforma.
 *   usuarios → misma razón: viaja en el backup de cada tenant (es la
 *     primera tabla de TABLAS_TENANT). Esto tiene una consecuencia real en
 *     el restore, ver restaurarBackupPlataformaService.
 *   platform_audit_log → append-only, crece sin techo y tiene su propia
 *     política de retención (migración 0019). Un backup del log de
 *     auditoría es un problema distinto (archivado a largo plazo), no
 *     esto.
 *   platform_outbox → cola de trabajo transitoria; restaurar eventos
 *     viejos re-dispararía side effects ya procesados.
 *   refresh_tokens / reset_tokens → estado de sesión efímero. Restaurarlo
 *     sería revivir sesiones que deberían estar muertas.
 *
 * ── Sensibilidad ─────────────────────────────────────────────────────────
 *
 * Este backup contiene platform_admins.password_hash (bcrypt),
 * tenant_sso_config.client_secret_cifrado (AES, con APP_ENCRYPTION_KEY) y
 * tenant_scim_config.token_hash. Es el objeto más sensible que produce el
 * sistema: con driver s3 el cifrado de cliente es obligatorio y no
 * negociable (ver guardarBackup en platformBackupStorage.ts).
 */
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";
import {
  guardarBackup,
  leerBackup,
  driverDeEscritura,
  type DriverStorage,
} from "./platformBackupStorage";
import { construirKeyPlataforma } from "./platformBackupS3";

interface TablaPlataforma {
  nombre: string;
  /** Columnas que identifican una fila ya existente, para el ON CONFLICT
   *  del restore aditivo. */
  conflicto: string[];
  /** Columnas GENERATED de esta tabla — el backup las captura igual (viene
   *  de un SELECT *, ver exportarPlataformaService), pero Postgres rechaza
   *  cualquier INSERT que las mencione explícitamente. Sin este filtro el
   *  restore fallaría con "cannot insert into column ... generated
   *  column". */
  columnasGeneradas?: string[];
}

// Orden de INSERT en el restore: tenants primero, porque todo lo demás la
// referencia por FK.
const TABLAS_PLATAFORMA: TablaPlataforma[] = [
  // activo es GENERATED ALWAYS AS (estado = 'active') STORED desde
  // migrations/0038_tenant_estado_ciclo_vida.sql.
  { nombre: "tenants", conflicto: ["id"], columnasGeneradas: ["activo"] },
  { nombre: "platform_admins", conflicto: ["id"] },
  { nombre: "tenant_modulos", conflicto: ["tenant_id", "modulo"] },
  { nombre: "tenant_sso_config", conflicto: ["tenant_id"] },
  { nombre: "tenant_scim_config", conflicto: ["tenant_id"] },
  // Va última: referencia usuarios(id), que NO está en este backup — ver
  // el filtrado por FK existente en restaurarTablasPlataforma().
  { nombre: "usuario_modulos", conflicto: ["usuario_id", "modulo"] },
];

interface ContenidoBackupPlataforma {
  version: 1;
  tipo: "plataforma";
  creadoEn: string;
  tablas: Record<string, Record<string, unknown>[]>;
}

export interface PlatformBackup {
  id: string;
  storage: DriverStorage;
  storageKey: string;
  tamanoBytes: number;
  tablas: Record<string, number>;
  estado: "completo" | "fallido";
  creadoEn: string;
}

export async function exportarPlataformaService(
  contexto: ContextoAuditoria
): Promise<PlatformBackup> {
  try {
    // Sin withTenant(): ninguna de estas tablas tiene RLS (son de
    // plataforma, ver migraciones 0008/0016/0026/0028), y justamente hace
    // falta leerlas para TODOS los tenants a la vez.
    const tablas: Record<string, Record<string, unknown>[]> = {};
    for (const { nombre } of TABLAS_PLATAFORMA) {
      const filas = await pool.query(`SELECT * FROM ${nombre}`);
      tablas[nombre] = filas.rows;
    }

    const backup: ContenidoBackupPlataforma = {
      version: 1,
      tipo: "plataforma",
      creadoEn: new Date().toISOString(),
      tablas,
    };

    const resumenTablas = Object.fromEntries(
      Object.entries(tablas).map(([nombre, filas]) => [nombre, filas.length])
    );
    const key = construirKeyPlataforma();
    const { ubicacion, bytes } = await guardarBackup(key, JSON.stringify(backup), {
      tipo: "plataforma",
    });

    const registro = await pool.query(
      `INSERT INTO platform_backups (storage, storage_key, tamano_bytes, tablas, estado)
       VALUES ($1, $2, $3, $4, 'completo')
       RETURNING id, storage, storage_key AS "storageKey", tamano_bytes AS "tamanoBytes",
                 tablas, estado, creado_en AS "creadoEn"`,
      [ubicacion.storage, key, bytes, JSON.stringify(resumenTablas)]
    );

    await registrarAuditoria({
      accion: "crear_backup_plataforma",
      detalle: {
        backupId: registro.rows[0].id,
        storage: ubicacion.storage,
        storageKey: key,
        tablas: resumenTablas,
      },
      contexto,
    });

    // Number(): tamano_bytes es BIGINT y node-pg lo devuelve como string —
    // ver normalizarFilaBackup() en platformBackup.service.ts.
    return { ...registro.rows[0], tamanoBytes: Number(registro.rows[0].tamanoBytes) };
  } catch (err) {
    logger.error(
      { err, storage: driverDeEscritura() },
      "Falló la creación del backup de plataforma"
    );

    await registrarAuditoria({
      accion: "crear_backup_plataforma",
      detalle: {
        storage: driverDeEscritura(),
        error: err instanceof Error ? err.message : String(err),
      },
      contexto,
      resultado: "failure",
    });

    if (err instanceof AppError) throw err;
    throw new AppError(500, "No se pudo crear el backup de plataforma");
  }
}

export async function listarBackupsPlataformaService(): Promise<PlatformBackup[]> {
  const result = await pool.query(
    `SELECT id, storage, storage_key AS "storageKey", tamano_bytes AS "tamanoBytes",
            tablas, estado, creado_en AS "creadoEn"
     FROM platform_backups ORDER BY creado_en DESC`
  );
  return result.rows.map((fila) => ({ ...fila, tamanoBytes: Number(fila.tamanoBytes) }));
}

export interface ResultadoRestorePlataforma {
  /** Filas efectivamente insertadas por tabla (las que ya existían no se
   *  tocan, ver la semántica aditiva). */
  filasInsertadas: Record<string, number>;
  /** Filas del backup que se saltearon porque su FK apunta a algo que hoy
   *  no existe — hoy solo pasa con usuario_modulos, cuyos usuarios viven
   *  en los backups por tenant. */
  filasSalteadasPorFk: Record<string, number>;
}

/** Restaura las filas de una tabla de plataforma SIN pisar lo existente.
 *  ON CONFLICT DO NOTHING, nunca DO UPDATE: ver la explicación de la
 *  semántica aditiva en restaurarBackupPlataformaService.
 *
 *  ── Por qué TODO corre en una sola transacción ──────────────────────────
 *
 *  Sin ella, un fallo a mitad de camino deja la plataforma restaurada a
 *  medias (ej. los `tenants` insertados pero no sus `tenant_modulos`), que
 *  es un estado peor que no haber restaurado nada — y esto pasa durante un
 *  incidente, donde nadie tiene tiempo de auditar qué quedó a medias. El
 *  restore por tenant ya tenía esta garantía (corre dentro de withTenant());
 *  éste no la tenía.
 *
 *  ── Por qué cada FILA va en su propio SAVEPOINT ─────────────────────────
 *
 *  El backup es una foto en el tiempo; la base sigue viva mientras dura el
 *  restore. Una fila puede referenciar (por FK) un `tenant`/`usuario` que
 *  el backup SÍ capturó pero que otro proceso borra de verdad mientras
 *  este restore todavía está insertando — no es un caso raro, es lo
 *  normal en un restore de plataforma que corre junto a tráfico real. Sin
 *  SAVEPOINT, ese INSERT revienta con FK violation (23503) y aborta la
 *  transacción ENTERA: un tenant borrado por otro motivo un rato antes
 *  tira abajo el restore completo de todos los demás.
 *
 *  Se probaron dos enfoques más débiles antes de este, los dos fallaron
 *  por la misma razón (encontrado por un test intermitente en la suite
 *  completa — nunca aislado — que reprodujo ambas variantes):
 *
 *    1. Un pre-chequeo en JS ("¿existe hoy este usuario?") armado con un
 *       SELECT al principio de la transacción: quedaba viejo apenas algo
 *       se borraba DESPUÉS de ese SELECT y ANTES del INSERT real.
 *    2. Confiar en que el propio INSERT de la fila padre (`tenants`) dentro
 *       de esta misma transacción tomara un lock FOR KEY SHARE que
 *       protegiera a sus hijos (`tenant_modulos`, etc.): eso solo protege
 *       tenants NUEVOS que este restore inserta de cero. Un tenant que YA
 *       existía (ON CONFLICT DO NOTHING no toca la fila) no queda
 *       bloqueado por nada, y puede desaparecer entre que se procesa
 *       `tenants` y se procesa su tabla hija.
 *
 *  La única fuente de verdad confiable es la FK real de Postgres, evaluada
 *  en el momento exacto del INSERT — nunca un chequeo previo en JS. Por
 *  eso cada fila corre en su propio SAVEPOINT: si el INSERT viola una FK,
 *  se vuelve a ese punto (sin perder el resto de la transacción) y la fila
 *  se cuenta como salteada. */
async function restaurarTablasPlataforma(
  backup: ContenidoBackupPlataforma
): Promise<ResultadoRestorePlataforma> {
  const filasInsertadas: Record<string, number> = {};
  const filasSalteadasPorFk: Record<string, number> = {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const meta of TABLAS_PLATAFORMA) {
      const filas = backup.tablas[meta.nombre] ?? [];
      filasInsertadas[meta.nombre] = 0;
      filasSalteadasPorFk[meta.nombre] = 0;

      for (const fila of filas) {
        const columnas = Object.keys(fila).filter((c) => !meta.columnasGeneradas?.includes(c));
        const placeholders = columnas.map((_, i) => `$${i + 1}`).join(", ");

        // Ver el comentario de la función sobre por qué esto va en un
        // SAVEPOINT por fila y no en un pre-chequeo: cualquier tabla acá
        // puede referenciar algo que otro proceso borra mientras el
        // restore está en curso, no solo usuario_modulos.
        await client.query("SAVEPOINT antes_de_fila");
        try {
          const resultado = await client.query(
            `INSERT INTO ${meta.nombre} (${columnas.join(", ")}) VALUES (${placeholders})
             ON CONFLICT (${meta.conflicto.join(", ")}) DO NOTHING`,
            columnas.map((c) => fila[c])
          );
          filasInsertadas[meta.nombre] += resultado.rowCount ?? 0;
          await client.query("RELEASE SAVEPOINT antes_de_fila");
        } catch (err) {
          if ((err as { code?: string }).code === "23503") {
            await client.query("ROLLBACK TO SAVEPOINT antes_de_fila");
            filasSalteadasPorFk[meta.nombre]++;
          } else {
            throw err;
          }
        }
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { filasInsertadas, filasSalteadasPorFk };
}

/** Restaura un backup de plataforma con semántica ADITIVA: inserta lo que
 *  falta, nunca modifica ni borra lo que ya está.
 *
 *  Es una diferencia deliberada con el restore por tenant, que sí vacía
 *  antes de restaurar ("punto de restauración"). Acá vaciar sería
 *  catastrófico: un DELETE sobre `tenants` cascadea —vía las FK de
 *  tenant_metricas_horarias, tenant_backups, tenant_sso_config...— hacia
 *  todo el sistema, y un restore de plataforma se ejecuta justamente
 *  durante un incidente, que es el peor momento para una operación
 *  destructiva e irreversible.
 *
 *  Lo que esto SÍ resuelve: reconstruir la plataforma sobre una base vacía
 *  (disaster recovery real), y recuperar filas borradas por error.
 *  Lo que NO resuelve: revertir una MODIFICACIÓN (si a un tenant le
 *  cambiaron el nombre o los módulos contratados, restaurar no lo vuelve
 *  atrás — la fila ya existe y se respeta). Deshacer eso es un cambio
 *  manual y puntual, no un restore masivo. */
export async function restaurarBackupPlataformaService(
  backupId: string,
  contexto: ContextoAuditoria
): Promise<ResultadoRestorePlataforma> {
  const backupRow = await pool.query(`SELECT * FROM platform_backups WHERE id = $1`, [backupId]);
  if (backupRow.rows.length === 0) {
    throw new AppError(404, "Backup de plataforma no encontrado");
  }

  const ubicacion = {
    storage: (backupRow.rows[0].storage ?? "local") as DriverStorage,
    key: backupRow.rows[0].storage_key as string,
  };

  try {
    const crudo = await leerBackup(ubicacion);
    const backup = JSON.parse(crudo) as ContenidoBackupPlataforma;

    if (backup.tipo !== "plataforma") {
      throw new AppError(400, "El backup indicado no es un backup de plataforma");
    }

    const resultado = await restaurarTablasPlataforma(backup);

    await registrarAuditoria({
      accion: "restaurar_backup_plataforma",
      detalle: { backupId, storage: ubicacion.storage, storageKey: ubicacion.key, ...resultado },
      contexto,
    });

    return resultado;
  } catch (err) {
    logger.error({ err, backupId, ...ubicacion }, "Falló la restauración del backup de plataforma");

    await registrarAuditoria({
      accion: "restaurar_backup_plataforma",
      detalle: {
        backupId,
        storage: ubicacion.storage,
        storageKey: ubicacion.key,
        error: err instanceof Error ? err.message : String(err),
      },
      contexto,
      resultado: "failure",
    });

    if (err instanceof AppError) throw err;
    throw new AppError(500, "No se pudo restaurar el backup de plataforma");
  }
}
