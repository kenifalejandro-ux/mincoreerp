-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la HORA PROGRAMADA de salida de un viaje y su tolerancia de desfase
--
-- Hoy un viaje programado no guarda cuándo debería salir: la hora real la pone el servidor al
-- iniciarlo. Con la hora programada (opcional) se puede decir "salió 10 min tarde" o "salió antes".
-- La tolerancia es cuántos minutos de diferencia se aceptan antes de marcarlo (10 por defecto,
-- la fija la oficina al programar).
--
-- Dos columnas sin claves foráneas: no hace falta la ventana NO FORCE de 0097.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_viajes
  ADD COLUMN IF NOT EXISTS salida_programada_en TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS desfase_tolerancia_min SMALLINT NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_viaje_desfase_tolerancia'
  ) THEN
    ALTER TABLE combustible_viajes
      ADD CONSTRAINT chk_viaje_desfase_tolerancia
      CHECK (desfase_tolerancia_min BETWEEN 0 AND 240);
  END IF;
END $$;
