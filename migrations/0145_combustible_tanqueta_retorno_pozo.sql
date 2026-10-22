-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: un retorno de tanqueta puede devolver su saldo al pozo (tanque)
--
-- Kenif (2026-10-22): al recibir la tanqueta de vuelta, el saldo que el grifero
-- validó puede volver al tanque. Esta migración solo prepara el dato; todavía
-- nada lo escribe (llega en la entrega siguiente), pero el nivel del tanque, el
-- kardex, los descuadres y el costo promedio ya lo leen.
--
-- Se amplía la tabla del retorno (0143) en vez de crear otra: un solo lugar
-- donde mirar qué pasó con el saldo.
--   · combustible_id        el tanque que recibe
--   · cantidad_pozo         lo que entra, en la unidad DEL TANQUE (gal o L)
--   · costo_unitario_pozo   el costo con que entra, por unidad del tanque
-- Un retorno al pozo lleva las tres; uno a reserva, ninguna.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_tanqueta_retornos
  ADD COLUMN IF NOT EXISTS combustible_id      INTEGER,
  ADD COLUMN IF NOT EXISTS cantidad_pozo       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS costo_unitario_pozo NUMERIC(10,4);

-- La FK nueva se valida contra las filas existentes con una consulta que SÍ
-- pasa por RLS, y acá no hay app.tenant_id de sesión: va dentro de la ventana
-- NO FORCE (ver el gotcha de 0097).
ALTER TABLE combustible_tanqueta_retornos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tanqueta_retornos_combustible_fk'
  ) THEN
    ALTER TABLE combustible_tanqueta_retornos
      ADD CONSTRAINT tanqueta_retornos_combustible_fk
      FOREIGN KEY (combustible_id) REFERENCES combustible (id);
  END IF;

  -- El CHECK de 0143 admitía solo 'reserva'.
  ALTER TABLE combustible_tanqueta_retornos
    DROP CONSTRAINT IF EXISTS combustible_tanqueta_retornos_destino_check;
  ALTER TABLE combustible_tanqueta_retornos
    ADD CONSTRAINT combustible_tanqueta_retornos_destino_check
    CHECK (destino IN ('reserva', 'pozo'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tanqueta_retornos_pozo_check'
  ) THEN
    ALTER TABLE combustible_tanqueta_retornos
      ADD CONSTRAINT tanqueta_retornos_pozo_check
      CHECK (
        CASE destino
          WHEN 'pozo' THEN combustible_id IS NOT NULL
                       AND cantidad_pozo IS NOT NULL AND cantidad_pozo > 0
                       AND costo_unitario_pozo IS NOT NULL AND costo_unitario_pozo >= 0
          ELSE combustible_id IS NULL
               AND cantidad_pozo IS NULL AND costo_unitario_pozo IS NULL
        END
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tanqueta_retorno_pozo_tanque
  ON combustible_tanqueta_retornos (tenant_id, combustible_id, creado_en)
  WHERE destino = 'pozo';
CREATE INDEX IF NOT EXISTS idx_tanqueta_retorno_combustible
  ON combustible_tanqueta_retornos (combustible_id) WHERE combustible_id IS NOT NULL;

ALTER TABLE combustible_tanqueta_retornos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible FORCE ROW LEVEL SECURITY;
