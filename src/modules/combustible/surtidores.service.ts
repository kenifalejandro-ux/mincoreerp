/** src/modules/combustible/surtidores.service.ts
 *
 * Surtidores (migración 0098, entrega 2 de
 * docs/architecture/combustible-sedes-grifos-surtidores.md): el aparato del
 * grifo interno por el que sale el combustible, con su propio totalizador.
 *
 * Vive aparte de combustible.service.ts porque es una entidad nueva con su
 * propio ciclo de vida (alta, conexiones, baja), no parte del vale ni de la
 * varilla. Las reglas duras las pone la base (0098): un surtidor y sus
 * tanques en el mismo grifo, una sola conexión vigente por par, y el vale
 * validado contra la conexión de su fecha. Acá se traducen a errores que se
 * entienden.
 *
 * Nada se borra: la baja es lógica, la desconexión deja la fila con su fecha
 * y su motivo.
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { esViolacionUnicidad } from "../../server/shared/utils/pgError";
import { motivoGrifoNoAsignable } from "../../server/services/sedes.service";
import { ALCANCE_TODO, type AlcanceCombustible } from "./alcance";

/** Un error de un trigger de la base (check_violation) es un dato que se
 *  contradice, no una falla: 400 con el mensaje del trigger. */
function traducirErrorDeBase(err: unknown): never {
  const codigo = (err as { code?: string }).code;
  if (codigo === "23514" && err instanceof Error) throw new AppError(400, err.message);
  throw err;
}

export async function listarSurtidores(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible = ALCANCE_TODO
) {
  // Solo los surtidores del alcance (0100): de sus grifos o asignados sueltos.
  const f = alcance.todo
    ? { sql: "TRUE", valores: [] as unknown[] }
    : {
        sql: "(s.grifo_interno_id = ANY($2::int[]) OR s.id = ANY($3::int[]))",
        valores: [alcance.grifos, alcance.surtidores],
      };
  const r = await client.query(
    `SELECT s.id, s.grifo_interno_id, s.nombre, s.activo, s.motivo_baja,
            s.usa_totalizador, s.totalizador_tolerancia, s.totalizador_actual,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                       'conexion_id', st.id,
                       'combustible_id', c.id,
                       'codigo', c.codigo,
                       'tanque_nombre', c.tanque_nombre,
                       'conectado_en', st.conectado_en
                     ) ORDER BY c.codigo)
                FROM surtidor_tanques st
                JOIN combustible c ON c.id = st.combustible_id AND c.tenant_id = $1
               WHERE st.surtidor_id = s.id AND st.desconectado_en IS NULL
            ), '[]'::jsonb) AS tanques
       FROM surtidores s
      WHERE s.tenant_id = $1 AND ${f.sql}
      ORDER BY s.activo DESC, lower(s.nombre)`,
    [tenantId, ...f.valores]
  );
  return r.rows;
}

export async function crearSurtidor(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: {
    grifo_interno_id: number;
    nombre: string;
    usa_totalizador: boolean;
    totalizador_tolerancia: number;
  }
) {
  const noAsignable = await motivoGrifoNoAsignable(client, tenantId, data.grifo_interno_id);
  if (noAsignable) throw new AppError(400, noAsignable);
  try {
    const r = await client.query<{ id: number }>(
      `INSERT INTO surtidores
         (tenant_id, grifo_interno_id, nombre, usa_totalizador, totalizador_tolerancia, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenantId,
        data.grifo_interno_id,
        data.nombre,
        data.usa_totalizador,
        data.totalizador_tolerancia,
        usuarioId,
      ]
    );
    return r.rows[0];
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(409, "Ya existe un surtidor con ese nombre en ese grifo");
    }
    throw err;
  }
}

/** Devuelve cómo estaba y cómo quedó, para que el controller decida si el
 *  cambio afloja la vigilancia (apagar el totalizador). Null si no existe. */
export async function actualizarSurtidor(
  client: PoolClient,
  tenantId: string,
  id: number,
  data: { nombre?: string; usa_totalizador?: boolean; totalizador_tolerancia?: number }
) {
  const antes = await client.query<{
    nombre: string;
    usa_totalizador: boolean;
    totalizador_tolerancia: string;
  }>(
    `SELECT nombre, usa_totalizador, totalizador_tolerancia FROM surtidores
      WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [id, tenantId]
  );
  if (antes.rows.length === 0) return null;
  try {
    await client.query(
      `UPDATE surtidores
          SET nombre = COALESCE($1, nombre),
              usa_totalizador = COALESCE($2, usa_totalizador),
              totalizador_tolerancia = COALESCE($3, totalizador_tolerancia)
        WHERE id = $4 AND tenant_id = $5`,
      [
        data.nombre ?? null,
        data.usa_totalizador ?? null,
        data.totalizador_tolerancia ?? null,
        id,
        tenantId,
      ]
    );
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(409, "Ya existe un surtidor con ese nombre en ese grifo");
    }
    throw err;
  }
  return antes.rows[0];
}

