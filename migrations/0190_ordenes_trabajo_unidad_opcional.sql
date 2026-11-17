-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: ÓRDENES DE TRABAJO CON UNIDAD OPCIONAL
--
-- Hasta aquí toda orden de trabajo tenía que ser sobre una unidad (`ordenes_trabajo.equipo_id`
-- NOT NULL, 0049): una empresa sin Registro de unidades (Flota) no podía abrir ninguna, y una
-- orden sobre algo que no es una unidad (la faja del horno 4, una fuga de agua del campamento)
-- obligaba a inventar una «unidad».
--
-- Ahora la orden se identifica por UNA de dos cosas, o por las dos:
--   · `equipo_id`    — la unidad de Flota (opcional; solo si la empresa tiene Flota).
--   · `activo_texto` — texto libre: «Horno 4, faja transportadora», «Campamento» (nuevo).
-- El CHECK exige al menos una: una orden sin saber sobre qué es no sirve.
--
-- Las órdenes que ya existen no cambian: todas tienen su unidad. La unidad sigue siendo
-- inmutable después de crear (el PUT no la acepta); el texto sí se puede corregir.
--
-- No toca FK ni policy: `equipo_id` conserva su FK a `equipos` y la tabla sigue con FORCE RLS;
-- no hace falta ventana NO FORCE (misma situación que 0189 en checklists). Esta tabla no está
-- particionada.
--
-- Precedentes en el mismo repo: `ipercs.equipo_id` (opcional junto a `area_frente`) y
-- `checklists.equipo_id` + `activo_texto` (0189).
--
-- Aditiva e idempotente.
--
-- EJECUTAR (después de 0189):
--   psql -d mincoreerp -f migrations/0190_ordenes_trabajo_unidad_opcional.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ordenes_trabajo ADD COLUMN IF NOT EXISTS activo_texto VARCHAR(150);

ALTER TABLE ordenes_trabajo ALTER COLUMN equipo_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ordenes_trabajo'::regclass
      AND conname = 'ordenes_trabajo_unidad_o_activo_check'
  ) THEN
    ALTER TABLE ordenes_trabajo
      ADD CONSTRAINT ordenes_trabajo_unidad_o_activo_check
      CHECK (equipo_id IS NOT NULL OR (activo_texto IS NOT NULL AND btrim(activo_texto) <> ''));
  END IF;
END $$;
