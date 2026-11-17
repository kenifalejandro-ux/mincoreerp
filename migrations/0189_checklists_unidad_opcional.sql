-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: CHECKLISTS CON UNIDAD OPCIONAL
--
-- Hasta aquí todo checklist tenía que ser de una unidad (`checklists.equipo_id` NOT NULL, 0006):
-- una empresa sin Registro de unidades (Flota) no podía llenar ninguno, y un checklist de algo que
-- no es una unidad (un horno, un andamio, el campamento) obligaba a inventar una «unidad».
--
-- Ahora el checklist se identifica por UNA de dos cosas, o por las dos:
--   · `equipo_id`    — la unidad de Flota (opcional; solo si la empresa tiene Flota).
--   · `activo_texto` — texto libre: «Horno 4», «Andamio torre 3, Obra Norte» (nuevo).
-- El CHECK exige al menos una: un checklist sin saber de qué es no sirve.
--
-- Los checklists que ya existen no cambian: todos tienen su unidad.
--
-- `checklists` está particionada por RANGE(creado_en) (0037): ADD COLUMN, DROP NOT NULL y ADD
-- CONSTRAINT sobre la tabla padre se propagan a todas las particiones. No toca FK ni policy: no
-- hace falta ventana NO FORCE.
--
-- Precedente en el mismo repo: `ipercs.equipo_id` ya es opcional junto a `area_frente` (texto).
--
-- Aditiva e idempotente.
--
-- EJECUTAR (después de 0188):
--   psql -d mincoreerp -f migrations/0189_checklists_unidad_opcional.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE checklists ADD COLUMN IF NOT EXISTS activo_texto VARCHAR(150);

ALTER TABLE checklists ALTER COLUMN equipo_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'checklists'::regclass
      AND conname = 'checklists_unidad_o_activo_check'
  ) THEN
    ALTER TABLE checklists
      ADD CONSTRAINT checklists_unidad_o_activo_check
      CHECK (equipo_id IS NOT NULL OR (activo_texto IS NOT NULL AND btrim(activo_texto) <> ''));
  END IF;
END $$;
