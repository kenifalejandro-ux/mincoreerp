-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: alerta cuando el total de una boleta de compra en ruta no cuadra
--
-- La compra en ruta unificada (0135) guarda el total que dice el papel y el que
-- calcula el sistema. Si difieren en más de S/ 0.10, el conductor tuvo que
-- escribir el motivo y la compra se registró igual: acá se agrega la alerta que
-- lo deja a la vista de quien revisa, en la Bandeja y en el resumen diario.
--
-- Es un HALLAZGO y no un estado: el descuadre no "deja de ser verdad" porque
-- pase el tiempo. Por eso va en las dos listas (alertas y anomalías), o el
-- worker no podría congelarlo -- mismo criterio que urea_precio_fuera_de_catalogo
-- (0121) y urea_litros_corregidos (0130).
--
-- Los dos CHECK se reescriben completos, partiendo de la lista de 0132 (la última
-- que los tocó) más el tipo nuevo.
-- ═══════════════════════════════════════════════════════════════════════════

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
      'urea_litros_corregidos',
      'urea_conteo_alterado',
      -- 0136
      'compra_ruta_descuadre'
    ));

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
      'urea_conteo_alterado',
      -- 0136
      'compra_ruta_descuadre'
    ));
END $$;
