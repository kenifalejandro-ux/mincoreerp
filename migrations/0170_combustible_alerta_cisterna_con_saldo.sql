-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: alerta de la cisterna que sigue con saldo (0168/0169)
--
-- Lo que se deja en la cisterna del proveedor se reparte en unos días y la
-- cisterna vuelve vacía. Si pasado el plazo todavía tiene saldo, algo quedó sin
-- repartir: la alerta `cisterna_con_saldo` lo dice, UNA por recepción.
--
-- Es un ESTADO, como `comprobante_sin_foto` (0129): se resuelve sola cuando el
-- saldo llega a 0 o se anula la recepción. Se crea en el worker de conciliación
-- y va solo al ERP (campanita y Bandeja), sin correo: no es un robo en curso.
--
-- El plazo es de la empresa. Default 10 días: el cliente carga cada 7-10 días
-- y la cisterna se queda una semana aproximadamente, así que con 7 una
-- cisterna normal alertaría justo en su límite.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS dias_cisterna_con_saldo INT NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_dias_cisterna_con_saldo_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_dias_cisterna_con_saldo_check
      CHECK (dias_cisterna_con_saldo BETWEEN 1 AND 90);
  END IF;

  -- La lista de tipos de 0156 más el nuevo. La alerta se ancla a la recepción
  -- (recepcion_id), que ya es una de las anclas permitidas.
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
      'tanqueta_retorno_diferencia',
      'viaje_demorado', 'viaje_detenido',
      -- 0170
      'cisterna_con_saldo'
    )) NOT VALID;
END $$;
