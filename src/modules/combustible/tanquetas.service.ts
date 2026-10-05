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

/** Lo que entró a la tanqueta. Las salidas se suman acá cuando exista la carga
 *  en ruta. Solo cuentan las recepciones vigentes: anular una recepción
 *  devuelve el espacio. */
const SQL_ENTRADAS = `
  COALESCE((
    SELECT SUM(x.cantidad)
      FROM combustible_recepcion_excedentes x
      JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
     WHERE x.tenant_id = t.tenant_id AND x.tanqueta_id = t.id AND r.anulada_en IS NULL
  ), 0)`;

const COLUMNAS = `
  t.id, t.grifo_interno_id, t.codigo, t.capacidad, t.activa, t.motivo_baja, t.creado_en,
  ${SQL_ENTRADAS} AS entradas,
  ${SQL_ENTRADAS} AS saldo,
  t.capacidad - ${SQL_ENTRADAS} AS libre`;

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

/** Cada vez que se llenó: la línea de la recepción que la alimentó. */
export async function historialTanqueta(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT x.id, x.cantidad, x.creado_en, r.id AS recepcion_id, r.recibido_en,
            r.anulada_en, c.codigo AS tanque_codigo, c.tanque_nombre
       FROM combustible_recepcion_excedentes x
       JOIN combustible_recepciones r ON r.id = x.recepcion_id AND r.tenant_id = x.tenant_id
       JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
      WHERE x.tenant_id = $1 AND x.tanqueta_id = $2
      ORDER BY r.recibido_en DESC, x.id DESC`,
    [tenantId, id]
  );
  return r.rows;
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
