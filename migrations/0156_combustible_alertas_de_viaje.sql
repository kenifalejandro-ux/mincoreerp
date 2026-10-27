-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: alertas de un VIAJE EN CURSO (demorado y detenido)
--
-- Dos tipos nuevos, los dos ESTADOS (se resuelven solos cuando el problema deja de existir):
--
--   viaje_demorado   El tramo en el que va el viaje ya pasó lo que suele tardar (la mediana del
--                    historial de unidades del mismo tipo, sin contar descansos ni detenciones)
--                    más un margen. Es la alerta de "no llegó a la hora estimada".
--   viaje_detenido   El viaje tiene abierta una detención (avería, accidente, huaico, bloqueo o
--                    tráfico). Es informativa: el tiempo detenido no cuenta como demora.
--
-- Una alerta tiene que ser SOBRE algo: esta es sobre un viaje (viaje_id). La alerta copia el grifo
-- de la unidad del viaje, así la ve quien tiene ese grifo y no solo la empresa entera.
--
-- Los dos CHECK se reescriben completos, partiendo de la lista de 0144 (la última que los tocó)
-- más los dos tipos nuevos. `combustible_anomalias` no cambia: un estado no se congela.
--
-- La FK nueva (alertas → viajes) va dentro de la ventana NO FORCE de 0097: las dos tablas tienen
-- FORCE RLS y la validación de la FK las lee.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_alertas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viajes NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_alertas
  ADD COLUMN IF NOT EXISTS viaje_id BIGINT
    REFERENCES combustible_viajes(id) ON DELETE CASCADE;

-- Ni la bandeja ni el worker miran las alertas de viaje ya resueltas por viaje: solo las abiertas.
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_viaje
  ON combustible_alertas (tenant_id, viaje_id, tipo)
  WHERE viaje_id IS NOT NULL AND resuelta_en IS NULL;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────

ALTER TABLE combustible_alertas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;

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
      OR viaje_id IS NOT NULL
    );

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
      -- 0156
      'viaje_demorado', 'viaje_detenido'
    )) NOT VALID;
END $$;

-- La alerta copia el grifo de la unidad del viaje (equipos.grifo_interno_id).
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
  ELSIF NEW.viaje_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT e.grifo_interno_id
                               FROM combustible_viajes v
                               JOIN equipos e ON e.tenant_id = v.tenant_id AND e.id = v.equipo_id
                              WHERE v.id = NEW.viaje_id);
  ELSIF NEW.combustible_id IS NOT NULL THEN
    NEW.grifo_interno_id := grifo_de_tanque_en(NEW.combustible_id, COALESCE(NEW.creado_en, now()));
  END IF;
  RETURN NEW;
END $$;
