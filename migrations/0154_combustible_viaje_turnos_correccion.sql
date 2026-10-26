-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: CORREGIR UN CAMBIO DE MANDO a posteriori (oficina)
--
-- Si titular y relevo se cambiaron el volante y nadie lo marcó, la oficina parte el turno de esa
-- hora en dos. El turno que nace de la corrección guarda quién la hizo, cuándo y por qué
-- (motivo obligatorio): es una acción correctiva y debe poder auditarse.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Ventana NO FORCE (gotcha de 0097): la FK nueva lee una tabla con FORCE RLS ─────────────────
ALTER TABLE combustible_viaje_turnos NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_viaje_turnos
  ADD COLUMN IF NOT EXISTS corregido_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS corregido_en TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS corregido_motivo VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_viaje_turno_correccion_con_motivo'
  ) THEN
    ALTER TABLE combustible_viaje_turnos
      ADD CONSTRAINT chk_viaje_turno_correccion_con_motivo
      CHECK (corregido_en IS NULL OR corregido_motivo IS NOT NULL);
  END IF;
END $$;

-- La FK hacia usuarios la usa el borrado de un usuario (SET NULL).
CREATE INDEX IF NOT EXISTS idx_viaje_turnos_corregido_por
  ON combustible_viaje_turnos (corregido_por) WHERE corregido_por IS NOT NULL;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────

ALTER TABLE combustible_viaje_turnos FORCE ROW LEVEL SECURITY;
