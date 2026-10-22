-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la asignación de una tanqueta a una unidad lleva su CANTIDAD
--
-- Kenif (2026-10-21): el vale de la asignación es como una "tanqueada" a la
-- unidad, así que debe decir cuánto combustible lleva. Es lo que la tanqueta
-- tenía al asignarla (el saldo que calcula el sistema) y sirve de base para
-- cuadrar el vale cuando la tanqueta vuelva al grifo.
--
-- Nullable: las asignaciones anteriores (0141) no la guardaron y no se
-- inventa un número para ellas.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_tanqueta_asignaciones
  ADD COLUMN IF NOT EXISTS cantidad NUMERIC(14,2) CHECK (cantidad > 0);
