-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la unidad de una compra externa de combustible (gal o L)
--
-- Una compra en ruta no tiene tanque, así que su cantidad no traía unidad: el
-- sistema suponía galones (esGalonSql). Esta columna guarda lo que dice la
-- boleta del grifo -- 20 gal o 70 L -- sin convertir nada.
--
-- NULL significa galones: es lo que pedía el formulario hasta hoy, así que las
-- filas que ya existen quedan bien SIN reescribir ninguna (no hay UPDATE, y por
-- eso no hace falta la ventana NO FORCE ni un corte temporal).
--
-- Solo tiene sentido en la compra externa de combustible: en el tanque propio
-- y en la tanqueta la unidad la da el tanque, y la urea va siempre en litros.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS cantidad_unidad TEXT;

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_cantidad_unidad_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_cantidad_unidad_check
  CHECK (
    cantidad_unidad IS NULL
    OR (cantidad_unidad IN ('gal', 'L')
        AND producto = 'combustible'
        AND origen = 'compra_externa')
  );
