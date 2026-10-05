/** src/modules/combustible/tanquetas.service.ts
 *
 * Tanquetas / cubetas (migración 0111): depósitos chicos (280 gal) sin varilla
 * ni medidor, con código propio. Alojan el excedente de una recepción que no
 * cabe en el tanque y sirven de previsión en ruta.
 *
 * El SALDO SE DERIVA: entradas (líneas de excedente de recepciones no
 * anuladas) menos salidas (la carga en ruta, entrega siguiente). No hay
 * columna de saldo que pueda divergir del historial.
 *
 * Pertenece a un grifo interno (la sede donde se llena): solo recibe el
 * excedente de los tanques de SU grifo.
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { esViolacionUnicidad } from "../../server/shared/utils/pgError";
import { motivoGrifoNoAsignable } from "../../server/services/sedes.service";
import { ALCANCE_TODO, type AlcanceCombustible } from "./alcance";

export const CAPACIDAD_TANQUETA_DEFECTO = 280;

/** Lo que entró a la tanqueta: el excedente de recepciones vigentes (0111) y
 *  los vales del tanque a "reserva en cubeta" que la eligieron (0114). Anular
 *  una recepción o un vale devuelve el espacio. */
const SQL_ENTRADAS = `
  (COALESCE((
    SELECT SUM(x.cantidad)
      FROM combustible_recepcion_excedentes x
      JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
     WHERE x.tenant_id = t.tenant_id AND x.tanqueta_id = t.id AND r.anulada_en IS NULL
  ), 0) + COALESCE((
    SELECT SUM(d.cantidad) FROM combustible_despachos d
     WHERE d.tenant_id = t.tenant_id AND d.tanqueta_destino_id = t.id AND d.anulada_en IS NULL
  ), 0))`;

/** Lo que entró por cada camino, para que el panel muestre de dónde vino. */
const SQL_ENTRADAS_EXCEDENTE = `
  COALESCE((
    SELECT SUM(x.cantidad)
      FROM combustible_recepcion_excedentes x
      JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
     WHERE x.tenant_id = t.tenant_id AND x.tanqueta_id = t.id AND r.anulada_en IS NULL
  ), 0)`;
const SQL_ENTRADAS_PREVISION = `
  COALESCE((
    SELECT SUM(d.cantidad) FROM combustible_despachos d
     WHERE d.tenant_id = t.tenant_id AND d.tanqueta_destino_id = t.id AND d.anulada_en IS NULL
  ), 0)`;

/** Lo que salió: las cargas desde la tanqueta, en ruta o en planta (0114/0115). */
const SQL_SALIDAS = `
  COALESCE((
    SELECT SUM(d.cantidad) FROM combustible_despachos d
     WHERE d.tenant_id = t.tenant_id AND d.tanqueta_origen_id = t.id AND d.anulada_en IS NULL
  ), 0)`;

const COLUMNAS = `
  t.id, t.grifo_interno_id, t.codigo, t.capacidad, t.activa, t.motivo_baja, t.creado_en,
  ${SQL_ENTRADAS} AS entradas,
  ${SQL_ENTRADAS_EXCEDENTE} AS entradas_excedente,
  ${SQL_ENTRADAS_PREVISION} AS entradas_prevision,
  ${SQL_SALIDAS} AS salidas,
  ${SQL_ENTRADAS} - ${SQL_SALIDAS} AS saldo,
  t.capacidad - (${SQL_ENTRADAS} - ${SQL_SALIDAS}) AS libre`;

