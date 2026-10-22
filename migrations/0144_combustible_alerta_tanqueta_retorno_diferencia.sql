-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: alerta cuando el saldo que vuelve en una tanqueta no es el calculado
--
-- Al recibir una tanqueta de vuelta (0143) el grifero puede corregir el saldo
-- que calculó el sistema, con motivo. Esa corrección es dinero y combustible:
-- si pasa de 5 gal o del 5 % del saldo calculado (lo que sea mayor), o si el
-- grifero declara que volvió MÁS de lo calculado (aunque sea poco), queda una
-- alerta con quién, cuánto y por qué. Es un HALLAZGO y no un estado: la
-- corrección no deja de ser verdad con el tiempo.
--
-- Los dos CHECK se reescriben completos, partiendo de la lista de 0138 (la
-- última que los tocó) más el tipo nuevo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── El ancla: el retorno que la disparó ───────────────────────────────────
-- Una alerta tiene que ser SOBRE algo (un vale, un tanque, una recepción...).
-- Esta es sobre un retorno de tanqueta (0143).

ALTER TABLE combustible_alertas
  ADD COLUMN IF NOT EXISTS tanqueta_retorno_id BIGINT
    REFERENCES combustible_tanqueta_retornos(id) ON DELETE CASCADE;
ALTER TABLE combustible_anomalias
  ADD COLUMN IF NOT EXISTS tanqueta_retorno_id BIGINT
    REFERENCES combustible_tanqueta_retornos(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_combustible_alertas_tanqueta_retorno
  ON combustible_alertas (tanqueta_retorno_id) WHERE tanqueta_retorno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_tanqueta_retorno
  ON combustible_anomalias (tanqueta_retorno_id) WHERE tanqueta_retorno_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_ancla_check;
  ALTER TABLE combustible_alertas
    ADD CONSTRAINT combustible_alertas_ancla_check
    CHECK (
      (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
      OR combustible_id IS NOT NULL
      OR recepcion_id IS NOT NULL
      OR urea_conteo_id IS NOT NULL
      OR despacho_id IS NOT NULL
      OR urea_correccion_id IS NOT NULL
      OR tanqueta_retorno_id IS NOT NULL
    );

  ALTER TABLE combustible_anomalias DROP CONSTRAINT IF EXISTS combustible_anomalias_ancla_check;
  ALTER TABLE combustible_anomalias
    ADD CONSTRAINT combustible_anomalias_ancla_check
    CHECK (
      (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
      OR combustible_id IS NOT NULL
      OR recepcion_id IS NOT NULL
      OR urea_conteo_id IS NOT NULL
      OR despacho_id IS NOT NULL
      OR urea_correccion_id IS NOT NULL
      OR tanqueta_retorno_id IS NOT NULL
    );
END $$;

-- La alerta copia el grifo de la tanqueta del retorno: así la ve y la recibe
-- por correo quien tiene ese grifo, no solo la empresa entera.
CREATE OR REPLACE FUNCTION copiar_grifo_alerta()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grifo_interno_id IS NOT NULL OR COALESCE(NEW.producto, 'combustible') = 'urea' THEN
    RETURN NEW;
  END IF;
  IF NEW.despacho_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT d.grifo_interno_id FROM combustible_despachos d
                              WHERE d.id = NEW.despacho_id);
  ELSIF NEW.lectura_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT l.grifo_interno_id FROM combustible_lecturas l
                              WHERE l.id = NEW.lectura_id);
  ELSIF NEW.recepcion_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT r.grifo_interno_id FROM combustible_recepciones r
                              WHERE r.id = NEW.recepcion_id);
  ELSIF NEW.tanqueta_retorno_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT t.grifo_interno_id
                               FROM combustible_tanqueta_retornos r
                               JOIN combustible_tanquetas t
                                 ON t.tenant_id = r.tenant_id AND t.id = r.tanqueta_id
                              WHERE r.id = NEW.tanqueta_retorno_id);
  ELSIF NEW.combustible_id IS NOT NULL THEN
    NEW.grifo_interno_id := grifo_de_tanque_en(NEW.combustible_id, COALESCE(NEW.creado_en, now()));
  END IF;
  RETURN NEW;
END $$;

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
      -- 0144
      'tanqueta_retorno_diferencia'
    )) NOT VALID;

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
      'tanqueta_retorno_diferencia'
    )) NOT VALID;
END $$;
