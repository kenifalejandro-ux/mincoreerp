/** src/modules/proveedores/proveedores.repository.ts
 *
 * Lectura de los proveedores para el ecosistema «Gestión de proveedores» (PR1, solo lectura).
 * Hoy los proveedores son las filas de `combustible_grifos` (la tabla de Combustible): este módulo
 * las LEE, no las modifica ni las posee todavía. Por eso el registro declara `opcionales:
 * ["combustible"]` (ver src/modules/registry.ts y tests/modulos-autonomos.test.ts).
 *
 * PR2: también crea y edita esas mismas filas (la tabla sigue siendo de Combustible hasta el PR6).
 *
 * El proveedor "Otros" (`es_otros`, 0163) es un comodín interno de Combustible para los grifos que
 * no están en el catálogo: no es un proveedor real y no se lista acá.
 */
import type { PoolClient } from "pg";

import { esViolacionUnicidad } from "../../server/shared/utils/pgError";
import type {
  ActualizarProveedorInput,
  CrearProveedorInput,
} from "../../server/schemas/proveedores.schema";

export interface FilaProveedor {
  id: number;
  nombre: string;
  ruc: string | null;
  activo: boolean;
  abastece_tanque: boolean;
  abastece_ruta: boolean;
  abastece_urea: boolean;
  abastece_urea_ruta: boolean;
  creado_en: Date;
}

const COLUMNAS = `id, nombre, ruc, activo, abastece_tanque, abastece_ruta, abastece_urea,
                  abastece_urea_ruta, creado_en`;

import type { RecepcionDb } from "./proveedores.compras";
import type {
  FilaPrecioCombustibleDb,
  FilaPrecioUreaDb,
  PresentacionDb,
} from "./proveedores.precios";

export class ProveedoresRepository {
  async listar(client: PoolClient, tenantId: string): Promise<FilaProveedor[]> {
    const result = await client.query<FilaProveedor>(
      `SELECT ${COLUMNAS} FROM combustible_grifos
        WHERE tenant_id = $1 AND NOT es_otros
        ORDER BY nombre ASC`,
      [tenantId]
    );
    return result.rows;
  }

  async buscarPorId(
    client: PoolClient,
    tenantId: string,
    id: number
  ): Promise<FilaProveedor | undefined> {
    const result = await client.query<FilaProveedor>(
      `SELECT ${COLUMNAS} FROM combustible_grifos
        WHERE tenant_id = $1 AND id = $2 AND NOT es_otros`,
      [tenantId, id]
    );
    return result.rows[0];
  }

  // ── Precios (solo lectura, PR4): las tablas son de Combustible (0063 y 0121) ─────────────────────

  /** Los precios de combustible de PROVEEDORES (los de ruta); los de tanque son la venta interna. */
  async listarPreciosCombustibleDeProveedores(
    client: PoolClient,
    tenantId: string
  ): Promise<FilaPrecioCombustibleDb[]> {
    const r = await client.query<FilaPrecioCombustibleDb>(
      `SELECT p.id, p.tipo_combustible, p.grifo_id, p.precio_unitario, p.vigente_desde,
              u.nombre AS registrado_por, p.anulada_en, p.motivo_anulacion
         FROM combustible_precios p
         LEFT JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.tenant_id = $1 AND p.grifo_id IS NOT NULL
        ORDER BY p.vigente_desde DESC, p.id DESC`,
      [tenantId]
    );
    return r.rows;
  }

  async listarPreciosUrea(client: PoolClient, tenantId: string): Promise<FilaPrecioUreaDb[]> {
    const r = await client.query<FilaPrecioUreaDb>(
      `SELECT p.id, p.grifo_id, p.presentacion, p.marca, p.precio_por_bulto, p.vigente_desde,
              u.nombre AS registrado_por, p.anulada_en, p.motivo_anulacion
         FROM combustible_urea_precios p
         LEFT JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.tenant_id = $1
        ORDER BY p.vigente_desde DESC, p.id DESC`,
      [tenantId]
    );
    return r.rows;
  }

