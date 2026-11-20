-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la compra en ruta a una unidad ESCRITA A MANO (sin Flota)
--
-- Autonomía de Combustible (ver 0176 para el vale del tanque, 0192 para urea y tanqueta, 0195 para
-- el excedente): una empresa sin Flota, o con una unidad que la oficina aún no registró, escribe la
-- placa. La compra en ruta del conductor también.
--
-- `combustible_compras_ruta` (0135) es la cabecera de la boleta: guardaba `unidad_equipo_id`
-- obligatorio. Ahora la unidad es UNA de dos: la registrada (`unidad_equipo_id`) o la placa escrita
-- (`placa_sin_alta`, ya normalizada: mayúsculas, sin espacios ni guiones). Los vales de cada
-- producto (combustible, urea) llevan la misma unidad en `combustible_despachos` (0176), que ya
-- admite `unidad_sin_alta` y, desde 0192, también la urea.
--
-- Solo se RELAJA una restricción: toda fila que existe hoy tiene unidad registrada y cumple el
-- CHECK nuevo (unidad no nula, placa nula). No hay datos que migrar.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_compras_ruta ALTER COLUMN unidad_equipo_id DROP NOT NULL;

ALTER TABLE combustible_compras_ruta ADD COLUMN IF NOT EXISTS placa_sin_alta VARCHAR(20);

ALTER TABLE combustible_compras_ruta DROP CONSTRAINT IF EXISTS combustible_compras_ruta_unidad_check;
ALTER TABLE combustible_compras_ruta
  ADD CONSTRAINT combustible_compras_ruta_unidad_check
  CHECK (
    (unidad_equipo_id IS NULL) = (placa_sin_alta IS NOT NULL)
    AND (placa_sin_alta IS NULL OR placa_sin_alta ~ '^[A-Z0-9]{3,20}$')
  );
