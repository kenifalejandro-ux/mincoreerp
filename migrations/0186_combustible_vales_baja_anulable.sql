-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: DESHACER UNA REGULARIZACIÓN DE VALES
--
-- La 0185 guarda cada regularización de vales del talonario (un rango de números, con su motivo, quién
-- y cuándo). Si alguien se equivoca de vale, o aparece el papel que sí despachó combustible, tiene que
-- poder deshacerla. No se borra nada: la fila queda marcada como anulada, con quién la deshizo, cuándo
-- y por qué, y el reporte solo cuenta las que siguen vigentes.
--
-- Si se deshace solo una parte de un rango, la fila original se anula y el resto se guarda como filas
-- nuevas con el mismo motivo, detalle, autor y fecha (lo hace el servidor).
--
-- Aditiva. La FK nueva apunta a `usuarios`, que tiene FORCE RLS: se abre la ventana NO FORCE
-- (gotcha 0097) y se cierra al final.
--
-- EJECUTAR (después de 0185):
--   psql -d mincoreerp -f migrations/0186_combustible_vales_baja_anulable.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_vales_baja NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_vales_baja
  ADD COLUMN IF NOT EXISTS anulada_en       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anulada_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS motivo_anulacion VARCHAR(300);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_vales_baja_anulacion_check'
  ) THEN
    ALTER TABLE combustible_vales_baja
      ADD CONSTRAINT combustible_vales_baja_anulacion_check
      CHECK (
        -- Vigente: sin datos de anulación. Anulada: con fecha y con su motivo (el autor puede
        -- quedar vacío si el usuario se borra después).
        (anulada_en IS NULL AND anulada_por IS NULL AND motivo_anulacion IS NULL)
        OR (anulada_en IS NOT NULL AND length(trim(COALESCE(motivo_anulacion, ''))) > 0)
      );
  END IF;
END $$;

-- Toda FK lleva índice (tests/db-index-coverage.test.ts).
CREATE INDEX IF NOT EXISTS idx_vales_baja_anulada_por
  ON combustible_vales_baja (anulada_por) WHERE anulada_por IS NOT NULL;
-- Las consultas del reporte solo miran las vigentes.
CREATE INDEX IF NOT EXISTS idx_vales_baja_vigentes
  ON combustible_vales_baja (tenant_id, serie, desde) WHERE anulada_en IS NULL;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_vales_baja FORCE ROW LEVEL SECURITY;
