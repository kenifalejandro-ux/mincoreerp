-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: se quita "cuenta_como" de los viajes
--
-- "cuenta_como" (0123) dividía lo cargado entre un número para que una empresa
-- pudiera contar ida y vuelta como un solo viaje. Desde el recorrido con paradas
-- (0148) un viaje de ida y vuelta ES un viaje: su consumo se reparte por tramo
-- con la hora de cada llegada, y los promedios comparan viajes con el MISMO
-- recorrido. El número ya no divide nada y el campo se borra.
--
-- Todos los viajes existentes valían 1 o eran de prueba: no se pierde historia.
-- Es difícil de deshacer (el valor se pierde), por eso va en su propia migración.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_viajes DROP COLUMN IF EXISTS cuenta_como;
