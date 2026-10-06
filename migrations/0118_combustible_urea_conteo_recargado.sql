-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el conteo de urea que se anula y se vuelve a cargar
--
-- Cuarta entrega del panel de urea. Ver docs/architecture/urea-industrial.md,
-- checklist anti-fraude, vector 4: "anular conteos hasta que uno cuadre".
--
-- ── El hueco ───────────────────────────────────────────────────────────────
--
-- El conteo físico es el único control independiente de la urea, y el
-- cliente confirmó que lo hace la MISMA persona que recibe y reparte. Hoy:
--
--   1. Cuenta 80 L. Los papeles dicen 112. Nace `urea_descuadre_conteo`.
--   2. Anula el conteo con "conté mal una caja".
--   3. Carga otro conteo de 112 L. Cuadra. No nace nada.
--
-- La alerta del paso 1 sigue abierta (anular no la cierra, bien), pero nada
-- la vincula con el paso 3: quien la revise ve un descuadre de un conteo
-- anulado "por error de tipeo" y un conteo posterior que cuadra -- la
-- historia que el que anuló quería que se viera.
--
-- ── Por qué no se calca `vale_recargado` al pie de la letra ────────────────
--
-- `vale_recargado` (0081) alerta cuando la CANTIDAD del vale vuelto a cargar
-- es distinta. Un conteo no se puede comparar así: entre el conteo anulado y
-- el nuevo pueden haber salido vales, y dos cantidades distintas pueden ser
-- las dos correctas. Lo que se compara es el DESCUADRE de cada uno contra lo
-- que los papeles decían a SU hora.
--
-- Y se alerta SOLO cuando el nuevo queda más cerca de cuadrar que el
-- anulado. Ese es el patrón exacto del vector: anular lo que no cuadra y
-- cargar algo que sí. Un recuento que muestra MÁS faltante que el anulado no
-- esconde nada -- al contrario, admite una pérdida mayor -- y alertarlo sería
-- ruido sobre la corrección honesta.
--
-- Es un HALLAZGO, no un estado: entra en las dos listas (se congela si nadie
-- lo explica). Se ancla al conteo NUEVO por `urea_conteo_id`, que el CHECK de
-- anclas acepta desde 0092; el anulado viaja en el `detalle`.
--
-- Aplicar: `npm run migrate`.
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
      -- 0118
      'urea_conteo_recargado',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada'
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
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada'
    ));
END $$;

-- La búsqueda corre en cada conteo nuevo: "¿hubo uno anulado hace poco?".
-- Parcial sobre los anulados, que son pocos.
CREATE INDEX IF NOT EXISTS idx_combustible_conteos_urea_anulados
  ON combustible_conteos_urea (tenant_id, anulada_en)
  WHERE anulada_en IS NOT NULL;
