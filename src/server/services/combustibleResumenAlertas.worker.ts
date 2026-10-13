/** src/server/services/combustibleResumenAlertas.worker.ts
 *
 * Entrega 2 de la Bandeja: UN correo por día y por persona, a las 7:00 de
 * Lima, con lo nuevo desde el resumen anterior y lo que sigue sin resolver.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────
 *
 * Hasta acá cada alerta mandaba su correo al instante. Con un equipo que
 * recién empieza a usar el ERP eso son decenas de correos al día, y a la
 * semana nadie los abre -- tampoco el que importa. Desde esta entrega solo lo
 * grave sale al momento (canalesAlertas.ts); el resto queda en la Bandeja y
 * este correo lo recuerda una vez al día. Lo que sigue abierto vuelve a
 * aparecer cada mañana, y lo que lleva más de 2 días sin resolver se marca
 * aparte: nada se queda olvidado en silencio.
 *
 * ── Qué ve cada uno ──────────────────────────────────────────────────────
 *
 * Lo mismo que en su Bandeja: los números salen de
 * CombustibleRepository.resumenDiarioPorTipo, que usa el MISMO WHERE de
 * alcance que la Bandeja (filtroAlertaVisible). Quien tiene un grifo recibe
 * las cuentas de su grifo; el admin, las de toda la empresa.
 *
 * ── Una sola vez por día ─────────────────────────────────────────────────
 *
 * El worker revisa cada 10 minutos y puede haber más de una instancia. El
 * lock por tenant evita trabajar dos veces a la vez, y la fila de
 * `combustible_resumen_alertas_envios` (0127) reclamada ANTES de mandar evita
 * repetir el día. Si el envío se cae a la mitad, ese día se pierde para
 * quien faltaba (queda en el log) en vez de duplicarse para todos: lo
 * perdido sigue en la Bandeja y vuelve mañana como "sin resolver".
 *
 * Mismo esquema de transacción que combustibleConciliacion.worker.ts (ver su
 * encabezado: RLS forzado, `set_config` dentro del client del lock), y los
 * correos salen FUERA de la transacción.
 */
import type { PoolClient } from "pg";
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { capturarError } from "../config/sentry";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";
import { enviarCorreoAlerta } from "../shared/utils/alertaMailer";
import { findDestinatariosAlertas } from "../shared/utils/destinatariosAlertas";
import { construirUrlTenant } from "./auth.service";
import { CombustibleRepository } from "../../modules/combustible/combustible.repository";
import { resolverAlcance } from "../../modules/combustible/alcance";
import { canalDeFila, nombreDeTipo } from "../../modules/combustible/canalesAlertas";

const repository = new CombustibleRepository();

/** Una alerta sin resolver por más de esto se marca aparte en el resumen. */
const HORAS_PARA_VENCIDA = 48;
/** Tipos que se listan en "sin resolver"; el resto se resume en una línea. */
const MAX_TIPOS_LISTADOS = 10;

interface CorreoDeResumen {
  destinatario: { email: string; nombre: string };
  asunto: string;
  titulo: string;
  lineas: string[];
}

/** Día y hora de Lima. Perú no tiene horario de verano, pero se calcula con
 *  la zona y no restando 5 horas: así no depende de la zona del servidor. */
export function diaYHoraEnLima(ahora: Date): { fecha: string; hora: number } {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ahora);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? "";
  return { fecha: `${p("year")}-${p("month")}-${p("day")}`, hora: Number(p("hour")) };
}

