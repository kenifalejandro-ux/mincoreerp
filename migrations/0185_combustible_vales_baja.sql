-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: VALES DADOS DE BAJA (tramos del talonario que no se usaron)
--
-- Cuando en el reporte de Talonarios aparece un tramo de vales que faltan (por ejemplo del 01302 al
-- 01304), la oficina puede darlo de baja: dejar escrito por qué esos números no tienen movimiento
-- (vale roto, perdido, mal llenado, u otro con detalle), quién lo dijo y cuándo. Es una explicación,
-- no un borrado: el kardex y las alertas siguen mostrando el salto tal como estaba.
--
-- Una fila es un rango de números de UNA serie. El reporte marca como «explicado» el tramo que cae
-- dentro de una baja; si después aparece un vale con uno de esos números, la baja queda guardada
-- pero ese número deja de contarse como faltante.
--
-- Aditiva. La FK a `usuarios` apunta a una tabla con FORCE RLS: se abre la ventana NO FORCE
-- (gotcha 0097) y se cierra al final.
--
-- EJECUTAR (después de 0184):
--   psql -d mincoreerp -f migrations/0185_combustible_vales_baja.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS combustible_vales_baja (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  serie      VARCHAR(20) NOT NULL CHECK (length(trim(serie)) > 0),
  desde      INTEGER NOT NULL CHECK (desde > 0),
  hasta      INTEGER NOT NULL,
  motivo     VARCHAR(20) NOT NULL
             CHECK (motivo IN ('roto', 'perdido', 'mal_llenado', 'otro')),
  detalle    VARCHAR(300),
  creado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (hasta >= desde),
  -- «Otro» no explica nada sin su detalle.
  CHECK (motivo <> 'otro' OR length(trim(COALESCE(detalle, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS idx_vales_baja_serie
  ON combustible_vales_baja (tenant_id, serie, desde);
-- Toda FK lleva índice (tests/db-index-coverage.test.ts).
CREATE INDEX IF NOT EXISTS idx_vales_baja_creado_por
  ON combustible_vales_baja (creado_por) WHERE creado_por IS NOT NULL;

ALTER TABLE combustible_vales_baja ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_vales_baja'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_vales_baja
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_vales_baja FORCE ROW LEVEL SECURITY;