  /** Los tipos de combustible que la empresa maneja en sus tanques activos. */
  async tiposDeCombustibleEnTanques(client: PoolClient, tenantId: string): Promise<string[]> {
    const r = await client.query<{ tipo_combustible: string }>(
      `SELECT DISTINCT tipo_combustible FROM combustible
        WHERE tenant_id = $1 AND activo AND tipo_combustible IS NOT NULL`,
      [tenantId]
    );
    return r.rows.map((x) => x.tipo_combustible);
  }

  async presentacionesDeUreaActivas(
    client: PoolClient,
    tenantId: string
  ): Promise<PresentacionDb[]> {
    const r = await client.query<PresentacionDb>(
      `SELECT codigo, nombre, litros FROM combustible_urea_presentaciones
        WHERE tenant_id = $1 AND activa ORDER BY es_referencia DESC, litros DESC, id`,
      [tenantId]
    );
    return r.rows;
  }

  // ── Compras y recepciones (solo lectura, PR5): las tablas son de Combustible (0171 y 0173) ───────

  /** Las recepciones vigentes de esas compras, con la unidad del tanque que recibió. */
  async recepcionesDeCompras(
    client: PoolClient,
    tenantId: string,
    recepcionIds: number[]
  ): Promise<RecepcionDb[]> {
    if (recepcionIds.length === 0) return [];
    const r = await client.query<RecepcionDb>(
      `SELECT r.id, r.cantidad, r.cantidad_derivada, r.recibido_en, c.unidad
         FROM combustible_recepciones r
         JOIN combustible c ON c.id = r.combustible_id AND c.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.id = ANY($2::bigint[])`,
      [tenantId, recepcionIds]
    );
    return r.rows;
  }

  /** Crea un proveedor. Los índices únicos de nombre (0063) y de RUC (0160) los hace cumplir la base:
   *  se distinguen por el nombre del constraint. */
  async crear(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearProveedorInput
  ): Promise<FilaProveedor> {
    try {
      const result = await client.query<FilaProveedor>(
        `INSERT INTO combustible_grifos
           (tenant_id, nombre, ruc, abastece_tanque, abastece_ruta, abastece_urea,
            abastece_urea_ruta, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${COLUMNAS}`,
        [
          tenantId,
          data.nombre,
          data.ruc,
          data.abastece_tanque,
          data.abastece_ruta,
          data.abastece_urea,
          data.abastece_urea_ruta,
          usuarioId,
        ]
      );
      return result.rows[0];
    } catch (err) {
      throw traducirUnicidad(err, data);
    }
  }

  /** Edita un proveedor (nunca el comodín «Otros»). `undefined` si no existe. */
  async actualizar(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarProveedorInput
  ): Promise<FilaProveedor | undefined> {
    try {
      const result = await client.query<FilaProveedor>(
        `UPDATE combustible_grifos
            SET nombre = $1, ruc = $2, activo = $3, abastece_tanque = $4, abastece_ruta = $5,
                abastece_urea = $6, abastece_urea_ruta = $7
          WHERE tenant_id = $8 AND id = $9 AND NOT es_otros
          RETURNING ${COLUMNAS}`,
        [
          data.nombre,
          data.ruc,
          data.activo,
          data.abastece_tanque,
          data.abastece_ruta,
          data.abastece_urea,
          data.abastece_urea_ruta,
          tenantId,
          id,
        ]
      );
      return result.rows[0];
    } catch (err) {
      throw traducirUnicidad(err, data);
    }
  }
}

/** Un nombre o un RUC repetido en la empresa: error de negocio (409), no 500. */
export class ProveedorDuplicadoError extends Error {}

function traducirUnicidad(err: unknown, data: { nombre: string; ruc: string | null }): unknown {
  if (!esViolacionUnicidad(err)) return err;
  const esRuc = ((err as { constraint?: string }).constraint ?? "").includes("ruc");
  return new ProveedorDuplicadoError(
    esRuc
      ? `Ya existe un proveedor con el RUC ${data.ruc}`
      : `Ya existe un proveedor llamado "${data.nombre}"`,
    { cause: err }
  );
}
