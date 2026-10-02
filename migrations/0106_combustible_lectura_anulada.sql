-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: alerta por varilla anulada en cancha.
--
-- El grifero pasa a poder anular SU PROPIA varilla mal tipeada (matriz
-- robusta de perfiles, fila 21: "puede anular el mal tipeo pero
-- justificando, deja alerta"). Hasta acá solo podían admin y operador, por
-- un motivo real: una varilla que se puede anular es una varilla que se
-- puede hacer coincidir con lo que uno ya declaró.
--
-- Lo que hace tolerable abrirlo es que no queda en silencio. Cada anulación
-- hecha por un perfil de cancha levanta una alerta `lectura_anulada` con el
-- motivo, para que alguien de oficina la vea. La fila de la lectura nunca se
-- borra (sigue el criterio de 0058: anulación lógica, con autor y motivo).
--
-- EJECUTAR (después de 0102, que fijó la lista anterior):
--   psql -d mincoreerp -f migrations/0106_combustible_lectura_anulada.sql
-- ═══════════════════════════════════════════════════════════════════════════

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
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso',
    'precinto_alterado', 'precinto_reemplazado',
    'equipo_de_otro_grifo',
    'sobrestock_recepcion',
    'lectura_anulada'
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
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso',
    'precinto_alterado', 'precinto_reemplazado',
    'equipo_de_otro_grifo',
    'sobrestock_recepcion',
    'lectura_anulada'
  ));
