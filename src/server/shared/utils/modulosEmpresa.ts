/** src/server/shared/utils/modulosEmpresa.ts
 *
 * ¿La EMPRESA tiene el módulo? Es la pregunta de un módulo que lee datos de OTRO para mostrar más
 * (ver `opcionales` en src/modules/types.ts) cuando quien los lee no es quien contrata: el grifero
 * y el conductor no tienen `flota` asignado, pero ven la placa de las unidades de sus vales. Para
 * eso `tieneModulo()` (que mira a la PERSONA) no sirve: los dejaría sin placa.
 *
 * Sin el módulo la lectura NO se ejecuta: no se devuelve la fila de la tabla ajena aunque siga en
 * la base (la empresa pudo tener el módulo y apagarlo). Apagar un módulo no borra sus datos.
 *
 * Dos formas, la misma regla (`estado <> 'deshabilitado'`, igual que `requiere` en el login):
 *  - SQL_EMPRESA_TIENE_FLOTA: un fragmento para el ON de un JOIN o el WHERE. Lee el tenant de la
 *    transacción (`app.tenant_id`, que pone withTenant), así Postgres lo calcula UNA vez por
 *    consulta y no por fila. Sin withTenant esa variable no existe y la consulta falla igual que
 *    falla el RLS, no devuelve datos de otra empresa.
 *  - empresaTieneModulo(): para decidir en código (validaciones y rutas). */
import type { Pool, PoolClient } from "pg";

import { MODULOS_DUENOS_DE_UNIDADES } from "./modulos";

export const SQL_EMPRESA_TIENE_FLOTA = `EXISTS (
  SELECT 1 FROM tenant_modulos tm_flota
   WHERE tm_flota.tenant_id = current_setting('app.tenant_id')::uuid
     AND tm_flota.modulo = 'flota' AND tm_flota.estado <> 'deshabilitado')`;

export async function empresaTieneModulo(
  db: Pick<Pool | PoolClient, "query">,
  tenantId: string,
  modulo: string
): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM tenant_modulos
      WHERE tenant_id = $1 AND modulo = $2 AND estado <> 'deshabilitado'`,
    [tenantId, modulo]
  );
  return r.rows.length > 0;
}

/** Lo mismo que SQL_EMPRESA_TIENE_FLOTA pero para «¿la empresa mantiene unidades?»: Flota O
 *  Mantenimiento (los módulos dueños del maestro `equipos`, ver MODULOS_DUENOS_DE_UNIDADES). Es lo
 *  que condiciona leer una unidad (placa, medidor) para mostrarla o validarla. Lo que es propio de
 *  Flota (el conductor asignado, el viaje, asignar una tanqueta a una unidad) sigue con la de Flota. */
export const SQL_EMPRESA_TIENE_UNIDADES = `EXISTS (
  SELECT 1 FROM tenant_modulos tm_unidades
   WHERE tm_unidades.tenant_id = current_setting('app.tenant_id')::uuid
     AND tm_unidades.modulo IN (${MODULOS_DUENOS_DE_UNIDADES.map((m) => `'${m}'`).join(", ")})
     AND tm_unidades.estado <> 'deshabilitado')`;

/** ¿La empresa tiene algún módulo que mantiene unidades? Para decidir en código. */
export async function empresaTieneUnidades(
  db: Pick<Pool | PoolClient, "query">,
  tenantId: string
): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM tenant_modulos
      WHERE tenant_id = $1 AND modulo::text = ANY($2::text[]) AND estado <> 'deshabilitado'
      LIMIT 1`,
    [tenantId, [...MODULOS_DUENOS_DE_UNIDADES]]
  );
  return r.rows.length > 0;
}
