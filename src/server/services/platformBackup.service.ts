/** src/server/services/platformBackup.service.ts
 *
 * Backup y restore por tenant — "mecanismo mínimo viable", no un sistema
 * de disaster recovery completo. Exporta a JSON (sin dependencia de
 * pg_dump ni de un binario externo) todas las tablas de negocio de un
 * tenant, y puede restaurar ese export sobre un tenant (vacío, o como
 * "punto de restauración" que reemplaza lo que ese tenant tenga hoy).
 *
 * TABLAS: cada módulo declara sus propias tablas (ver `tablas` en
 * ModuloDefinicion, src/modules/registry.ts) en orden seguro de INSERT
 * (padres antes que hijos) — este archivo ya no mantiene esa lista a
 * mano. Antes de este cambio, un módulo nuevo cuyas tablas no se
 * agregaran acá quedaba fuera del backup en silencio (sin error, solo sin
 * exportar esas filas); ahora es automático mientras el módulo declare
 * `tablas` correctamente en el registry (parte del Contrato de Módulo,
 * ver docs/adr/0002-contrato-de-modulo.md).
 *
 * SEGURIDAD: el JSON de un backup incluye usuarios.password_hash (bcrypt,
 * nunca en texto plano) — mismo nivel de sensibilidad que tenerlo en la
 * base. El storage (BACKUPS_DIR) tiene que estar tan protegido como la
 * base de datos misma; nunca se sirve por una ruta estática.
 */
import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { pool, withTenant } from "../config/database";
import { logger } from "../config/logger";
import { capturarError } from "../config/sentry";
import { AppError } from "../shared/middlewares/error.middleware";
import { MODULOS } from "../../modules/registry";
import type { TablaBackupMeta } from "../../modules/types";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";
import {
  guardarBackup,
  leerBackup,
  driverDeEscritura,
  type DriverStorage,
} from "./platformBackupStorage";
import { construirKeyTenant } from "./platformBackupS3";
import { verificarCuota, RECURSO_BACKUP_BYTES } from "./platformCuotas.service";

type MetaTabla = TablaBackupMeta;

// usuarios no es tabla de ningún módulo (es parte del núcleo de auth) —
// va primero porque checklists/ipercs la referencian por FK (usuario_id).
// El resto se concatena en el orden del registry; equipos antes de
// checklists antes de iperc ya queda garantizado por ese orden (ver
// registry.ts) — módulos independientes entre sí (repuestos, combustible,
// documentos) pueden ir en cualquier posición relativa.
const TABLAS_TENANT: MetaTabla[] = [
  { nombre: "usuarios", pk: "uuid" },
  ...MODULOS.flatMap((m) => m.tablas),
];

// Orden de DELETE al vaciar un tenant: el inverso del orden de "raíces"
// declarado por cada módulo (ver `raices` en ModuloDefinicion) — invertir
// un orden válido de INSERT (padres antes que hijos) siempre da un orden
// válido de DELETE (hijos antes que padres). usuarios se borra al final,
// por la misma razón que se inserta primero.
const RAICES_WIPE: string[] = [...MODULOS.flatMap((m) => m.raices)].reverse();

export interface ContenidoBackup {
  /** 1 = antes de las cuentas (0087). 2 = incluye `cuentas`. Un backup
   *  versión 1 se restaura igual: a sus perfiles con correo se les arma la
   *  cuenta desde la clave que guardaban ellos mismos. */
  version: 1 | 2;
  tenantId: string;
  tenantSlug: string;
  tenantNombre: string;
  creadoEn: string;
  tablas: Record<string, Record<string, unknown>[]>;
  /** Las cuentas (0087) de los perfiles de este tenant. No son de ninguna
   *  empresa --la misma persona puede trabajar en varias-- así que no entran
   *  en `tablas`, que es todo "filas con tenant_id". Van igual porque sin
   *  ellas un restore en otra base dejaría los perfiles apuntando a cuentas
   *  que no existen. */
  cuentas?: Record<string, unknown>[];
}

