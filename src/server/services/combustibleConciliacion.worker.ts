/** src/server/services/combustibleConciliacion.worker.ts
 *
 * Cierra el ciclo del punto 4 de docs/architecture/control-de-combustible.md:
 * lo que pasó la ventana de gracia sin explicarse deja de ser un aviso vivo
 * y se congela como hallazgo permanente en `combustible_anomalias`
 * (migraciones 0071 y 0072).
 *
 * ── Por qué automático y no un botón ────────────────────────────────────
 *
 * Decidido explícitamente por Kenif: "la idea es que el ERP no acumule los
 * huecos porque no será escalable con el tiempo y todo será desordenado...
 * eso tienen que solucionar en el momento aunque haya plazo de 3 días".
 *
 * El aviso al momento ya existe (alertas por correo/campanita, migración
 * 0068) -- para eso está la ventana: dar tiempo a que se explique. Lo que
 * NO puede pasar es que, agotado ese tiempo, el hallazgo quede esperando
 * que alguien apriete un botón: ahí es donde se acumulan.
 *
 * ── Iterar tenants bajo RLS DENTRO del lock ─────────────────────────────
 *
 * Copiado de eventosTiempoRealRetention.worker.ts, que es el que ya resolvió
 * este caso: `combustible_alertas`, `combustible_anomalias` y
 * `combustible_config` tienen RLS FORZADO, así que un `pool.query` directo
 * acá no filtra de más ni de menos -- revienta con `invalid input syntax
 * for type uuid: ""`. Es la trampa documentada en la memoria del proyecto
 * (feedback_trampa_rls_withtenant), que ya se cometió una vez en ese
 * worker. Por eso `set_config('app.tenant_id', ...)` va DENTRO del mismo
 * client que sostiene el advisory lock: usar `withTenant()` acá abriría
 * una conexión distinta, y el trabajo quedaría fuera de la transacción que
 * protege el lock.
 *
 * Un lock POR TENANT y no uno para toda la corrida (mismo criterio que el
 * lock por lote de platformAuditRetention.worker.ts): el trabajo protegido
 * corre dentro de la transacción del lock, así que tomarlo una sola vez
 * para todos los tenants lo mantendría agarrado durante toda la pasada.
 */
import type { PoolClient } from "pg";
import { pool, withTenant } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";
import { capturarError } from "../config/sentry";
import { CombustibleService } from "../../modules/combustible/combustible.service";
import {
  enviarCorreoSinVigilancia,
  enviarCorreoAlertaSinMedir,
  enviarCorreoRecepcionSinValidar,
  enviarCorreoVarillaSinControl,
} from "../../modules/combustible/combustibleAlertas.mailer";
import { publicarEventoTenant } from "./realtimeEvents.service";

const service = new CombustibleService();

/** `tenants` no tiene RLS (ver ALLOWLIST_SIN_RLS en rls-coverage.test.ts) --
 *  pool.query directo es seguro acá. Mismo helper que el worker de
 *  retención de eventos. */
