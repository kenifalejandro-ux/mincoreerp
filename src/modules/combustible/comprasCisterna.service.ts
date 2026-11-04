/** src/modules/combustible/comprasCisterna.service.ts
 *
 * La compra de una cisterna, antes de que llegue (migración 0171): la encargada anota proveedor,
 * factura, fechas, cantidad facturada y costo. No es una orden de compra.
 *
 * El estado se DERIVA al leer (no hay columna): registrada (solo la ve quien gestiona compras),
 * por_llegar (la ve también la cancha: se habilitó o llegó el día estimado, en hora de Lima) y
 * anulada. Así no hace falta una tarea programada que se pueda caer.
 */
import type { PoolClient } from "pg";

import { AppError } from "../../server/shared/middlewares/error.middleware";
import { esViolacionUnicidad } from "../../server/shared/utils/pgError";
import { motivoGrifoNoAsignable } from "../../server/services/sedes.service";
import type { CrearCompraCisternaInput } from "../../server/schemas/combustible.schema";
import { type AlcanceCombustible } from "./alcance";
import { CombustibleRepository } from "./combustible.repository";

const repository = new CombustibleRepository();

export type EstadoDeCompra = "registrada" | "por_llegar" | "anulada";

const HOY_EN_LIMA = `(now() AT TIME ZONE 'America/Lima')::date`;

const COLUMNAS = `
  c.id, c.cliente_uuid, c.grifo_interno_id, c.grifo_id, g.nombre AS proveedor,
  c.tipo_combustible, c.unidad, c.tipo_documento, c.numero_documento,
  to_char(c.fecha_compra, 'YYYY-MM-DD') AS fecha_compra,
  to_char(c.llegada_estimada, 'YYYY-MM-DD') AS llegada_estimada,
  c.cantidad_facturada, c.costo_unitario, c.placa, c.chofer,
  c.habilitada_en, c.creado_en, c.anulada_en, c.motivo_anulacion,
  CASE WHEN c.anulada_en IS NOT NULL THEN 'anulada'
       WHEN c.habilitada_en IS NOT NULL OR c.llegada_estimada <= ${HOY_EN_LIMA} THEN 'por_llegar'
       ELSE 'registrada' END AS estado`;

const DESDE = `
  FROM combustible_compras_cisterna c
  JOIN combustible_grifos g ON g.id = c.grifo_id AND g.tenant_id = c.tenant_id`;

export const fueraDelAlcance = (alcance: AlcanceCombustible, grifoInternoId: number) =>
  !alcance.todo && !alcance.grifos.includes(Number(grifoInternoId));

/** La compra por id, o null si no existe o su sede está fuera del alcance. */
async function obtenerCompra(
  client: PoolClient,
  tenantId: string,
  id: number,
  alcance: AlcanceCombustible
) {
  const r = await client.query(`SELECT ${COLUMNAS} ${DESDE} WHERE c.tenant_id = $1 AND c.id = $2`, [
    tenantId,
    id,
  ]);
  const fila = r.rows[0] ?? null;
  return fila && !fueraDelAlcance(alcance, fila.grifo_interno_id) ? fila : null;
}

/** Registra la compra. Idempotente por `cliente_uuid`: un reintento devuelve la ya guardada
 *  (`creado: false`) sin crear otra. */
