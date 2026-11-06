-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el grifero devuelve al tanque (pozo) lo que sobra de una tanqueta
-- que NO va con ninguna unidad.
--
-- Hasta ahora el saldo solo volvía al pozo al recibir la tanqueta de una unidad
-- (0145), así que cada retorno tenía su `equipo_id`. Una devolución desde el grifo
-- no viene de ninguna unidad: se guarda en la MISMA tabla (para que el nivel del
-- tanque, su kardex y el costo promedio la cuenten igual que a las demás) con
-- `equipo_id` NULL.
--
-- El CHECK deja el hueco solo donde corresponde: sin unidad solo cabe el destino
-- 'pozo'. Un retorno a reserva, a otra tanqueta o a otra unidad sigue exigiendo la
-- unidad de la que vuelve.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_tanqueta_retornos
  ALTER COLUMN equipo_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tanqueta_retornos_equipo_check'
  ) THEN
    ALTER TABLE combustible_tanqueta_retornos
      ADD CONSTRAINT tanqueta_retornos_equipo_check
      CHECK (equipo_id IS NOT NULL OR destino = 'pozo');
  END IF;
END $$;