export interface TenantBackup {
  id: string;
  tenantId: string;
  archivo: string;
  /** Driver con el que se escribió ESTE backup — no el configurado hoy.
   *  Ver platformBackupStorage.ts sobre por qué son cosas distintas. */
  storage: DriverStorage;
  storageKey: string;
  tamanoBytes: number;
  tablas: Record<string, number>;
  estado: "completo" | "fallido";
  creadoEn: string;
}

/** `tamano_bytes` es BIGINT y node-pg devuelve los BIGINT como STRING (no
 *  como number), porque un int64 no siempre entra en un double de JS. Sin
 *  esta conversión el tipo de arriba miente: cualquier consumidor que
 *  sumara tamaños obtendría concatenación de strings ("100"+"200"="100200")
 *  y cualquier comparación estricta contra un number fallaría en silencio.
 *  Se detectó comparando el ContentLength real de S3 contra el valor
 *  guardado en la base: imprimían igual y `===` daba false.
 *
 *  Number() es seguro acá: pierde precisión recién por encima de 2^53
 *  bytes (9 PB), y un backup de un tenant no se acerca ni de lejos. */
function normalizarFilaBackup<T extends { tamanoBytes: unknown }>(
  fila: T
): T & { tamanoBytes: number } {
  return { ...fila, tamanoBytes: Number(fila.tamanoBytes) };
}

