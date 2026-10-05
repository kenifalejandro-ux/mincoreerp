-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la tanqueta se llena desde el tanque y se descarga en ruta
--
-- Las dos piezas que faltaban del ciclo de la tanqueta (0111):
--
--   3c. PREVISIÓN desde el tanque: el vale de siempre con destino
--       "reserva_cubeta" ahora dice a CUÁL tanqueta (`tanqueta_destino_id`).
--       Descuenta del tanque como siempre y SUMA al saldo de la tanqueta.
--
--   3b. CARGA EN RUTA desde la tanqueta: despacho de origen nuevo 'tanqueta'
--       (`tanqueta_origen_id`). Lo registra el conductor: unidad, horómetro u
--       odómetro y galones. Sin vale (la salida a ruta ya lo tuvo) y sin
--       tanque (no descuenta de ninguno): RESTA del saldo de la tanqueta y
--       cuenta en el consumo de la unidad, que es su control.
--
-- Dos columnas y no una: la misma tanqueta es destino en un vale y origen en
-- otro, y una sola columna haría depender su significado del origen -- el
-- tipo de bug que no se ve hasta que una consulta suma las dos cosas juntas.
--
-- La tanqueta mide en GALONES (280 gal): los controles de consumo convierten
-- a litros con eso cuando el despacho sale de una tanqueta.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS tanqueta_destino_id BIGINT,
  ADD COLUMN IF NOT EXISTS tanqueta_origen_id BIGINT;

ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_tanquetas NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_tanqueta_destino_fk'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_tanqueta_destino_fk
      FOREIGN KEY (tenant_id, tanqueta_destino_id) REFERENCES combustible_tanquetas (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_tanqueta_origen_fk'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_tanqueta_origen_fk
      FOREIGN KEY (tenant_id, tanqueta_origen_id) REFERENCES combustible_tanquetas (tenant_id, id);
  END IF;
END $$;

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_origen_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_origen_check
  CHECK (origen IN ('tanque_propio', 'compra_externa', 'excedente_recepcion', 'tanqueta'));

-- La tanqueta destino solo en un vale del tanque a "reserva en cubeta". Es
-- nullable: los vales a reserva anteriores a esta migración no dicen a cuál.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_tanqueta_destino_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_tanqueta_destino_check
  CHECK (
    tanqueta_destino_id IS NULL
    OR (origen = 'tanque_propio' AND tipo_destino = 'reserva_cubeta')
  );

-- La tanqueta origen va si y solo si el origen es 'tanqueta'.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_tanqueta_origen_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_tanqueta_origen_check
  CHECK ((origen = 'tanqueta') = (tanqueta_origen_id IS NOT NULL));

-- La forma completa de la carga en ruta, espejo del schema Zod: a una unidad,
-- con su medidor (uno solo), sin tanque, surtidor, contómetro, vale ni
-- comprobante.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_tanqueta_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_tanqueta_check
  CHECK (
    origen <> 'tanqueta' OR (
      producto = 'combustible'
      AND combustible_id IS NULL
      AND grifo_id IS NULL
      AND tipo_combustible IS NOT NULL
      AND tipo_destino = 'equipo' AND equipo_id IS NOT NULL
      AND lectura_contometro IS NULL
      AND totalizador_lectura IS NULL
      AND surtidor_id IS NULL
      AND horas_abastecidas IS NULL
      AND ((lectura_horometro IS NOT NULL AND lectura_odometro IS NULL)
        OR (lectura_horometro IS NULL AND lectura_odometro IS NOT NULL))
      AND serie_talonario IS NULL AND n_vale IS NULL
      AND comprobante_tipo IS NULL AND comprobante_numero IS NULL AND comprobante_key IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_despachos_tanqueta_destino
  ON combustible_despachos (tenant_id, tanqueta_destino_id) WHERE tanqueta_destino_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_despachos_tanqueta_origen
  ON combustible_despachos (tenant_id, tanqueta_origen_id) WHERE tanqueta_origen_id IS NOT NULL;

-- La sede de la carga en ruta es la de la tanqueta (de donde salió el
-- combustible), igual que el vale del tanque toma la del tanque.
CREATE OR REPLACE FUNCTION copiar_grifo_despacho()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.equipo_grifo_interno_id IS NULL AND NEW.equipo_id IS NOT NULL THEN
    NEW.equipo_grifo_interno_id := grifo_de_equipo_en(NEW.equipo_id, NEW.despachado_en);
  END IF;
  IF NEW.grifo_interno_id IS NULL THEN
    IF NEW.origen = 'tanque_propio' AND NEW.combustible_id IS NOT NULL THEN
      NEW.grifo_interno_id := grifo_de_tanque_en(NEW.combustible_id, NEW.despachado_en);
    ELSIF NEW.origen = 'excedente_recepcion' AND NEW.tanque_excedente_id IS NOT NULL THEN
      NEW.grifo_interno_id := grifo_de_tanque_en(NEW.tanque_excedente_id, NEW.despachado_en);
    ELSIF NEW.origen = 'tanqueta' AND NEW.tanqueta_origen_id IS NOT NULL THEN
      NEW.grifo_interno_id := (SELECT t.grifo_interno_id FROM combustible_tanquetas t
                                WHERE t.id = NEW.tanqueta_origen_id);
    ELSE
      NEW.grifo_interno_id := NEW.equipo_grifo_interno_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- La alerta nueva: se cargó desde una tanqueta más de lo que el sistema cree
-- que tenía. Alerta y no bloqueo: los galones en ruta son estimados y un
-- despacho sin registrar es peor que uno marcado (la regla del módulo).
ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
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
    'lectura_anulada',
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
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso',
    'precinto_alterado', 'precinto_reemplazado',
    'equipo_de_otro_grifo',
    'sobrestock_recepcion',
    'lectura_anulada',
    'tanqueta_sobregirada'
  ));

ALTER TABLE combustible_tanquetas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
