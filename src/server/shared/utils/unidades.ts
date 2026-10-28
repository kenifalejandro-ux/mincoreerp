/** src/server/shared/utils/unidades.ts */

/** Litros que tiene un galón. Es la única conversión gal↔L del sistema:
 *  los tanques y los equipos miden en `gal` o `L`, las tanquetas siempre en
 *  galones, y los controles de consumo comparan todo en litros. */
export const LITROS_POR_GALON = 3.785411784;

/** Cuándo la cantidad de un despacho está en galones: el tanque es de galones,
 *  la carga sale de una tanqueta (siempre en galones) o es una compra externa de
 *  combustible en galones (0158: sin unidad guardada, galones; si la boleta dice
 *  litros, no). La urea no entra:
 *  va en litros. `tanque` y `d` son los alias del tanque y del despacho. */
export const esGalonSql = (tanque: string, d = "d") =>
  `(${tanque}.unidad = 'gal' OR ${d}.tanqueta_origen_id IS NOT NULL
    OR (${d}.producto = 'combustible' AND ${d}.origen = 'compra_externa'
        AND COALESCE(${d}.cantidad_unidad, 'gal') = 'gal'))`;

/** La cantidad del despacho en litros, para comparar todo en la misma unidad. */
export const litrosSql = (tanque: string, d = "d") =>
  `${d}.cantidad * CASE WHEN ${esGalonSql(tanque, d)} THEN ${LITROS_POR_GALON} ELSE 1 END`;
