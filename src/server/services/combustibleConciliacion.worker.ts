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
import { pool, withTenant } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";
import { capturarError } from "../config/sentry";
import { CombustibleService } from "../../modules/combustible/combustible.service";
import {
  enviarCorreoSinVigilancia,
  enviarCorreoAlertaSinMedir,
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
  // Se juntan y salen después del COMMIT -- ver avisarSinMedir().
  const avisosSinMedir: {
    tenantId: string;
    alertas: {
      tanque_nombre: string;
      dias_sin_medir: string | null;
      ultima_lectura: Date | null;
    }[];
    dias: number;
  }[] = [];
  // Tanques que despachan con los tres umbrales apagados (0082). Mismo
  // criterio que los de arriba: se juntan y salen después del COMMIT.
  const avisosSinVigilancia: {
    tenantId: string;
    alertas: {
      codigo: string;
      tanque_nombre: string;
      unidad: string;
      vales: string;
      litros: string;
    }[];
    dias: number;
  }[] = [];

  for (const tenantId of soloTenantId ? [soloTenantId] : await idsDeTenants()) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      // El orden importa: primero se crean las alertas, después se congela
      // lo vencido. Al revés, una alerta recién detectada tendría que
      // esperar a la corrida siguiente para poder congelarse.
      await service.alertarDiferenciasDeRecepcion(client, tenantId);
      // Tanques que dejaron de medirse (migración 0076). Va en el worker y
      // no event-driven porque el hecho a detectar es que NO pasó nada, y un
      // evento que no ocurre no dispara ningún handler. Se avisa por correo
      // fuera de la transacción, junto con el resto.
      const sinMedir = await service.evaluarTanquesSinMedir(client, tenantId);
      const sinVigilancia = await service.evaluarTanquesSinVigilancia(client, tenantId);
      const { congeladas } = await service.congelarAlertasVencidas(client, tenantId);
      if (sinMedir.alertas.length > 0) {
        avisosSinMedir.push({ tenantId, ...sinMedir });
      }
      if (sinVigilancia.alertas.length > 0) {
        avisosSinVigilancia.push({ tenantId, ...sinVigilancia });
      }
      await client.query("COMMIT");
      total += congeladas;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  for (const aviso of avisosSinMedir) {
    await avisarSinMedir(aviso.tenantId, aviso.alertas, aviso.dias);
  }
  for (const aviso of avisosSinVigilancia) {
    await avisarSinVigilancia(aviso.tenantId, aviso.alertas, aviso.dias);
  }

  return { congeladas: total };
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
 *  archivo. */
async function correrConciliacionCoordinada(): Promise<void> {
  let total = 0;
  let ultimaVentana = 0;

  for (const tenantId of await idsDeTenants()) {
    const resultado = await runSiPrimero(LOCK_IDS.combustibleConciliacion, async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await service.alertarDiferenciasDeRecepcion(client, tenantId);
      // Va también acá y no solo en correrConciliacion(): ESTE es el camino
      // que corre en producción cada hora. Engancharlo solo en el otro
      // dejaría la detección viva únicamente en los tests -- que es
      // exactamente la clase de hueco que esta entrega vino a cerrar.
      const sinMedir = await service.evaluarTanquesSinMedir(client, tenantId);
      const sinVigilancia = await service.evaluarTanquesSinVigilancia(client, tenantId);
      const congelado = await service.congelarAlertasVencidas(client, tenantId);
      return { ...congelado, sinMedir, sinVigilancia };
    });
    // undefined = otra instancia tiene el lock; se salta este tenant, la
    // próxima corrida lo agarra.
    if (resultado === undefined) continue;
    total += resultado.congeladas;
    ultimaVentana = resultado.ventanaHoras;
    if (resultado.sinVigilancia.alertas.length > 0) {
      await avisarSinVigilancia(
        tenantId,
        resultado.sinVigilancia.alertas,
        resultado.sinVigilancia.dias
      );
    }
    if (resultado.sinMedir.alertas.length > 0) {
      await avisarSinMedir(tenantId, resultado.sinMedir.alertas, resultado.sinMedir.dias);
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
