/** src/modules/equipos/equipos.historial.ts
 *
 * El historial de conductor y de rutas de cada unidad (migración 0126).
 *
 * Todo corre DENTRO de la transacción del PUT/POST de Equipos (el `client`
 * viene de withTenant): el cambio del equipo y su rastro commitean o revierten
 * juntos. Si falta el motivo se lanza un AppError 400 y el UPDATE del equipo se
 * deshace también.
 *
 * Lo pasado no se reescribe: un cambio CIERRA la asignación vigente (hasta,
 * motivo_cierre, cerrado_por) y abre otra. Un trigger de la base lo impone.
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";

export interface ConductorAsignado {
  nombre?: string | null;
  dni?: string | null;
}

export interface RutaAsignada {
  origen_id: number;
  destino_id: number;
}

/** Motivo que se estampa solo cuando el equipo nace con conductor o rutas: no
 *  hay un "cambio" que justificar, pero la fila no puede quedar sin motivo. */
export const MOTIVO_ALTA = "Alta del equipo";

/** El instante del cambio, tomado DESPUÉS de bloquear la fila del equipo. No se
 *  usa now(): en Postgres es la hora de INICIO de la transacción, y si dos
 *  cambios se solapan, el segundo cerraría una asignación con una fecha
 *  anterior a su propio inicio (lo rechaza el CHECK hasta >= desde) y quedaría
 *  fuera de orden en el historial. */
async function instanteDelCambio(client: PoolClient): Promise<Date> {
  const r = await client.query<{ t: Date }>(`SELECT clock_timestamp() AS t`);
  return r.rows[0].t;
}

const vacioANull = (v?: string | null) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

const etiquetaConductor = (c: ConductorAsignado) =>
  c.nombre || c.dni
    ? `${c.nombre ?? "sin nombre"}${c.dni ? ` (DNI ${c.dni})` : ""}`
    : "sin conductor";

function exigirMotivo(motivo: string | undefined, que: string): string {
  const m = (motivo ?? "").trim();
  if (m === "") {
    throw new AppError(400, `Indicá el motivo del cambio de ${que}: queda en el historial`);
  }
  return m;
}

/** Pone el conductor vigente de la unidad. Devuelve el cambio (de/a) o null si
 *  no cambió nada. `esAlta` = el equipo se acaba de crear. */
