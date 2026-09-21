-- Alerta `historial_sin_contrastar`: el tanque tiene despachos o recepciones
-- FECHADOS ANTES de su primera varilla vigente. Ese consumo no lo puede
-- contrastar ninguna medición (la varilla es posterior), así que el kardex lo
-- muestra como "consumo histórico" sin mover el saldo. La alerta avisa una
-- sola vez por tanque, agregada (cuántos vales, cuántos litros, qué fechas),
-- para que nadie lea ese historial como auditado.
--
-- Es un HALLAZGO y no un estado: los vales históricos no desaparecen, así
-- que no hay condición que la resuelva sola. Se cierra a mano, con motivo
-- ("carga de historial del cliente"), o se congela como anomalía.
-- Por eso entra también al CHECK de combustible_anomalias.
ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
    'tanque_sin_vigilancia',
    'recepcion_anulada', 'recepcion_discrepante', 'recepcion_sin_validar',
    'recepcion_retroactiva', 'consumo_excedido', 'varilla_sin_control',
    'varilla_exacta',
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
    'historial_sin_contrastar'
  ));

ALTER TABLE combustible_anomalias
  DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;
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
    'historial_sin_contrastar'
  ));
