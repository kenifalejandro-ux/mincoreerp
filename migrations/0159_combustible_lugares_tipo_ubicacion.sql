-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: tipo y ubicación de los lugares de los viajes
--
-- El catálogo de lugares (0123) solo guardaba el nombre. Ahora cada lugar dice qué es
-- (mina, ciudad o punto de abastecimiento de combustible) y, opcionalmente, dónde queda.
--
-- `tipo` es nullable a propósito: los lugares que ya existen no tienen tipo y no se inventa uno.
-- La API lo acepta opcional; la pantalla de Lugares es la que lo exige en el alta.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_lugares
  ADD COLUMN IF NOT EXISTS tipo      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ubicacion VARCHAR(120);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_lugares_tipo_check'
  ) THEN
    ALTER TABLE combustible_lugares
      ADD CONSTRAINT combustible_lugares_tipo_check
      CHECK (tipo IS NULL OR tipo IN ('mina', 'ciudad', 'abastecimiento'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_lugares_ubicacion_check'
  ) THEN
    ALTER TABLE combustible_lugares
      ADD CONSTRAINT combustible_lugares_ubicacion_check
      CHECK (ubicacion IS NULL OR length(trim(ubicacion)) > 0);
  END IF;
END $$;
