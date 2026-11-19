-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el excedente de la recepción a una unidad ESCRITA A MANO
--
-- Autonomía de Combustible (ver 0176 para el vale del tanque, 0192 para urea y tanqueta): una
-- empresa sin Flota, o con una unidad que la oficina aún no registró, escribe la placa. El
-- excedente que la cisterna deja o reparte a una unidad también.
--
-- Dos formas de llegar al vale de excedente a una unidad:
--   · Línea de reparto con destino 'equipo' (0110): se decide al recibir quién se lleva ese
--     excedente y el vale la regulariza. La línea guardaba `equipo_id`; ahora puede guardar la
--     placa escrita (`placa_sin_alta`). La unidad de la línea es UNA de las dos, nunca las dos.
--   · Salida de lo que quedó en la cisterna (0168): la línea no lleva unidad; la unidad la elige el
--     vale. Aquí solo hay que dejar que el vale admita la unidad escrita.
--
-- Solo se RELAJAN dos CHECK y se agrega una columna: toda fila que existe hoy los cumple, no hay
-- datos que migrar. El resto de cada forma queda igual.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. La línea del reparto ─────────────────────────────────────────────────

ALTER TABLE combustible_recepcion_excedentes ADD COLUMN IF NOT EXISTS placa_sin_alta VARCHAR(20);

-- El CHECK de 0110 era anónimo: Postgres lo nombró así.
ALTER TABLE combustible_recepcion_excedentes
  DROP CONSTRAINT IF EXISTS combustible_recepcion_excedentes_check;
ALTER TABLE combustible_recepcion_excedentes
  DROP CONSTRAINT IF EXISTS combustible_recepcion_excedentes_unidad_check;
ALTER TABLE combustible_recepcion_excedentes
  ADD CONSTRAINT combustible_recepcion_excedentes_unidad_check
  CHECK (
    -- Solo el destino 'equipo' lleva unidad: la registrada o la escrita, nunca las dos.
    (destino = 'equipo') = (equipo_id IS NOT NULL OR placa_sin_alta IS NOT NULL)
    AND (equipo_id IS NULL OR placa_sin_alta IS NULL)
    AND (placa_sin_alta IS NULL OR placa_sin_alta ~ '^[A-Z0-9]{3,20}$')
  );

-- ── 2. El vale que regulariza o reparte el excedente ───────────────────────

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_excedente_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_excedente_check
  CHECK (
    origen <> 'excedente_recepcion' OR (
      producto = 'combustible'
      AND combustible_id IS NULL
      AND grifo_id IS NULL
      AND tipo_combustible IS NOT NULL
      AND lectura_contometro IS NULL
      AND totalizador_lectura IS NULL
      AND surtidor_id IS NULL
      AND horas_abastecidas IS NULL
      AND comprobante_tipo IS NULL AND comprobante_numero IS NULL AND comprobante_key IS NULL
      AND (
        (
          -- A una unidad: la registrada o la escrita a mano (0176), con vale y a lo sumo un medidor.
          ((tipo_destino = 'equipo' AND equipo_id IS NOT NULL)
            OR (tipo_destino = 'unidad_sin_alta' AND equipo_id IS NULL))
          AND tanqueta_destino_id IS NULL
          AND (lectura_horometro IS NULL OR lectura_odometro IS NULL)
          AND serie_talonario IS NOT NULL AND n_vale IS NOT NULL
        ) OR (
          tipo_destino = 'reserva_cubeta' AND equipo_id IS NULL
          AND tanqueta_destino_id IS NOT NULL
          AND lectura_horometro IS NULL AND lectura_odometro IS NULL
          AND (serie_talonario IS NULL) = (n_vale IS NULL)
        )
      )
    )
  );