/** Conectar un surtidor a un tanque, desde AHORA (no retroactivo: la
 *  conexión decide qué surtidores exige un vale de esa fecha). La base
 *  rechaza un tanque de otro grifo o un surtidor dado de baja. */
export async function conectarTanque(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  surtidorId: number,
  combustibleId: number,
  motivo: string
) {
  const existe = await client.query(`SELECT 1 FROM surtidores WHERE id = $1 AND tenant_id = $2`, [
    surtidorId,
    tenantId,
  ]);
  if (existe.rowCount === 0) return null;
  try {
    const r = await client.query<{ id: string }>(
      `INSERT INTO surtidor_tanques
         (tenant_id, surtidor_id, combustible_id, motivo_conexion, conectado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, surtidorId, combustibleId, motivo, usuarioId]
    );
    return r.rows[0];
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(409, "El surtidor ya está conectado a ese tanque");
    }
    traducirErrorDeBase(err);
  }
}

export async function desconectarTanque(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  surtidorId: number,
  conexionId: number,
  motivo: string
) {
  const r = await client.query<{ combustible_id: number }>(
    `UPDATE surtidor_tanques
        SET desconectado_en = now(), motivo_desconexion = $1, desconectado_por = $2
      WHERE id = $3 AND surtidor_id = $4 AND tenant_id = $5 AND desconectado_en IS NULL
      RETURNING combustible_id`,
    [motivo, usuarioId, conexionId, surtidorId, tenantId]
  );
  return r.rows[0] ?? null;
}

/** Dar de baja: se desconecta de todo (con el mismo motivo) y deja de
 *  poder despachar. Devuelve si usaba totalizador: darlo de baja así es
 *  aflojar la vigilancia. Null si no existe o ya estaba de baja. */
export async function bajaSurtidor(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  motivo: string
) {
  const r = await client.query<{ nombre: string; usa_totalizador: boolean }>(
    `UPDATE surtidores SET activo = false, motivo_baja = $1
      WHERE id = $2 AND tenant_id = $3 AND activo
      RETURNING nombre, usa_totalizador`,
    [motivo, id, tenantId]
  );
  if (r.rows.length === 0) return null;
  await client.query(
    `UPDATE surtidor_tanques
        SET desconectado_en = now(), motivo_desconexion = $1, desconectado_por = $2
      WHERE surtidor_id = $3 AND tenant_id = $4 AND desconectado_en IS NULL`,
    [`Baja del surtidor: ${motivo}`, usuarioId, id, tenantId]
  );
  return r.rows[0];
}

/** Reactivar no reconecta: las conexiones se vuelven a hacer a mano, desde
 *  ahora. Un surtidor que vuelve no tiene por qué alimentar lo mismo. */
export async function reactivarSurtidor(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `UPDATE surtidores SET activo = true WHERE id = $1 AND tenant_id = $2 AND NOT activo
      RETURNING id`,
    [id, tenantId]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function historialConexiones(client: PoolClient, tenantId: string, id: number) {
  const r = await client.query(
    `SELECT st.id, c.codigo, c.tanque_nombre, st.conectado_en, st.desconectado_en,
            st.motivo_conexion, st.motivo_desconexion,
            uc.nombre AS conectado_por, ud.nombre AS desconectado_por
       FROM surtidor_tanques st
       JOIN combustible c ON c.id = st.combustible_id AND c.tenant_id = $1
       LEFT JOIN usuarios uc ON uc.id = st.conectado_por AND uc.tenant_id = $1
       LEFT JOIN usuarios ud ON ud.id = st.desconectado_por AND ud.tenant_id = $1
      WHERE st.tenant_id = $1 AND st.surtidor_id = $2
      ORDER BY st.conectado_en DESC, st.id DESC`,
    [tenantId, id]
  );
  return r.rows;
}
