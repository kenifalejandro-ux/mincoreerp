-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: retorno de una tanqueta que vuelve al grifo con saldo
--
-- Kenif (2026-10-21): una tanqueta sale con, p. ej., 200 gal a la línea
-- amarilla y la unidad usa 190. Al volver, el grifero registra el retorno: ve
-- el saldo que calcula el sistema (10 gal), escribe cuánto volvió de verdad y,
-- si es otra cifra, explica por qué (derrame, evaporación, estimación).
--
-- Una fila por retorno. `diferencia` (validado - calculado) con signo entra al
-- saldo de la tanqueta como un ajuste: así el saldo derivado (entradas menos
-- salidas) sigue siendo la única fuente y refleja lo que el grifero validó.
-- `destino` solo admite 'reserva' por ahora (el saldo queda en la tanqueta,
-- sin unidad); los otros destinos llegan en las entregas siguientes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_tanqueta_retornos (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tanqueta_id      BIGINT NOT NULL,
  equipo_id        INTEGER NOT NULL REFERENCES equipos(id),
  saldo_calculado  NUMERIC(14,2) NOT NULL CHECK (saldo_calculado > 0),
  saldo_validado   NUMERIC(14,2) NOT NULL CHECK (saldo_validado >= 0),
  diferencia       NUMERIC(14,2) GENERATED ALWAYS AS (saldo_validado - saldo_calculado) STORED,
  motivo           VARCHAR(500),
  destino          VARCHAR(20) NOT NULL DEFAULT 'reserva' CHECK (destino IN ('reserva')),
  usuario_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, tanqueta_id) REFERENCES combustible_tanquetas (tenant_id, id),
  -- Una diferencia sin explicación no se guarda.
  CHECK (saldo_validado = saldo_calculado OR length(trim(coalesce(motivo, ''))) >= 3)
);

CREATE INDEX IF NOT EXISTS idx_tanqueta_retorno_tanqueta
  ON combustible_tanqueta_retornos (tenant_id, tanqueta_id, creado_en);
CREATE INDEX IF NOT EXISTS idx_tanqueta_retorno_equipo
  ON combustible_tanqueta_retornos (tenant_id, equipo_id);
CREATE INDEX IF NOT EXISTS idx_tanqueta_retorno_usuario
  ON combustible_tanqueta_retornos (usuario_id) WHERE usuario_id IS NOT NULL;

ALTER TABLE combustible_tanqueta_retornos ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_tanqueta_retornos'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_tanqueta_retornos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

ALTER TABLE combustible_tanqueta_retornos FORCE ROW LEVEL SECURITY;