export async function crearCompra(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  data: CrearCompraCisternaInput,
  alcance: AlcanceCombustible
) {
  if (fueraDelAlcance(alcance, data.grifo_interno_id)) {
    throw new AppError(404, "El grifo no existe");
  }
  if (data.cliente_uuid) {
    const previa = await client.query<{ id: string }>(
      `SELECT id FROM combustible_compras_cisterna WHERE tenant_id = $1 AND cliente_uuid = $2`,
      [tenantId, data.cliente_uuid]
    );
    if (previa.rows[0]) {
      return {
        fila: await obtenerCompra(client, tenantId, Number(previa.rows[0].id), alcance),
        creado: false,
      };
    }
  }
  const noAsignable = await motivoGrifoNoAsignable(client, tenantId, data.grifo_interno_id);
  if (noAsignable) throw new AppError(400, noAsignable);
  const proveedor = await repository.findGrifoPorId(client, tenantId, data.grifo_id);
  if (!proveedor) throw new AppError(400, "El proveedor no existe");
  if (!proveedor.activo)
    throw new AppError(400, `El proveedor "${proveedor.nombre}" está desactivado`);
  if (!proveedor.abastece_tanque) {
    throw new AppError(
      400,
      `El proveedor "${proveedor.nombre}" no está marcado como proveedor de tanque (interno): márcalo en Proveedores o elige otro`
    );
  }
  try {
    const r = await client.query<{ id: string }>(
      `INSERT INTO combustible_compras_cisterna
         (tenant_id, cliente_uuid, grifo_interno_id, grifo_id, tipo_combustible, unidad,
          tipo_documento, numero_documento, fecha_compra, llegada_estimada,
          cantidad_facturada, costo_unitario, placa, chofer, usuario_id)
       VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        tenantId,
        data.cliente_uuid ?? null,
        data.grifo_interno_id,
        data.grifo_id,
        data.tipo_combustible,
        data.unidad,
        data.tipo_documento,
        data.numero_documento,
        data.fecha_compra,
        data.llegada_estimada,
        data.cantidad_facturada,
        data.costo_unitario,
        data.placa || null,
        data.chofer || null,
        usuarioId,
      ]
    );
    return {
      fila: await obtenerCompra(client, tenantId, Number(r.rows[0].id), alcance),
      creado: true,
    };
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(
        409,
        `Ya hay una compra con el documento ${data.numero_documento} de ${proveedor.nombre}`
      );
    }
    throw err;
  }
}

/** Las compras de las sedes del alcance, las más recientes primero. Quien no gestiona compras
 *  (la cancha) solo recibe las que ya están por llegar; las anuladas y las que la encargada aún
 *  no habilita no existen para ella. */
export async function listarCompras(
  client: PoolClient,
  tenantId: string,
  alcance: AlcanceCombustible,
  gestiona: boolean
) {
  const valores: unknown[] = [tenantId];
  const condiciones = ["c.tenant_id = $1"];
  if (!alcance.todo) {
    valores.push(alcance.grifos);
    condiciones.push(`c.grifo_interno_id = ANY($${valores.length}::int[])`);
  }
  if (!gestiona) {
    condiciones.push(
      `c.anulada_en IS NULL AND (c.habilitada_en IS NOT NULL OR c.llegada_estimada <= ${HOY_EN_LIMA})`
    );
  }
  const r = await client.query(
    `SELECT ${COLUMNAS} ${DESDE} WHERE ${condiciones.join(" AND ")}
      ORDER BY c.llegada_estimada DESC, c.id DESC`,
    valores
  );
  return r.rows;
}

/** La encargada abre la compra a la cancha antes del día estimado. Idempotente. */
export async function habilitarCompra(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  alcance: AlcanceCombustible
) {
  const compra = await obtenerCompra(client, tenantId, id, alcance);
  if (!compra) throw new AppError(404, "La compra no existe");
  if (compra.estado === "anulada") throw new AppError(409, "La compra está anulada");
  await client.query(
    `UPDATE combustible_compras_cisterna
        SET habilitada_en = COALESCE(habilitada_en, now()),
            habilitada_por = COALESCE(habilitada_por, $3)
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, usuarioId]
  );
  return (await obtenerCompra(client, tenantId, id, alcance))!;
}

/** Anula una compra con motivo. Nunca se borra: queda como evidencia. */
export async function anularCompra(
  client: PoolClient,
  tenantId: string,
  usuarioId: string,
  id: number,
  motivo: string,
  alcance: AlcanceCombustible
) {
  const compra = await obtenerCompra(client, tenantId, id, alcance);
  if (!compra) throw new AppError(404, "La compra no existe");
  if (compra.estado === "anulada") throw new AppError(409, "La compra ya está anulada");
  await client.query(
    `UPDATE combustible_compras_cisterna
        SET anulada_en = now(), anulada_por = $3, motivo_anulacion = $4
      WHERE tenant_id = $1 AND id = $2 AND anulada_en IS NULL`,
    [tenantId, id, usuarioId, motivo]
  );
  return (await obtenerCompra(client, tenantId, id, alcance))!;
}