export async function exportarTenantService(
  tenantId: string,
  contexto: ContextoAuditoria
): Promise<TenantBackup> {
  const tenant = await pool.query(`SELECT id, nombre, slug FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  // Todo lo que pueda fallar de acá en adelante (leer la base, comprimir/
  // cifrar, hablar con S3) queda envuelto: un backup que falla en silencio
  // es peor que no tener backups, porque genera confianza infundada. Cada
  // fallo deja rastro en platform_audit_log con resultado 'failure' Y un
  // log estructurado de nivel ERROR — ver el catch.
  try {
    // La cuota se chequea ANTES de leer nada: exportar un tenant grande es
    // caro (arma el JSON entero en memoria) y no tiene sentido pagarlo para
    // después rechazar la subida. Se mide sobre los backups que EXISTEN, así
    // que la retención GFS libera espacio sola al podar los viejos.
    await verificarCuota(tenantId, RECURSO_BACKUP_BYTES);

    // withTenant() por las tablas con RLS (todas, salvo la propia
    // tenants) — una sola transacción de solo lectura para todo el export.
    const tablas: Record<string, Record<string, unknown>[]> = await withTenant(
      tenantId,
      async (client) => {
        const resultado: Record<string, Record<string, unknown>[]> = {};
        for (const { nombre } of TABLAS_TENANT) {
          const filas = await client.query(
            `SELECT * FROM ${nombre} WHERE tenant_id = $1 ORDER BY id`,
            [tenantId]
          );
          resultado[nombre] = filas.rows;
        }
        return resultado;
      }
    );

    // Las cuentas de los perfiles de este tenant. `usuarios` se lee bajo RLS
    // (de ahí el withTenant de arriba); `cuentas` no tiene RLS.
    const cuentas = await withTenant(tenantId, async (client) => {
      const filas = await client.query(
        `SELECT c.* FROM cuentas c
          WHERE c.id IN (
            SELECT u.cuenta_id FROM usuarios u
             WHERE u.tenant_id = $1 AND u.cuenta_id IS NOT NULL
          )
          ORDER BY c.id`,
        [tenantId]
      );
      return filas.rows;
    });

    const backup: ContenidoBackup = {
      version: 2,
      tenantId,
      tenantSlug: tenant.rows[0].slug,
      tenantNombre: tenant.rows[0].nombre,
      creadoEn: new Date().toISOString(),
      tablas,
      cuentas,
    };

    const resumenTablas = Object.fromEntries(
      Object.entries(tablas).map(([nombre, filas]) => [nombre, filas.length])
    );
    const contenidoSerializado = JSON.stringify(backup);
    const key = construirKeyTenant(tenantId);

    // `bytes` es el tamaño YA comprimido y cifrado (lo que realmente ocupa
    // en el bucket), no el del JSON original — es el número que importa
    // para costos y para detectar un backup sospechosamente chico.
    const { ubicacion, bytes } = await guardarBackup(key, contenidoSerializado, {
      tenant_id: tenantId,
      tenant_slug: tenant.rows[0].slug,
    });

    const registro = await pool.query(
      `INSERT INTO tenant_backups (tenant_id, archivo, storage, storage_key, tamano_bytes, tablas, estado)
       VALUES ($1, $2, $3, $4, $5, $6, 'completo')
       RETURNING id, tenant_id AS "tenantId", archivo, storage, storage_key AS "storageKey",
                 tamano_bytes AS "tamanoBytes", tablas, estado, creado_en AS "creadoEn"`,
      [tenantId, key, ubicacion.storage, key, bytes, JSON.stringify(resumenTablas)]
    );

    await registrarAuditoria({
      accion: "crear_backup_tenant",
      tenantId,
      detalle: {
        backupId: registro.rows[0].id,
        storage: ubicacion.storage,
        storageKey: key,
        tamanoBytes: bytes,
        tablas: resumenTablas,
      },
      contexto,
    });

    return normalizarFilaBackup(registro.rows[0]);
  } catch (err) {
    // Nivel ERROR, no warn: quedarse sin backup de un tenant es un
    // incidente operativo, tiene que despertar a alguien.
    logger.error(
      { err, tenantId, storage: driverDeEscritura() },
      "Falló la creación del backup de un tenant"
    );

    await registrarAuditoria({
      accion: "crear_backup_tenant",
      tenantId,
      detalle: {
        storage: driverDeEscritura(),
        error: err instanceof Error ? err.message : String(err),
      },
      contexto,
      resultado: "failure",
    });

    // Mismo criterio que Sentry.setupExpressErrorHandler (ver sentry.ts):
    // solo >= 500 es un incidente operativo. Un AppError de negocio (ej.
    // cuota de backups excedida, statusCode 403) no debe despertar a nadie
    // -- quedarse SIN backup por un fallo real de infra sí.
    if (!(err instanceof AppError) || err.statusCode >= 500) {
      capturarError(err, { tenantId, storage: driverDeEscritura(), accion: "crear_backup_tenant" });
    }

    // Un AppError ya trae el status correcto (503 si falta configuración de
    // cifrado, etc.) y se propaga tal cual; cualquier otra cosa se
    // normaliza a 500 sin filtrar el mensaje interno al cliente.
    if (err instanceof AppError) throw err;
    throw new AppError(500, "No se pudo crear el backup del tenant");
  }
}

export async function listarBackupsTenantService(tenantId: string): Promise<TenantBackup[]> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  const result = await pool.query(
    `SELECT id, tenant_id AS "tenantId", archivo, storage, storage_key AS "storageKey",
            tamano_bytes AS "tamanoBytes", tablas, estado, creado_en AS "creadoEn"
     FROM tenant_backups WHERE tenant_id = $1 ORDER BY creado_en DESC`,
    [tenantId]
  );
  return result.rows.map(normalizarFilaBackup);
}

/** Wipe en orden que respeta las FK — ver RAICES_WIPE. Se apoya en ON
 *  DELETE CASCADE de las tablas "hijas" de cada módulo (las que no
 *  aparecen en `raices`) igual que tests/helpers.ts. */
export async function vaciarDatosDeTenant(client: PoolClient, tenantId: string): Promise<void> {
  for (const tabla of RAICES_WIPE) {
    await client.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenantId]);
  }
  await client.query(`DELETE FROM usuarios WHERE tenant_id = $1`, [tenantId]);
}

/** La cuenta de un perfil que viene de un backup ANTERIOR a 0087.
 *
 *  Esos backups no tienen `cuentas` ni `usuarios.cuenta_id` --la columna no
 *  existía-- pero sí traen la clave en el propio perfil. Sin esto, restaurar
 *  uno dejaría a toda la gente de oficina de ese tenant sin poder entrar: el
 *  login busca la clave en la cuenta, y el perfil no tendría ninguna. Es la
 *  misma conversión que hizo la migración 0087, aplicada al restaurar.
 *
 *  Si esa persona ya tiene cuenta (trabaja en otra empresa), se usa la que ya
 *  existe y su clave actual manda -- la del backup es más vieja. */
async function cuentaParaPerfilSinCuenta(
  client: PoolClient,
  email: string,
  passwordHash: unknown,
  debeCambiarPassword: unknown
): Promise<string | null> {
  const creada = await client.query(
    `INSERT INTO cuentas (email, password_hash, debe_cambiar_password)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email.toLowerCase(), passwordHash ?? null, debeCambiarPassword ?? false]
  );
  if (creada.rows[0]) return creada.rows[0].id;

  const existente = await client.query(`SELECT id FROM cuentas WHERE email = $1`, [
    email.toLowerCase(),
  ]);
  return existente.rows[0]?.id ?? null;
}