async function idsDeTenants(): Promise<string[]> {
  // `tenants` no tiene RLS (ALLOWLIST_SIN_RLS en rls-coverage.test.ts).
  const r = await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE activo = true`);
  return r.rows.map((f) => f.id);
}

async function urlDelTenant(tenantId: string): Promise<string> {
  const r = await pool.query<{ id: string; slug: string; dominioPersonalizado: string | null }>(
    `SELECT id, slug, dominio_personalizado AS "dominioPersonalizado" FROM tenants WHERE id = $1`,
    [tenantId]
  );
  return construirUrlTenant(r.rows[0]);
}

type FilaResumen = Awaited<ReturnType<CombustibleRepository["resumenDiarioPorTipo"]>>[number];

/** El texto del correo de UNA persona, o `null` si no hay nada que contarle.
 *  Exportada para probar el armado sin base. */
export function armarCorreoDeResumen(
  filas: FilaResumen[],
  fecha: string,
  urlErp: string
): Omit<CorreoDeResumen, "destinatario"> | null {
  // Las "solo en el ERP" no entran: son informativas, y contarlas cada día
  // convertiría el resumen en ruido (ver canalesAlertas.ts).
  const accionables = filas.filter((f) => canalDeFila(f.tipo) !== "solo_erp");
  const deResumen = accionables.filter((f) => canalDeFila(f.tipo) === "resumen");

  const nuevasPorRevisar = deResumen.filter((f) => f.nuevas > 0);
  const nuevasAlMomento = accionables
    .filter((f) => canalDeFila(f.tipo) === "al_momento")
    .reduce((s, f) => s + f.nuevas, 0);
  const pendientes = accionables.reduce((s, f) => s + f.pendientes, 0);
  const vencidas = accionables.filter((f) => f.vencidas > 0);

  const totalPorRevisar = nuevasPorRevisar.reduce((s, f) => s + f.nuevas, 0);
  if (totalPorRevisar === 0 && nuevasAlMomento === 0 && pendientes === 0) return null;

  const [a, m, d] = fecha.split("-");
  const lineas: string[] = [];

  if (totalPorRevisar > 0) {
    lineas.push(`Nuevas para revisar (no se avisaron por correo): ${totalPorRevisar}`);
    for (const f of nuevasPorRevisar) lineas.push(`• ${nombreDeTipo(f.tipo)}: ${f.nuevas}`);
  } else {
    lineas.push("No hubo alertas nuevas para revisar desde el resumen anterior.");
  }
  if (nuevasAlMomento > 0) {
    lineas.push(
      `Además hubo ${nuevasAlMomento} alerta(s) grave(s), que se avisaron por correo al momento. ` +
        "Si no las viste, están en la Bandeja."
    );
  }

  lineas.push(`Sin resolver en total: ${pendientes}`);
  // Por tipo: un control apagado (tanque sin medir, sin vigilancia) no genera
  // nada nuevo cada día, y sin este desglose solo se vería como un número.
  const abiertas = accionables
    .filter((f) => f.pendientes > 0)
    .sort((x, y) => y.pendientes - x.pendientes);
  for (const f of abiertas.slice(0, MAX_TIPOS_LISTADOS)) {
    lineas.push(`• ${nombreDeTipo(f.tipo)}: ${f.pendientes}`);
  }
  if (abiertas.length > MAX_TIPOS_LISTADOS) {
    lineas.push(`• y ${abiertas.length - MAX_TIPOS_LISTADOS} tipo(s) más, en la Bandeja`);
  }
  if (vencidas.length > 0) {
    const total = vencidas.reduce((s, f) => s + f.vencidas, 0);
    lineas.push(`Llevan más de ${HORAS_PARA_VENCIDA / 24} días sin resolver: ${total}`);
    for (const f of vencidas) lineas.push(`• ${nombreDeTipo(f.tipo)}: ${f.vencidas}`);
  }

  lineas.push(`Revísalas y ciérralas con motivo en la Bandeja del ERP: ${urlErp}`);

  return {
    asunto:
      `Combustible: resumen de alertas del ${d}/${m}/${a} -- ` +
      `${totalPorRevisar} nueva(s) para revisar, ${pendientes} sin resolver`,
    titulo: `Resumen de alertas de combustible del ${d}/${m}/${a}`,
    lineas,
  };
}

/** Todo lo de UN tenant, con `app.tenant_id` ya seteado en `client` y la
 *  transacción abierta. Devuelve los correos a mandar DESPUÉS del COMMIT. */
async function resumenDeTenant(
  client: PoolClient,
  tenantId: string,
  ahora: Date,
  fecha: string,
  urlErp: string
): Promise<CorreoDeResumen[]> {
  // Los destinatarios van ANTES de reclamar el día: si a las 7:00 nadie está
  // marcado y a las 9:00 alguien lo marca, el resumen de hoy tiene que poder
  // salir. Reclamarlo con la lista vacía quemaría el día para siempre.
  const destinatarios = await findDestinatariosAlertas(client, tenantId, "combustible");
  if (destinatarios.length === 0) return [];

  const reclamo = await repository.reclamarResumenDelDia(client, tenantId, fecha, ahora);
  if (!reclamo) return [];

  const roles = await client.query<{ id: string; rol: string }>(
    `SELECT id, rol FROM usuarios WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, destinatarios.map((d) => d.id)]
  );
  const rolDe = new Map(roles.rows.map((r) => [r.id, r.rol]));
  const cortes = {
    desde: reclamo.desde,
    hasta: ahora,
    vencidasAntesDe: new Date(ahora.getTime() - HORAS_PARA_VENCIDA * 3600 * 1000),
  };

  const correos: CorreoDeResumen[] = [];
  for (const d of destinatarios) {
    const alcance = await resolverAlcance(client, tenantId, {
      id: d.id,
      rol: rolDe.get(d.id) ?? "",
    });
    const filas = await repository.resumenDiarioPorTipo(client, tenantId, alcance, cortes);
    const correo = armarCorreoDeResumen(filas, fecha, urlErp);
    if (correo) correos.push({ destinatario: { email: d.email, nombre: d.nombre }, ...correo });
  }
  await repository.anotarDestinatariosDelResumen(client, tenantId, fecha, correos.length);
  return correos;
}

