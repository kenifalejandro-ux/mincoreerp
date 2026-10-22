-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: un retorno de tanqueta puede pasar su saldo a otra tanqueta
--
-- Kenif (2026-10-22): al recibir la tanqueta de vuelta, el saldo que el grifero
-- validó puede pasar a otra tanqueta de la misma sede con espacio libre. Se
-- amplía la tabla del retorno (0143/0145), igual que con el pozo:
--   · tanqueta_destino_id      la tanqueta que recibe
--   · costo_unitario_tanqueta  el costo por galón con que viaja el saldo (el de
--                              la tanqueta de origen); la que recibe lo mezcla
--                              con el suyo
-- La cantidad que pasa es `saldo_validado` (las dos miden en galones).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_tanqueta_retornos
  ADD COLUMN IF NOT EXISTS tanqueta_destino_id     BIGINT,
  ADD COLUMN IF NOT EXISTS costo_unitario_tanqueta NUMERIC(10,4);

-- La FK nueva se valida contra las filas existentes con una consulta que SÍ
-- pasa por RLS, y acá no hay app.tenant_id de sesión: va dentro de la ventana
-- NO FORCE (ver el gotcha de 0097).
ALTER TABLE combustible_tanqueta_retornos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_tanquetas NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tanqueta_retornos_tanqueta_destino_fk'
  ) THEN
    ALTER TABLE combustible_tanqueta_retornos
      ADD CONSTRAINT tanqueta_retornos_tanqueta_destino_fk
      FOREIGN KEY (tenant_id, tanqueta_destino_id) REFERENCES combustible_tanquetas (tenant_id, id);
  END IF;

  ALTER TABLE combustible_tanqueta_retornos
    DROP CONSTRAINT IF EXISTS combustible_tanqueta_retornos_destino_check;
  ALTER TABLE combustible_tanqueta_retornos
    ADD CONSTRAINT combustible_tanqueta_retornos_destino_check
    CHECK (destino IN ('reserva', 'pozo', 'tanqueta'));

  -- Una tanqueta no se pasa a sí misma; solo este destino lleva sus dos datos.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tanqueta_retornos_traslado_check'
  ) THEN
    ALTER TABLE combustible_tanqueta_retornos
      ADD CONSTRAINT tanqueta_retornos_traslado_check
      CHECK (
        CASE destino
          WHEN 'tanqueta' THEN tanqueta_destino_id IS NOT NULL
                           AND tanqueta_destino_id <> tanqueta_id
                           AND costo_unitario_tanqueta IS NOT NULL
                           AND costo_unitario_tanqueta >= 0
          ELSE tanqueta_destino_id IS NULL AND costo_unitario_tanqueta IS NULL
        END
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tanqueta_retorno_tanqueta_destino
  ON combustible_tanqueta_retornos (tenant_id, tanqueta_destino_id)
  WHERE tanqueta_destino_id IS NOT NULL;

ALTER TABLE combustible_tanqueta_retornos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_tanquetas FORCE ROW LEVEL SECURITY;