/** Deja existir las cuentas del backup y devuelve el mapeo
 *  id-en-el-backup → id-en-ESTA-base.
 *
 *  Una cuenta que ya existe **no se toca**: la misma persona puede trabajar en
 *  otra empresa y haber cambiado su clave después del backup. Restaurar no
 *  puede pisarle la clave con la que entra a las demás. Por eso el
 *  `ON CONFLICT (email) DO NOTHING` y el SELECT posterior. */
async function restaurarCuentas(
  client: PoolClient,
  cuentas: Record<string, unknown>[]
): Promise<Map<string, string>> {
  const mapeo = new Map<string, string>();

  for (const cuenta of cuentas) {
    const email = String(cuenta.email);
    const creada = await client.query(
      `INSERT INTO cuentas (email, password_hash, debe_cambiar_password, activo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [
        email,
        cuenta.password_hash ?? null,
        cuenta.debe_cambiar_password ?? false,
        cuenta.activo ?? true,
      ]
    );
    const id =
      creada.rows[0]?.id ??
      (await client.query(`SELECT id FROM cuentas WHERE email = $1`, [email])).rows[0]?.id;
    if (id) mapeo.set(String(cuenta.id), id);
  }

  return mapeo;
}

/** `remapearIds` decide cómo se restauran los ids de cada fila:
 *
 *  - false (restaurar sobre el MISMO tenant que originó el backup): los
 *    ids se preservan tal cual — es seguro porque vaciarDatosDeTenant ya
 *    liberó esos mismos ids antes de insertar, y ningún otro tenant puede
 *    tener una fila con esos ids (son globalmente únicos por tabla). Hace
 *    falta un setval() manual después de cada tabla porque un INSERT con
 *    id explícito no avisa a la secuencia que ese valor ya está en uso —
 *    y ese setval() tiene que tomar el GREATEST contra el valor actual de
 *    la secuencia, no pisarlo a ciegas con MAX(id): ver el comentario en
 *    el propio setval(), más abajo.
 *
 *  - true (restaurar en un tenant DISTINTO — clonar): los ids originales
 *    siguen existiendo de verdad en el tenant de origen (no se tocó), así
 *    que reusarlos chocaría contra la PK. Se genera un id nuevo por fila
 *    (UUID nuevo, o dejar que SERIAL asigne el suyo) y se recuerda el
 *    mapeo viejo→nuevo por tabla, para reescribir cualquier FK de una
 *    fila posterior que apunte a esa fila (ver `fks` en TABLAS_TENANT). */
export async function restaurarTablas(
  client: PoolClient,
  backup: ContenidoBackup,
  targetTenantId: string,
  remapearIds: boolean
): Promise<Record<string, number>> {
  const tablasRestauradas: Record<string, number> = {};
  const remapPorTabla: Record<string, Map<unknown, unknown>> = {};

  // Los backups versión 1 (anteriores a 0087) no traen esta sección: sus
  // perfiles tampoco traen cuenta_id, y se les arma la cuenta desde la clave
  // que el propio perfil guardaba (ver cuentaParaPerfilSinCuenta).
  const remapCuentas = backup.cuentas ? await restaurarCuentas(client, backup.cuentas) : null;

  for (const meta of TABLAS_TENANT) {
    const filas = backup.tablas[meta.nombre] ?? [];

    // Tablas que apuntan a algo fuera de Postgres (storage_key → un objeto
    // en R2/disco): restaurarlas sobre el mismo tenant es correcto, pero
    // clonarlas le daría al tenant destino punteros a los archivos del
    // ORIGEN — ver `omitirAlClonar` en modules/types.ts. Se cuenta como 0
    // restauradas y no como "ausente del backup": el backup SÍ las trae,
    // este restore en particular decidió no escribirlas.
    if (remapearIds && meta.omitirAlClonar) {
      tablasRestauradas[meta.nombre] = 0;
      remapPorTabla[meta.nombre] = new Map();
      continue;
    }

    tablasRestauradas[meta.nombre] = filas.length;
    const remapDeEstaTabla = new Map<unknown, unknown>();
    remapPorTabla[meta.nombre] = remapDeEstaTabla;

    for (const filaOriginal of filas) {
      const fila: Record<string, unknown> = { ...filaOriginal, tenant_id: targetTenantId };

      if (meta.nombre === "usuarios") {
        if (fila.cuenta_id && remapCuentas) {
          fila.cuenta_id = remapCuentas.get(String(fila.cuenta_id)) ?? null;
        } else if (!fila.cuenta_id && fila.email) {
          // Perfil de un backup anterior a 0087. Su clave pasa a la cuenta, y
          // el perfil se queda sin clave propia, como todos los demás.
          fila.cuenta_id = await cuentaParaPerfilSinCuenta(
            client,
            String(fila.email),
            fila.password_hash,
            fila.debe_cambiar_password
          );
          if (fila.cuenta_id) fila.password_hash = null;
        }
      }
      for (const columna of meta.columnasExcluidasAlRestaurar ?? []) {
        delete fila[columna];
      }

      const idOriginal = fila.id;
      if (remapearIds) {
        if (meta.pk === "uuid") {
          fila.id = randomUUID();
        } else {
          delete fila.id; // deja que la secuencia SERIAL asigne uno propio
        }
      }

      for (const [columnaFK, tablaReferenciada] of Object.entries(meta.fks ?? {})) {
        const valorFK = fila[columnaFK];
        if (valorFK != null && remapearIds) {
          fila[columnaFK] = remapPorTabla[tablaReferenciada]?.get(valorFK) ?? valorFK;
        }
      }

      const columnas = Object.keys(fila);
      const placeholders = columnas.map((_, i) => `$${i + 1}`).join(", ");
      const necesitaIdGenerado = remapearIds && meta.pk === "serial";
      const result = await client.query(
        `INSERT INTO ${meta.nombre} (${columnas.join(", ")}) VALUES (${placeholders})${
          necesitaIdGenerado ? " RETURNING id" : ""
        }`,
        columnas.map((c) => fila[c])
      );

      if (remapearIds) {
        remapDeEstaTabla.set(idOriginal, necesitaIdGenerado ? result.rows[0].id : fila.id);
      }
    }

    if (!remapearIds && meta.pk === "serial" && filas.length > 0) {
      // GREATEST contra el valor ACTUAL de la secuencia, no un setval a
      // ciegas con MAX(id): esta tabla es GLOBAL (el id no es por tenant),
      // así que mientras este restore corre, otro tenant cualquiera puede
      // estar insertando filas nuevas por su cuenta y adelantando la
      // secuencia de verdad. Un setval(seq, MAX(id)) que ignore eso puede
      // RETROCEDER la secuencia por debajo de donde ya está — y el
      // próximo nextval() de CUALQUIER inserción (de cualquier tenant, en
      // cualquier tabla que comparta esta secuencia) choca contra una fila
      // que ese otro proceso ya insertó antes del retroceso. Se encontró
      // por un test intermitente en la suite completa (nunca aislado):
      // "duplicate key value violates unique constraint" en un INSERT
      // que ni siquiera tocaba este restore.
      await client.query(
        `SELECT setval(
           pg_get_serial_sequence('${meta.nombre}', 'id')::regclass,
           GREATEST(
             (SELECT MAX(id) FROM ${meta.nombre}),
             COALESCE(pg_sequence_last_value(pg_get_serial_sequence('${meta.nombre}', 'id')::regclass), 1)
           )
         )`
      );
    }
  }

  return tablasRestauradas;
}

/** Restaura un backup sobre `targetTenantId` — SIEMPRE vacía primero los
 *  datos actuales de ese tenant en las tablas de negocio (ver
 *  vaciarDatosDeTenant): es tanto "restaurar sobre un tenant vacío"
 *  (vaciar ahí no hace nada) como "punto de restauración" (vaciar
 *  reemplaza lo que había). Nunca parcial: todo corre en una sola
 *  transacción, si algo falla no queda un tenant a medio restaurar.
 *
 *  token_version de cada usuario restaurado se incrementa después de
 *  insertarlo (no se restaura el valor tal cual venía en el backup): un
 *  restore es, en los hechos, un rollback de estado — cualquier JWT
 *  emitido después del momento del backup tiene que dejar de servir. Sin
 *  este bump, restaurar un backup viejo podría revivir por accidente un
 *  token_version que coincide con el de un JWT que ya se creía revocado. */
export async function restaurarBackupService(
  backupId: string,
  targetTenantId: string,
  contexto: ContextoAuditoria
): Promise<{ tablasRestauradas: Record<string, number> }> {
  const backupRow = await pool.query(`SELECT * FROM tenant_backups WHERE id = $1`, [backupId]);
  if (backupRow.rows.length === 0) {
    throw new AppError(404, "Backup no encontrado");
  }

  const targetTenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [targetTenantId]);
  if (targetTenant.rows.length === 0) {
    throw new AppError(404, "Tenant destino no encontrado");
  }

  // storage/storage_key vienen de la fila, NO del entorno: un backup escrito
  // en disco antes de migrar a S3 se sigue leyendo de disco (y viceversa).
  // El `?? archivo` cubre cualquier fila anterior a la migración 0032 que
  // no hubiera pasado por el backfill.
  const ubicacion = {
    storage: (backupRow.rows[0].storage ?? "local") as DriverStorage,
    key: backupRow.rows[0].storage_key ?? backupRow.rows[0].archivo,
  };

  try {
    const crudo = await leerBackup(ubicacion);
    const backup = JSON.parse(crudo) as ContenidoBackup;
    const remapearIds = targetTenantId !== backup.tenantId;

    const tablasRestauradas = await withTenant(targetTenantId, async (client) => {
      await vaciarDatosDeTenant(client, targetTenantId);
      const resultado = await restaurarTablas(client, backup, targetTenantId, remapearIds);

      if (resultado.usuarios > 0) {
        await client.query(
          `UPDATE usuarios SET token_version = token_version + 1000 WHERE tenant_id = $1`,
          [targetTenantId]
        );
      }

      return resultado;
    });

    await registrarAuditoria({
      accion: "restaurar_backup_tenant",
      tenantId: targetTenantId,
      detalle: {
        backupId,
        backupTenantOriginal: backup.tenantId,
        storage: ubicacion.storage,
        storageKey: ubicacion.key,
        tablasRestauradas,
      },
      contexto,
    });

    return { tablasRestauradas };
  } catch (err) {
    // Un restore fallido es más grave que un backup fallido: pasa durante
    // un incidente, y si falló DESPUÉS del vaciado el tenant puede haber
    // quedado a medias. No es el caso —restaurarTablas corre dentro de la
    // transacción de withTenant(), así que un fallo ahí hace ROLLBACK
    // completo—, pero el registro tiene que permitir reconstruir qué pasó.
    logger.error(
      { err, backupId, targetTenantId, storage: ubicacion.storage, storageKey: ubicacion.key },
      "Falló la restauración de un backup de tenant"
    );

    await registrarAuditoria({
      accion: "restaurar_backup_tenant",
      tenantId: targetTenantId,
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
    throw new AppError(500, "No se pudo restaurar el backup");
  }
}