export async function aplicarConductor(
  client: PoolClient,
  tenantId: string,
  equipoId: number,
  usuarioId: string,
  antes: ConductorAsignado,
  ahora: ConductorAsignado,
  motivo: string | undefined,
  esAlta: boolean
): Promise<{ de: string; a: string } | null> {
  const nuevo = { nombre: vacioANull(ahora.nombre), dni: vacioANull(ahora.dni) };
  const previo = { nombre: vacioANull(antes.nombre), dni: vacioANull(antes.dni) };
  if (nuevo.nombre === previo.nombre && nuevo.dni === previo.dni) return null;

  const motivoFinal = esAlta ? MOTIVO_ALTA : exigirMotivo(motivo, "conductor");

  // La fila vigente se bloquea: dos cambios a la vez no pueden dejar dos
  // vigentes (además lo impide el índice único parcial).
  const instante = await instanteDelCambio(client);
  await client.query(
    `UPDATE equipo_conductores
        SET hasta = $5, motivo_cierre = $3, cerrado_por = $4
      WHERE tenant_id = $1 AND equipo_id = $2 AND hasta IS NULL`,
    [tenantId, equipoId, motivoFinal, usuarioId, instante]
  );
  if (nuevo.nombre || nuevo.dni) {
    await client.query(
      `INSERT INTO equipo_conductores
         (tenant_id, equipo_id, conductor_nombre, conductor_dni, motivo, usuario_id, desde)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, equipoId, nuevo.nombre, nuevo.dni, motivoFinal, usuarioId, instante]
    );
  }
  return { de: etiquetaConductor(previo), a: etiquetaConductor(nuevo) };
}

/** Deja como vigentes EXACTAMENTE las rutas que llegan: cierra las que ya no
 *  están y abre las nuevas. Las que siguen no se tocan (conservan su desde).
 *  `rutas === undefined` = el cliente no habló de rutas: no se toca nada. */
export async function aplicarRutas(
  client: PoolClient,
  tenantId: string,
  equipoId: number,
  usuarioId: string,
  rutas: RutaAsignada[] | undefined,
  motivo: string | undefined,
  esAlta: boolean
): Promise<{ cerradas: string[]; abiertas: string[] } | null> {
  if (rutas === undefined) return null;

  const clave = (r: RutaAsignada) => `${r.origen_id}>${r.destino_id}`;
  const deseadas = new Map(rutas.map((r) => [clave(r), r]));

  const vigentes = await client.query<{ id: string; origen_id: string; destino_id: string }>(
    `SELECT id, origen_id, destino_id FROM equipo_rutas
      WHERE tenant_id = $1 AND equipo_id = $2 AND hasta IS NULL FOR UPDATE`,
    [tenantId, equipoId]
  );
  const vigentesPorClave = new Map(vigentes.rows.map((v) => [`${v.origen_id}>${v.destino_id}`, v]));

  const aCerrar = vigentes.rows.filter((v) => !deseadas.has(`${v.origen_id}>${v.destino_id}`));
  const aAbrir = [...deseadas.entries()]
    .filter(([k]) => !vigentesPorClave.has(k))
    .map(([, r]) => r);
  if (aCerrar.length === 0 && aAbrir.length === 0) return null;

  const motivoFinal = esAlta ? MOTIVO_ALTA : exigirMotivo(motivo, "rutas");

  // Un lugar dado de baja no se puede asignar a una ruta nueva.
  if (aAbrir.length > 0) {
    const ids = [...new Set(aAbrir.flatMap((r) => [r.origen_id, r.destino_id]))];
    const ok = await client.query<{ id: string }>(
      `SELECT id FROM combustible_lugares
        WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND activo`,
      [tenantId, ids]
    );
    if (ok.rows.length !== ids.length) {
      throw new AppError(400, "Algún lugar de la ruta no existe o está dado de baja");
    }
  }

  const instante = await instanteDelCambio(client);
  if (aCerrar.length > 0) {
    await client.query(
      `UPDATE equipo_rutas SET hasta = $5, motivo_cierre = $3, cerrado_por = $4
        WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
      [tenantId, aCerrar.map((v) => v.id), motivoFinal, usuarioId, instante]
    );
  }
  for (const r of aAbrir) {
    await client.query(
      `INSERT INTO equipo_rutas
         (tenant_id, equipo_id, origen_id, destino_id, motivo, usuario_id, desde)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, equipoId, r.origen_id, r.destino_id, motivoFinal, usuarioId, instante]
    );
  }

  const nombres = await client.query<{ id: string; nombre: string }>(
    `SELECT id, nombre FROM combustible_lugares WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
    [
      tenantId,
      [
        ...aCerrar.flatMap((v) => [v.origen_id, v.destino_id]),
        ...aAbrir.flatMap((r) => [r.origen_id, r.destino_id]),
      ],
    ]
  );
  const nombre = (id: string | number) =>
    nombres.rows.find((n) => String(n.id) === String(id))?.nombre ?? `#${id}`;
  return {
    cerradas: aCerrar.map((v) => `${nombre(v.origen_id)} → ${nombre(v.destino_id)}`),
    abiertas: aAbrir.map((r) => `${nombre(r.origen_id)} → ${nombre(r.destino_id)}`),
  };
}

/** Lugares activos, para el selector de ruta. Equipos los LEE del catálogo de
 *  Viajes; no hay un segundo catálogo. Vive acá (y no detrás del permiso de la
 *  pestaña Viajes) porque quien edita equipos puede no tener Viajes. */
export async function listarLugaresActivos(client: PoolClient, tenantId: string) {
  const r = await client.query(
    `SELECT id::int AS id, nombre FROM combustible_lugares
      WHERE tenant_id = $1 AND activo ORDER BY lower(nombre)`,
    [tenantId]
  );
  return r.rows;
}

/** El historial completo de una unidad, del más nuevo al más viejo. null si el
 *  equipo no existe en esta empresa. */
export async function listarHistorial(client: PoolClient, tenantId: string, equipoId: number) {
  const equipo = await client.query(`SELECT id FROM equipos WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    equipoId,
  ]);
  if (equipo.rows.length === 0) return null;

  const conductores = await client.query(
    `SELECT c.id, c.conductor_nombre, c.conductor_dni, c.desde, c.hasta,
            c.motivo, u.nombre AS usuario, c.motivo_cierre, uc.nombre AS cerrado_por
       FROM equipo_conductores c
       LEFT JOIN usuarios u  ON u.id  = c.usuario_id  AND u.tenant_id  = $1
       LEFT JOIN usuarios uc ON uc.id = c.cerrado_por AND uc.tenant_id = $1
      WHERE c.tenant_id = $1 AND c.equipo_id = $2
      ORDER BY c.desde DESC, c.id DESC`,
    [tenantId, equipoId]
  );
  const rutas = await client.query(
    `SELECT r.id, r.origen_id, lo.nombre AS origen, r.destino_id, ld.nombre AS destino,
            r.desde, r.hasta, r.motivo, u.nombre AS usuario,
            r.motivo_cierre, uc.nombre AS cerrado_por
       FROM equipo_rutas r
       JOIN combustible_lugares lo ON lo.id = r.origen_id  AND lo.tenant_id = $1
       JOIN combustible_lugares ld ON ld.id = r.destino_id AND ld.tenant_id = $1
       LEFT JOIN usuarios u  ON u.id  = r.usuario_id  AND u.tenant_id  = $1
       LEFT JOIN usuarios uc ON uc.id = r.cerrado_por AND uc.tenant_id = $1
      WHERE r.tenant_id = $1 AND r.equipo_id = $2
      ORDER BY r.desde DESC, r.id DESC`,
    [tenantId, equipoId]
  );
  return { conductores: conductores.rows, rutas: rutas.rows };
}
