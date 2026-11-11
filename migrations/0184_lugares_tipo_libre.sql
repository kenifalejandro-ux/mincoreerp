-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el tipo de un lugar de los viajes es libre
--
-- La 0159 limitaba `tipo` a mina, ciudad o abastecimiento. Ahora la persona puede escribir el tipo
-- que quiera («Planta», «Puerto») o dejarlo vacío. Se guarda en minúsculas y sin espacios de más (lo
-- normaliza el servidor); la base solo exige que no sea un texto en blanco.
--
-- Solo se afloja una regla y se agranda una columna: los datos que ya existen no cambian.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_lugares
  ALTER COLUMN tipo TYPE VARCHAR(30);

ALTER TABLE combustible_lugares
  DROP CONSTRAINT IF EXISTS combustible_lugares_tipo_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_lugares_tipo_libre_check'
  ) THEN
    ALTER TABLE combustible_lugares
      ADD CONSTRAINT combustible_lugares_tipo_libre_check
      CHECK (tipo IS NULL OR length(trim(tipo)) > 0);
  END IF;
END $$;
