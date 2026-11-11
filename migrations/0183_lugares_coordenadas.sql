-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: COORDENADAS de cada lugar del catálogo de viajes
--
-- Cada lugar (origen, destino o parada) puede guardar su punto en el mapa: latitud y longitud en
-- grados decimales. Sirve para dibujar las rutas y la posición estimada de las unidades en el
-- mapa del Control TV, sin GPS real. Ambas son opcionales: un lugar sin punto sigue funcionando
-- igual y solo no aparece en el mapa.
--
-- Las dos van juntas o ninguna (no existe un lugar con latitud y sin longitud), y dentro del rango
-- del planeta. Aditiva y sin FK: no hace falta la ventana NO FORCE.
--
-- EJECUTAR (después de 0182):
--   psql -d mincoreerp -f migrations/0183_lugares_coordenadas.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_lugares
  ADD COLUMN IF NOT EXISTS latitud  NUMERIC(9, 6),
  ADD COLUMN IF NOT EXISTS longitud NUMERIC(9, 6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_lugares_punto_completo'
  ) THEN
    ALTER TABLE combustible_lugares
      ADD CONSTRAINT combustible_lugares_punto_completo
        CHECK ((latitud IS NULL) = (longitud IS NULL)),
      ADD CONSTRAINT combustible_lugares_punto_en_rango
        CHECK (latitud IS NULL OR (latitud BETWEEN -90 AND 90 AND longitud BETWEEN -180 AND 180));
  END IF;
END $$;
