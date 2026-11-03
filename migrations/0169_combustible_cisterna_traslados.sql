-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: pasar lo que queda en la cisterna AL TANQUE
--
-- Lo que se dejó en la cisterna (0168) se puede pasar al tanque cuando el
-- tanque tiene espacio. Es una ENTRADA al tanque que NO es una compra, igual
-- que el saldo de una tanqueta que vuelve al pozo (0145):
--
--   - suma al nivel teórico, al kardex y al costo promedio (con el costo de la
--     factura de la recepción original);
--   - NO abre un ciclo de calibración, NO cuenta como una entrega más en la
--     diferencia de una recepción, NO pide documento ni validación contra la
--     guía. Por eso es una tabla propia y no una recepción "hija": una
--     recepción hija pasaría por todos esos controles como si fuera una compra.
--
-- Entra al módulo por `ENTRADAS_NIVEL` (la misma vista que ya une recepciones
-- y retornos al pozo), con `es_recepcion = false`.
--
-- Saldo de la cisterna = cantidad de la línea - despachos vigentes que la
-- apuntan - traslados al tanque. No hay anulación: un error se corrige con una
-- lectura de varilla, como con el retorno al pozo.
--
-- `cantidad` está en la unidad del tanque (el traslado solo va a un tanque de
-- la misma sede, mismo producto y misma unidad que el de la recepción).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_cisterna_traslados (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  linea_id        BIGINT NOT NULL
                  REFERENCES combustible_recepcion_excedentes(id) ON DELETE CASCADE,
  combustible_id  INTEGER NOT NULL REFERENCES combustible(id) ON DELETE CASCADE,
  cantidad        NUMERIC(14,2) NOT NULL CHECK (cantidad > 0),
  costo_unitario  NUMERIC(10,4) NOT NULL CHECK (costo_unitario >= 0),
  usuario_id      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un índice por cada FK (el gate db-index-coverage lo exige) y el que usa el
-- nivel teórico del tanque.
CREATE INDEX IF NOT EXISTS idx_cisterna_traslados_linea
  ON combustible_cisterna_traslados (tenant_id, linea_id);
CREATE INDEX IF NOT EXISTS idx_cisterna_traslados_tanque
  ON combustible_cisterna_traslados (tenant_id, combustible_id, creado_en);
CREATE INDEX IF NOT EXISTS idx_cisterna_traslados_combustible
  ON combustible_cisterna_traslados (combustible_id);
CREATE INDEX IF NOT EXISTS idx_cisterna_traslados_usuario
  ON combustible_cisterna_traslados (usuario_id) WHERE usuario_id IS NOT NULL;

ALTER TABLE combustible_cisterna_traslados ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_cisterna_traslados FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_cisterna_traslados'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_cisterna_traslados
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
