-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el conteo de urea se compara envase por envase
--
-- Ver docs/architecture/urea-industrial.md (entrega 11).
--
-- ── Lo que cambia ───────────────────────────────────────────────────────────
--
-- Desde 0130 el conteo guarda sus renglones ("17 cajas + 32 bolsas"), pero el
-- descuadre se seguía calculando contra el stock TOTAL. Un conteo de solo
-- cajas daba como faltantes todas las bolsas que nadie contó, y un conteo
-- completo no decía QUÉ faltaba: "-8 L" en vez de "faltan 2 bolsas".
--
-- Ahora el descuadre es por envase y solo de los envases contados. El código
-- lo resuelve; acá van las dos piezas de datos que hacen falta:
--
--   • `suelto_litros`: la urea que no está en un envase entero (una caja
--     abierta, una bolsa rota). Sin este campo, el que cuenta tenía que
--     elegir entre no contarla (faltante falso) o contarla como envase entero
--     (sobrante falso). NULL = no se informó, distinto de 0 = "no había".
--
--   • `urea_conteo_alterado`: un movimiento registrado DESPUÉS del conteo,
--     con fecha ANTERIOR (una factura que llegó tarde, una anulación), cambió
--     el resultado de ese conteo. El descuadre se recalcula solo -- y una
--     entrada falsa con fecha vieja también lo "arreglaría". Por eso cambiar
--     el pasado de un conteo deja su propio hallazgo: el faltante no puede
--     desaparecer en silencio.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_conteos_urea
  ADD COLUMN IF NOT EXISTS suelto_litros NUMERIC(12, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_conteos_urea_suelto_check'
  ) THEN
    ALTER TABLE combustible_conteos_urea
      ADD CONSTRAINT combustible_conteos_urea_suelto_check
      CHECK (suelto_litros IS NULL OR suelto_litros >= 0);
  END IF;
END $$;

-- Es un HALLAZGO: va en las dos listas, o el worker no podría congelarlo.
DO $$
BEGIN
  ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
  ALTER TABLE combustible_alertas
    ADD CONSTRAINT combustible_alertas_tipo_check
    CHECK (tipo IN (
      'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
      'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
      'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
      'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
      'tanque_sin_vigilancia', 'recepcion_sin_validar', 'varilla_sin_control',
      'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
      'recepcion_anulada', 'recepcion_discrepante', 'recepcion_retroactiva',
      'consumo_excedido', 'varilla_exacta',
      'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
      'urea_stock_bajo', 'urea_stock_excedido',
      'urea_conteo_recargado',
      'urea_precio_fuera_de_catalogo',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada',
      'vale_excede_tanque',
      'comprobante_sin_foto',
      -- 0130
      'urea_litros_corregidos',
      -- 0132
      'urea_conteo_alterado'
    ));

  -- Es un HALLAZGO (no deja de ser verdad): va también en la lista de
  -- anomalías, o el worker no podría congelarlo.
  ALTER TABLE combustible_anomalias DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;
  ALTER TABLE combustible_anomalias
    ADD CONSTRAINT combustible_anomalias_tipo_check
    CHECK (tipo IN (
      'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
      'diferencia_recepcion', 'medidor_inconsistente',
      'descuadre_inventario', 'descuadre_ciclo',
      'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
      'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
      'recepcion_anulada', 'recepcion_discrepante', 'recepcion_retroactiva',
      'consumo_excedido', 'varilla_exacta',
      'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
      'urea_stock_excedido',
      'urea_conteo_recargado',
      'urea_precio_fuera_de_catalogo',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada',
      'vale_excede_tanque',
      'urea_litros_corregidos',
      'urea_conteo_alterado'
    ));
END $$;