export async function listarTanquetas(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible = ALCANCE_TODO,
  filtros: { grifoInternoId?: number; soloActivas?: boolean } = {}
) {
  const valores: unknown[] = [tenantId];
  const condiciones = ["t.tenant_id = $1"];
  if (!alcance.todo) {
    valores.push(alcance.grifos);
    condiciones.push(`t.grifo_interno_id = ANY($${valores.length}::int[])`);
  }
  if (filtros.grifoInternoId !== undefined) {
    valores.push(filtros.grifoInternoId);
    condiciones.push(`t.grifo_interno_id = $${valores.length}`);
  }
  if (filtros.soloActivas) condiciones.push("t.activa");
  const r = await client.query(
    `SELECT ${COLUMNAS}, g.nombre AS grifo_nombre
       FROM combustible_tanquetas t
       JOIN grifos_internos g ON g.id = t.grifo_interno_id AND g.tenant_id = t.tenant_id
      WHERE ${condiciones.join(" AND ")}
      ORDER BY t.activa DESC, lower(t.codigo)`,
    valores
  );
  return r.rows;
}

export async function getTanqueta(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT ${COLUMNAS} FROM combustible_tanquetas t WHERE t.tenant_id = $1 AND t.id = $2`,
    [tenantId, id]
  );
  return r.rows[0] ?? null;
}

/** El siguiente código libre "TQT-001". Mira solo los que ya siguen el
 *  patrón: un código a mano ("CUBETA ROJA") no lo altera. */
async function siguienteCodigo(client: PoolClient, tenantId: string): Promise<string> {
  const r = await client.query<{ n: number }>(
    `SELECT COALESCE(MAX(substring(codigo from '^TQT-(\\d+)$')::int), 0) + 1 AS n
       FROM combustible_tanquetas
      WHERE tenant_id = $1 AND codigo ~ '^TQT-\\d+$'`,
    [tenantId]
  );
  return `TQT-${String(r.rows[0].n).padStart(3, "0")}`;
}

export async function crearTanqueta(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: { grifo_interno_id: number; codigo?: string; capacidad: number }
) {
  const noAsignable = await motivoGrifoNoAsignable(client, tenantId, data.grifo_interno_id);
  if (noAsignable) throw new AppError(400, noAsignable);
  const codigo = data.codigo ?? (await siguienteCodigo(client, tenantId));
  try {
    const r = await client.query<{ id: string }>(
      `INSERT INTO combustible_tanquetas (tenant_id, grifo_interno_id, codigo, capacidad, creado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, data.grifo_interno_id, codigo, data.capacidad, usuarioId]
    );
    return (await getTanqueta(client, tenantId, Number(r.rows[0].id)))!;
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(409, `Ya existe una tanqueta con el código ${codigo}`);
    }
    throw err;
  }
}

