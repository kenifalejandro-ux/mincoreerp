/** src/modules/proveedores/proveedores.repository.ts
 *
 * Lectura de los proveedores para el ecosistema «Gestión de proveedores» (PR1, solo lectura).
 * Hoy los proveedores son las filas de `combustible_grifos` (la tabla de Combustible): este módulo
 * las LEE, no las modifica ni las posee todavía. Por eso el registro declara `opcionales:
 * ["combustible"]` (ver src/modules/registry.ts y tests/modulos-autonomos.test.ts).
 *
 * El proveedor "Otros" (`es_otros`, 0163) es un comodín interno de Combustible para los grifos que
 * no están en el catálogo: no es un proveedor real y no se lista acá.
 */
import type { PoolClient } from "pg";

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
}
