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