/** Uno por persona: cada uno tiene SUS números, no se pueden juntar en un
 *  solo correo con varios `to`. Nunca lanza (enviarCorreoAlerta tampoco). */
async function mandar(tenantId: string, correos: CorreoDeResumen[]): Promise<void> {
  for (const c of correos) {
    try {
      await enviarCorreoAlerta({
        destinatarios: [c.destinatario],
        asunto: c.asunto,
        titulo: c.titulo,
        lineas: c.lineas,
      });
    } catch (err) {
      logger.warn({ err, tenantId }, "No se pudo enviar el resumen diario de alertas");
    }
  }
}

/** Sin coordinación entre instancias: para tests y corridas manuales.
 *  `ahora` permite simular la hora; `soloTenantId` deja a cada archivo de
 *  test en su propio tenant (mismo motivo que en la conciliación). */
export async function correrResumenDiario(
  opciones: { ahora?: Date; soloTenantId?: string } = {}
): Promise<{ correos: number }> {
  const ahora = opciones.ahora ?? new Date();
  const { fecha, hora } = diaYHoraEnLima(ahora);
  if (hora < env.combustibleResumenHoraLima) return { correos: 0 };

  let total = 0;
  for (const tenantId of opciones.soloTenantId ? [opciones.soloTenantId] : await idsDeTenants()) {
    const urlErp = await urlDelTenant(tenantId);
    const client = await pool.connect();
    let correos: CorreoDeResumen[];
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      correos = await resumenDeTenant(client, tenantId, ahora, fecha, urlErp);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await mandar(tenantId, correos);
    total += correos.length;
  }
  return { correos: total };
}

/** La del worker: un lock por tenant, y un tenant que falla no corta a los
 *  demás (mismo criterio que la conciliación). */
export async function correrResumenDiarioCoordinado(
  opciones: { ahora?: Date; soloTenantId?: string } = {}
): Promise<{ correos: number }> {
  const ahora = opciones.ahora ?? new Date();
  const { fecha, hora } = diaYHoraEnLima(ahora);
  if (hora < env.combustibleResumenHoraLima) return { correos: 0 };

  let total = 0;
  for (const tenantId of opciones.soloTenantId ? [opciones.soloTenantId] : await idsDeTenants()) {
    try {
      const urlErp = await urlDelTenant(tenantId);
      const correos = await runSiPrimero(LOCK_IDS.combustibleResumenAlertas, async (client) => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        return resumenDeTenant(client, tenantId, ahora, fecha, urlErp);
      });
      // undefined = otra instancia tiene el lock; esa lo manda.
      if (correos === undefined || correos.length === 0) continue;
      await mandar(tenantId, correos);
      total += correos.length;
      logger.info(
        { tenantId, fecha, correos: correos.length },
        "Resumen diario de alertas enviado"
      );
    } catch (err) {
      logger.error({ err, tenantId }, "El resumen diario de alertas falló para un tenant");
      capturarError(err, { worker: "combustibleResumenAlertas", tenantId });
    }
  }
  return { correos: total };
}

setInterval(() => {
  correrResumenDiarioCoordinado().catch((err) => {
    logger.warn({ err }, "Error inesperado en el resumen diario de alertas");
    capturarError(err, { worker: "combustibleResumenAlertas" });
  });
}, env.combustibleResumenCheckIntervalMs).unref();
