-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la recepción apunta a la COMPRA de su cisterna (0171)
--
-- La encargada registra la compra antes de que llegue (0171). Al descargar, la cancha elige esa
-- compra: la recepción queda vinculada a ella y toma de la compra el proveedor, el documento y el
-- costo, sin volver a tipearlos.
--
-- ── Una compra se recibe UNA vez ───────────────────────────────────────────
--
-- El índice único parcial garantiza que una compra tenga a lo sumo una recepción vigente. Si la
-- recepción se anula, el índice la libera: la compra vuelve a estar disponible sin tocar nada,
-- porque "recibida" se DERIVA de que exista esa recepción (igual que los demás estados).
--
-- ── Descarga sin compra registrada ─────────────────────────────────────────
--
-- `compra_id` es nullable: si la encargada olvidó registrar la compra, la cancha igual descarga (el
-- flujo no se frena) y la compra se vincula después. Mientras tanto queda una alerta
-- `recepcion_sin_compra`, que se resuelve sola al vincularla.
--
-- ── Diferencia entre lo que dice el documento y lo que se descargó ─────────
--
-- Lo evaporado en el viaje hace que llegue un poco menos. Hasta `tolerancia_diferencia_compra`
-- galones no pasa nada; pasada la tolerancia, la alerta `compra_diferencia` lo dice. La tolerancia
-- es de la empresa y la fija la administradora (todavía no se sabe cuánto se evapora): 3 gal al
-- inicio.
-- ═══════════════════════════════════════════════════════════════════════════

-- La FK nueva sobre tablas con FORCE RLS: dentro de la ventana NO FORCE, en las DOS (la de las
-- recepciones y la de las compras que referencia): la validación inicial de la FK lee las dos y
-- pasa por la política (gotcha de 0097).
ALTER TABLE combustible_recepciones NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_compras_cisterna NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_recepciones ADD COLUMN IF NOT EXISTS compra_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_compra_fk'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_compra_fk
      FOREIGN KEY (tenant_id, compra_id) REFERENCES combustible_compras_cisterna (tenant_id, id);
  END IF;
END $$;

ALTER TABLE combustible_recepciones FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_compras_cisterna FORCE ROW LEVEL SECURITY;

-- Una recepción vigente por compra. Parcial: las anuladas liberan la compra.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recepciones_compra_vigente
  ON combustible_recepciones (tenant_id, compra_id)
  WHERE compra_id IS NOT NULL AND anulada_en IS NULL;
-- El índice de la FK (el gate db-index-coverage lo exige).
CREATE INDEX IF NOT EXISTS idx_recepciones_compra
  ON combustible_recepciones (compra_id) WHERE compra_id IS NOT NULL;

-- La tolerancia de la empresa, en galones.
ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS tolerancia_diferencia_compra NUMERIC(8,2) NOT NULL DEFAULT 3;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_tolerancia_compra_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_tolerancia_compra_check
      CHECK (tolerancia_diferencia_compra >= 0 AND tolerancia_diferencia_compra <= 1000);
  END IF;

  -- La lista de tipos de 0170 más los dos nuevos.
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
      'cisterna_con_saldo',
      -- 0173
      'compra_diferencia', 'recepcion_sin_compra'
    )) NOT VALID;
  -- `compra_diferencia` es un HALLAZGO: si nadie lo explica dentro de la ventana de gracia se congela
  -- como anomalía, y por eso entra también en la lista de anomalías (la de 0144 más este tipo).
  -- `recepcion_sin_compra` es un ESTADO (se resuelve sola al vincular la compra): no entra.
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
      -- 0144
      'tanqueta_retorno_diferencia',
      -- 0173
      'compra_diferencia'
    )) NOT VALID;
END $$;