export async function actualizarTanqueta(
  client: PoolClient,
  tenantId: string,
  id: number,
  data: { codigo?: string; capacidad?: number; activa?: boolean; motivo?: string }
) {
  const actual = await getTanqueta(client, tenantId, id);
  if (!actual) return null;
  const saldo = Number(actual.saldo);
  if (data.capacidad !== undefined && data.capacidad < saldo) {
    throw new AppError(
      400,
      `La tanqueta tiene ${saldo} gal de saldo: su capacidad no puede ser menor (${data.capacidad})`
    );
  }
  const baja = data.activa === false && actual.activa;
  if (baja && saldo > 0) {
    throw new AppError(
      400,
      `La tanqueta tiene ${saldo} gal de saldo: no se puede dar de baja hasta vaciarla`
    );
  }
  if (baja && !data.motivo) throw new AppError(400, "Dar de baja una tanqueta pide un motivo");
  try {
    await client.query(
      `UPDATE combustible_tanquetas
          SET codigo = COALESCE($3, codigo),
              capacidad = COALESCE($4, capacidad),
              activa = COALESCE($5, activa),
              motivo_baja = CASE WHEN $5 IS TRUE THEN NULL ELSE COALESCE($6, motivo_baja) END
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        id,
        data.codigo ?? null,
        data.capacidad ?? null,
        data.activa ?? null,
        data.motivo ?? null,
      ]
    );
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(409, `Ya existe una tanqueta con el código ${data.codigo}`);
    }
    throw err;
  }
  return getTanqueta(client, tenantId, id);
}

/** Todo lo que entró y salió de la tanqueta, del más reciente al más viejo:
 *  excedentes de recepción, previsión desde el tanque y cargas en ruta. */
export async function historialTanqueta(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT * FROM (
       SELECT 'excedente' AS tipo, x.id::text AS id, x.cantidad, r.recibido_en AS fecha,
              r.anulada_en, c.codigo AS tanque_codigo, r.id AS recepcion_id,
              NULL::text AS equipo, NULL::numeric AS lectura_horometro,
              NULL::numeric AS lectura_odometro, NULL::text AS serie_talonario,
              NULL::int AS n_vale, u.nombre AS usuario
         FROM combustible_recepcion_excedentes x
         JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
         JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
         LEFT JOIN usuarios u ON u.id = x.decidido_por
        WHERE x.tenant_id = $1 AND x.tanqueta_id = $2
       UNION ALL
       SELECT 'prevision', d.id::text, d.cantidad, d.despachado_en, d.anulada_en,
              c.codigo, NULL, NULL, NULL, NULL, d.serie_talonario, d.n_vale, u.nombre
         FROM combustible_despachos d
         JOIN combustible c ON c.id = d.combustible_id AND c.tenant_id = d.tenant_id
         LEFT JOIN usuarios u ON u.id = d.usuario_id
        WHERE d.tenant_id = $1 AND d.tanqueta_destino_id = $2
       UNION ALL
       SELECT 'carga_' || d.tanqueta_lugar, d.id::text, d.cantidad, d.despachado_en,
              d.anulada_en, NULL, NULL, e.placa_codigo, d.lectura_horometro,
              d.lectura_odometro, d.serie_talonario, d.n_vale, u.nombre
         FROM combustible_despachos d
         LEFT JOIN equipos e ON e.id = d.equipo_id AND e.tenant_id = d.tenant_id
         LEFT JOIN usuarios u ON u.id = d.usuario_id
        WHERE d.tenant_id = $1 AND d.tanqueta_origen_id = $2
     ) m
     ORDER BY fecha DESC, id DESC`,
    [tenantId, id]
  );
  return r.rows;
}

/** El costo de un galón de la tanqueta: el promedio ponderado de lo que
 *  entró (la factura del excedente, o el costo del vale a reserva). Es el
 *  costo de la carga en ruta: el conductor no lo conoce ni lo tipea. 0 si
 *  todavía no entró nada con costo. */
export async function costoPromedioTanqueta(
  client: PoolClient,
  tenantId: string,
  id: number
): Promise<number> {
  const r = await client.query<{ costo: string | null }>(
    `SELECT SUM(cantidad * costo) / NULLIF(SUM(cantidad), 0) AS costo FROM (
       SELECT x.cantidad, r.costo_unitario AS costo
         FROM combustible_recepcion_excedentes x
         JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
        WHERE x.tenant_id = $1 AND x.tanqueta_id = $2 AND r.anulada_en IS NULL
       UNION ALL
       SELECT d.cantidad, d.costo_unitario
         FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.tanqueta_destino_id = $2 AND d.anulada_en IS NULL
     ) e`,
    [tenantId, id]
  );
  return r.rows[0].costo === null ? 0 : Number(Number(r.rows[0].costo).toFixed(4));
}

/** Para los formularios del vale (0114): las tanquetas activas del alcance,
 *  con su saldo y espacio. Lo lee quien registra despachos, que no siempre
 *  tiene el panel de Tanquetas. */
export async function tanquetasParaFormulario(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible
) {
  const todas = await listarTanquetas(client, tenantId, alcance, { soloActivas: true });
  const resultado = [];
  for (const t of todas) {
    resultado.push({
      id: Number(t.id),
      codigo: t.codigo as string,
      grifo_interno_id: Number(t.grifo_interno_id),
      capacidad: Number(t.capacidad),
      saldo: Number(t.saldo),
      libre: Number(t.libre),
      // El C.U de una carga desde esta tanqueta: el mismo que fija el
      // servidor al guardarla (0115). El formulario lo muestra, no lo edita.
      costo_promedio: await costoPromedioTanqueta(client, tenantId, Number(t.id)),
    });
  }
  return resultado;
}

/** El vale del tanque a "reserva en cubeta" que llena una tanqueta (0114):
 *  activa, de la sede del tanque y con espacio. Bloquea la tanqueta para que
 *  dos vales simultáneos no la llenen de más. Lanza Error con "la tanqueta"
 *  en el mensaje (el controller lo traduce a 400). */
export async function validarLlenadoDeTanqueta(
  client: PoolClient,
  tenantId: string,
  tanquetaId: number,
  grifoDelTanque: number,
  cantidad: number
) {
  await client.query(
    `SELECT id FROM combustible_tanquetas WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, tanquetaId]
  );
  const t = await getTanqueta(client, tenantId, tanquetaId);
  if (!t) throw new Error("la tanqueta elegida no existe en este tenant");
  if (!t.activa) throw new Error(`la tanqueta ${t.codigo} está dada de baja`);
  if (Number(t.grifo_interno_id) !== grifoDelTanque) {
    throw new Error(
      `la tanqueta ${t.codigo} es de otra sede: solo se llena desde los tanques de su grifo`
    );
  }
  if (cantidad > Number(t.libre) + 0.001) {
    throw new Error(
      `la tanqueta ${t.codigo} solo tiene ${Number(t.libre)} gal libres (capacidad ${Number(t.capacidad)}): no entran ${cantidad}`
    );
  }
}

/** Las tanquetas activas de un grifo con su espacio libre, para proponer el
 *  reparto del excedente (de la más vacía a la más llena no: se llena primero
 *  la que ya tiene combustible, para no abrir una tanqueta nueva de más). */
export async function tanquetasLibresDelGrifo(
  client: PoolClient,
  tenantId: string,
  grifoInternoId: number
) {
  const todas = await listarTanquetas(client, tenantId, ALCANCE_TODO, {
    grifoInternoId,
    soloActivas: true,
  });
  return todas
    .map((t) => ({
      id: Number(t.id),
      codigo: t.codigo as string,
      capacidad: Number(t.capacidad),
      saldo: Number(t.saldo),
      libre: Number(t.libre),
    }))
    .filter((t) => t.libre > 0)
    .sort((a, b) => b.saldo - a.saldo || a.codigo.localeCompare(b.codigo));
}

/** Valida las líneas del reparto que van a una tanqueta: que exista, esté
 *  activa, sea del grifo del tanque y que lo que se le suma (todas las líneas
 *  que apunten a ella) quepa en su espacio libre. Lanza Error con un mensaje
 *  que contiene "el reparto del excedente" (el controller lo traduce a 400). */
export async function validarLineasATanquetas(
  client: PoolClient,
  tenantId: string,
  grifoInternoId: number,
  lineas: { destino: string; cantidad: number; tanqueta_id?: number }[]
) {
  const porTanqueta = new Map<number, number>();
  for (const l of lineas) {
    if (l.destino !== "cubeta" || l.tanqueta_id === undefined) continue;
    porTanqueta.set(l.tanqueta_id, (porTanqueta.get(l.tanqueta_id) ?? 0) + l.cantidad);
  }
  for (const [id, suma] of porTanqueta) {
    const t = await getTanqueta(client, tenantId, id);
    if (!t) throw new Error("el reparto del excedente nombra una tanqueta que no existe");
    if (!t.activa)
      throw new Error(`el reparto del excedente usa la tanqueta ${t.codigo}, dada de baja`);
    if (Number(t.grifo_interno_id) !== grifoInternoId) {
      throw new Error(
        `el reparto del excedente usa la tanqueta ${t.codigo}, que es de otra sede: solo se llenan las del grifo del tanque`
      );
    }
    if (suma > Number(t.libre) + 0.001) {
      throw new Error(
        `el reparto del excedente le pone ${suma} gal a la tanqueta ${t.codigo}, que solo tiene ${Number(t.libre)} gal libres (capacidad ${Number(t.capacidad)})`
      );
    }
  }
}