async function idsDeTenants(): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM tenants`);
  return result.rows.map((fila) => fila.id);
}

/** Uso directo, sin coordinación entre instancias -- para tests y una
 *  corrida manual. Mismo par que limpiarEventosTiempoRealViejos()/
 *  correrRetencionEventosCoordinada() en el worker de retención. */
export async function correrConciliacion(
  /** Limita la corrida a UN tenant. Existe para los tests, y no es un
   *  detalle: esta variante no toma advisory lock --el de producción sí, uno
   *  por tenant-- así que dos archivos de test que la corran a la vez se
   *  pisan sobre los MISMOS tenants. La deduplicación de alertas es un
   *  `NOT EXISTS`, no una restricción de base, y dos corridas simultáneas
   *  pueden pasar las dos por ese chequeo e insertar duplicados.
   *
   *  Eso hacía fallar de forma intermitente los tests de "no duplica la
   *  alerta aunque el worker corra varias veces" -- de a uno pasaban, juntos
   *  no. No era un bug de producción, pero sí ruido que se comía corridas
   *  enteras. Pasando el tenant propio, cada archivo se queda en su corral. */
  soloTenantId?: string
): Promise<{ congeladas: number }> {
  let total = 0;
  const fallas: FallaDeConciliacion[] = [];

  for (const tenantId of soloTenantId ? [soloTenantId] : await idsDeTenants()) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const resultado = await conciliarTenant(client, tenantId, fallas);
      await client.query("COMMIT");
      total += resultado.congeladas;
      await avisarResultado(tenantId, resultado);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      fallas.push({ tenantId, paso: "transaccion", error: err });
    } finally {
      client.release();
    }
  }

  // Esta variante la usan los tests y las corridas manuales: acá una falla
  // TIENE que hacerse ver. Pero recién al final, después de haber conciliado
  // todo lo demás -- el mismo criterio que la variante de producción, que
  // la reporta y sigue.
  if (fallas.length > 0) {
    const [primera] = fallas;
    throw new Error(
      `La conciliación terminó con ${fallas.length} falla(s); la primera, en el paso ` +
        `"${primera.paso}" del tenant ${primera.tenantId}: ${mensajeDe(primera.error)}`,
      { cause: primera.error }
    );
  }

  return { congeladas: total };
}

interface FallaDeConciliacion {
  tenantId: string;
  paso: string;
  error: unknown;
}

function mensajeDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ResultadoTenant = Awaited<ReturnType<typeof conciliarTenant>>;

/** Todo lo que la conciliación hace sobre UN tenant, con el client que ya
 *  trae `app.tenant_id` seteado y la transacción abierta.
 *
 *  ── Cada paso en su propio SAVEPOINT ─────────────────────────────────────
 *
 *  La 5ª auditoría encontró que UN paso que fallaba (congelar una alerta de
 *  un tipo que el CHECK de anomalías no aceptaba) deshacía la corrida entera
 *  del tenant: la alerta de "tanque sin medir" que se acababa de detectar
 *  desaparecía con el ROLLBACK. Y "dejar de medir" apaga los cuatro umbrales,
 *  así que una alerta sin revisar terminaba apagando toda la vigilancia.
 *
 *  Los pasos son independientes entre sí --detectar que no se mide no depende
 *  de poder congelar-- así que una falla en uno no puede llevarse puestos a
 *  los otros. Se reporta (log + Sentry, y la variante de tests la relanza al
 *  final) y la corrida sigue.
 *
 *  El orden importa: primero se crean las alertas, después se congela lo
 *  vencido. Al revés, una alerta recién detectada tendría que esperar a la
 *  corrida siguiente para poder congelarse. */
async function conciliarTenant(
  client: PoolClient,
  tenantId: string,
  fallas: FallaDeConciliacion[]
) {
  async function paso<T>(nombre: string, fn: () => Promise<T>, siFalla: T): Promise<T> {
    await client.query("SAVEPOINT paso_conciliacion");
    try {
      const r = await fn();
      await client.query("RELEASE SAVEPOINT paso_conciliacion");
      return r;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT paso_conciliacion");
      fallas.push({ tenantId, paso: nombre, error });
      logger.error({ err: error, tenantId, paso: nombre }, "Falla en un paso de la conciliación");
      capturarError(error, { worker: "combustibleConciliacion", tenantId, paso: nombre });
      return siFalla;
    }
  }

  await paso(
    "diferencias_de_recepcion",
    () => service.alertarDiferenciasDeRecepcion(client, tenantId),
    {
      creadas: 0,
    }
  );
  // Tanques que dejaron de medirse (migración 0076). Va en el worker y no
  // event-driven porque el hecho a detectar es que NO pasó nada, y un evento
  // que no ocurre no dispara ningún handler.
  const sinMedir = await paso(
    "tanques_sin_medir",
    () => service.evaluarTanquesSinMedir(client, tenantId),
    {
      alertas: [] as Awaited<ReturnType<CombustibleService["evaluarTanquesSinMedir"]>>["alertas"],
      dias: 0,
    }
  );
  const sinVigilancia = await paso(
    "tanques_sin_vigilancia",
    () => service.evaluarTanquesSinVigilancia(client, tenantId),
    {
      alertas: [] as Awaited<
        ReturnType<CombustibleService["evaluarTanquesSinVigilancia"]>
      >["alertas"],
      dias: 0,
    }
  );
  const vigilanciaExtra = await paso(
    "controles_de_la_quinta_auditoria",
    () => service.evaluarControlesPeriodicos(client, tenantId),
    {
      creadas: [] as Awaited<
        ReturnType<CombustibleService["evaluarControlesPeriodicos"]>
      >["creadas"],
    }
  );
  const congelado = await paso(
    "congelar_vencidas",
    () => service.congelarAlertasVencidas(client, tenantId),
    {
      congeladas: 0,
      ventanaHoras: 0,
      errores: [],
    }
  );
  for (const e of congelado.errores) {
    fallas.push({ tenantId, paso: `congelar_alerta_${e.tipo}_${e.alertaId}`, error: e.error });
    logger.error(
      { err: e.error, tenantId, alertaId: e.alertaId },
      "No se pudo congelar una alerta"
    );
    capturarError(e.error, { worker: "combustibleConciliacion", tenantId, alertaId: e.alertaId });
  }

  return { ...congelado, sinMedir, sinVigilancia, vigilanciaExtra };
}

/** Los avisos salen FUERA de la transacción: mandarlos adentro la dejaría
 *  abierta durante todo el SMTP, y un fallo del correo haría rollback de
 *  alertas que sí corresponde persistir. */
async function avisarResultado(tenantId: string, r: ResultadoTenant): Promise<void> {
  if (r.sinVigilancia.alertas.length > 0) {
    await avisarSinVigilancia(tenantId, r.sinVigilancia.alertas, r.sinVigilancia.dias);
  }
  if (r.sinMedir.alertas.length > 0) {
    await avisarSinMedir(tenantId, r.sinMedir.alertas, r.sinMedir.dias);
  }
  if (r.vigilanciaExtra.creadas.length > 0) {
    await avisarControlesPeriodicos(tenantId, r.vigilanciaExtra.creadas);
  }
}

/** Correo + evento de los dos controles que agregó la 5ª auditoría. Mismo
 *  contrato que los otros avisos: fuera de la transacción y nunca lanza. */
async function avisarControlesPeriodicos(
  tenantId: string,
  creadas: {
    tipo: "recepcion_sin_validar" | "varilla_sin_control";
    detalle: Record<string, unknown>;
  }[]
): Promise<void> {
  try {
    const admins = await withTenant(tenantId, (client) =>
      service.findAdminsConCombustibleHabilitado(client, tenantId)
    );
    for (const alerta of creadas) {
      const d = alerta.detalle;
      if (alerta.tipo === "recepcion_sin_validar") {
        await enviarCorreoRecepcionSinValidar(admins, {
          tanqueNombre: String(d.tanqueNombre ?? ""),
          numeroDocumento: (d.numeroDocumento as string | null) ?? null,
          registradaEn: String(d.registradaEn),
          plazoHoras: Number(d.plazoHoras),
        });
      } else {
        await enviarCorreoVarillaSinControl(admins, {
          tanqueNombre: String(d.tanqueNombre ?? ""),
          plazoDias: Number(d.plazoDias),
          ultimaVarillaDeControl: (d.ultimaVarillaDeControl as string | null) ?? null,
        });
      }
      await publicarEventoTenant(tenantId, "combustible.alerta_creada", { tipo: alerta.tipo });
    }
  } catch (err) {
    logger.warn({ err, tenantId }, "No se pudieron avisar los controles periódicos");
  }
}

/** Correo de los tanques que operan ciegos. Mismo contrato que
 *  avisarSinMedir(): fuera de la transacción, uno por tanque, y nunca lanza. */
async function avisarSinVigilancia(
  tenantId: string,
  tanques: {
    codigo: string;
    tanque_nombre: string;
    unidad: string;
    vales: string;
    litros: string;
  }[],
  plazoDias: number
): Promise<void> {
  try {
    const admins = await withTenant(tenantId, (client) =>
      service.findAdminsConCombustibleHabilitado(client, tenantId)
    );
    for (const t of tanques) {
      await enviarCorreoSinVigilancia(admins, {
        codigo: t.codigo,
        tanqueNombre: t.tanque_nombre,
        unidad: t.unidad,
        valesEnLaVentana: Number(t.vales),
        litrosEnLaVentana: Number(t.litros),
        plazoDias,
      });
      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "tanque_sin_vigilancia",
        codigo: t.codigo,
      });
    }
  } catch (err) {
    logger.warn({ err, tenantId }, "No se pudo avisar de los tanques sin vigilancia");
  }
}

/** Correo + evento de los tanques sin medir. Lo usan los DOS caminos (la
 *  corrida directa y la coordinada), y siempre FUERA de la transacción:
 *  mandarlo adentro la dejaría abierta durante todo el SMTP, y un fallo del
 *  correo haría rollback de alertas que sí corresponde persistir.
 *
 *  Un correo POR TANQUE y no uno con la lista: cada tanque sin medir es una
 *  acción concreta para alguien, y un correo que enumera cinco se lee como
 *  reporte en vez de como pedido.
 *
 *  Nunca lanza: las alertas ya están guardadas, y que falle el aviso no
 *  puede tumbar la corrida ni impedir que se congele lo vencido. */
async function avisarSinMedir(
  tenantId: string,
  tanques: { tanque_nombre: string; dias_sin_medir: string | null; ultima_lectura: Date | null }[],
  plazoDias: number
): Promise<void> {
  try {
    const admins = await withTenant(tenantId, (client) =>
      service.findAdminsConCombustibleHabilitado(client, tenantId)
    );
    for (const tanque of tanques) {
      await enviarCorreoAlertaSinMedir(admins, {
        tanqueNombre: tanque.tanque_nombre,
        diasSinMedir: tanque.dias_sin_medir === null ? null : Number(tanque.dias_sin_medir),
        ultimaLectura: tanque.ultima_lectura ? new Date(tanque.ultima_lectura).toISOString() : null,
        plazoDias,
      });
    }
    await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
      tipo: "tanque_sin_medir",
    });
  } catch (err) {
    logger.warn({ err, tenantId }, "No se pudo avisar de tanques sin medir");
  }
}

/** Uso del worker periódico: un lock por tenant -- ver el comentario del
 *  archivo.
 *
 *  Un tenant que falla NO corta el recorrido. Antes el error salía de
 *  `runSiPrimero` y abortaba el `for`: todos los tenants que venían después
 *  se quedaban sin conciliar, cada hora, mientras el problema del primero
 *  siguiera ahí. Un cliente con un dato raro no puede dejar ciego a otro. */
async function correrConciliacionCoordinada(): Promise<void> {
  let total = 0;
  let ultimaVentana = 0;

  for (const tenantId of await idsDeTenants()) {
    const fallas: FallaDeConciliacion[] = [];
    try {
      const resultado = await runSiPrimero(LOCK_IDS.combustibleConciliacion, async (client) => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        return conciliarTenant(client, tenantId, fallas);
      });
      // undefined = otra instancia tiene el lock; se salta este tenant, la
      // próxima corrida lo agarra.
      if (resultado === undefined) continue;
      total += resultado.congeladas;
      ultimaVentana = resultado.ventanaHoras;
      await avisarResultado(tenantId, resultado);
    } catch (err) {
      logger.error({ err, tenantId }, "La conciliación de combustible falló para un tenant");
      capturarError(err, { worker: "combustibleConciliacion", tenantId });
    }
  }

  // Una corrida sin nada que congelar es lo NORMAL (todas las alertas se
  // resolvieron dentro de su ventana) -- loguearlo cada hora sería ruido.
  if (total > 0) {
    logger.info(
      { anomaliasCongeladas: total, ventanaHoras: ultimaVentana },
      "Conciliación de combustible: alertas sin explicación congeladas como anomalías"
    );
  }
}

setInterval(() => {
  correrConciliacionCoordinada().catch((err) => {
    logger.warn({ err }, "Error inesperado en la conciliación de combustible");
    capturarError(err, { worker: "combustibleConciliacion" });
  });
}, env.combustibleConciliacionCheckIntervalMs).unref();
