-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el DESPACHO de un excedente cargado directo de la cisterna
--
-- Cuando una recepción no cabe en el tanque, parte del excedente puede ir
-- "directo a unidades" (0110): la cisterna le carga a una unidad sin pasar por
-- el tanque. Esa línea quedaba registrada en el reparto, pero NO era un
-- despacho: sin vale, sin horómetro, fuera del consumo de la unidad. Y si
-- alguien lo cargaba como despacho del tanque, se descontaba de un tanque que
-- nunca tuvo esos litros (lo vio Kenif probando, 2026-10-04).
--
-- Ahora la línea queda PENDIENTE y se regulariza con un despacho de origen
-- nuevo, 'excedente_recepcion':
--   - lleva vale del talonario (la secuencia de la empresa no queda con
--     huecos) y el medidor de la unidad (cuenta en su consumo);
--   - NO tiene combustible_id: no descuenta de ningún tanque, porque ese
--     combustible nunca entró a uno;
--   - `tanque_excedente_id` es el tanque de la recepción: SOLO para saber la
--     unidad de `cantidad` (gal/L) en los controles de consumo y para la sede.
--     El kardex filtra por combustible_id y no lo ve, que es lo correcto.
--   - `excedente_linea_id` apunta a la línea del reparto: una línea, un
--     despacho vigente (si se anula el despacho, la línea vuelve a pendiente).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS excedente_linea_id BIGINT,
  ADD COLUMN IF NOT EXISTS tanque_excedente_id INTEGER;

-- FKs nuevas sobre tablas con FORCE RLS: dentro de la ventana NO FORCE (gotcha
-- de 0097: la validación inicial de la FK pasa por la política).
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepcion_excedentes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_excedente_linea_fk'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_excedente_linea_fk
      FOREIGN KEY (excedente_linea_id) REFERENCES combustible_recepcion_excedentes (id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_tanque_excedente_fk'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_tanque_excedente_fk
      FOREIGN KEY (tanque_excedente_id) REFERENCES combustible (id);
  END IF;
END $$;

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_origen_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_origen_check
  CHECK (origen IN ('tanque_propio', 'compra_externa', 'excedente_recepcion'));

-- Las dos columnas nuevas van juntas y solo en este origen.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_excedente_columnas_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_excedente_columnas_check
  CHECK (
    (origen = 'excedente_recepcion')
      = (excedente_linea_id IS NOT NULL AND tanque_excedente_id IS NOT NULL)
    AND (excedente_linea_id IS NULL) = (tanque_excedente_id IS NULL)
  );

-- La forma completa, espejo del schema Zod: combustible a una unidad, con
-- vale, sin tanque ni surtidor ni contómetro ni comprobante de proveedor.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_excedente_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_excedente_check
  CHECK (
    origen <> 'excedente_recepcion' OR (
      producto = 'combustible'
      AND combustible_id IS NULL
      AND grifo_id IS NULL
      AND tipo_combustible IS NOT NULL
      AND tipo_destino = 'equipo' AND equipo_id IS NOT NULL
      AND lectura_contometro IS NULL
      AND totalizador_lectura IS NULL
      AND surtidor_id IS NULL
      AND horas_abastecidas IS NULL
      AND (lectura_horometro IS NULL OR lectura_odometro IS NULL)
      AND serie_talonario IS NOT NULL AND n_vale IS NOT NULL
      AND comprobante_tipo IS NULL AND comprobante_numero IS NULL AND comprobante_key IS NULL
    )
  );

-- Una línea del reparto, un solo despacho VIGENTE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_despachos_excedente_linea_vigente
  ON combustible_despachos (excedente_linea_id)
  WHERE excedente_linea_id IS NOT NULL AND anulada_en IS NULL;
CREATE INDEX IF NOT EXISTS idx_despachos_tanque_excedente
  ON combustible_despachos (tanque_excedente_id) WHERE tanque_excedente_id IS NOT NULL;

-- La sede del despacho de excedente es la del tanque de la recepción (la
-- cisterna descargó ahí), no la del equipo. Misma función de 0097, con una
-- rama más.
CREATE OR REPLACE FUNCTION copiar_grifo_despacho()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.equipo_grifo_interno_id IS NULL AND NEW.equipo_id IS NOT NULL THEN
    NEW.equipo_grifo_interno_id := grifo_de_equipo_en(NEW.equipo_id, NEW.despachado_en);
  END IF;
  IF NEW.grifo_interno_id IS NULL THEN
    -- Del tanque propio: el grifo de donde salió el combustible. Compra
    -- externa y urea no salen de ningún grifo propio: quedan en el del equipo.
    IF NEW.origen = 'tanque_propio' AND NEW.combustible_id IS NOT NULL THEN
      NEW.grifo_interno_id := grifo_de_tanque_en(NEW.combustible_id, NEW.despachado_en);
    ELSIF NEW.origen = 'excedente_recepcion' AND NEW.tanque_excedente_id IS NOT NULL THEN
      NEW.grifo_interno_id := grifo_de_tanque_en(NEW.tanque_excedente_id, NEW.despachado_en);
    ELSE
      NEW.grifo_interno_id := NEW.equipo_grifo_interno_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE combustible FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepcion_excedentes FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
