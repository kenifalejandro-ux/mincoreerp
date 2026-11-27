-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: servicios de preventivo realizados (M9)
--
-- Lo que se le hizo a cada equipo: con esto y la lectura del medidor se CALCULA el próximo servicio (no se
-- guarda).
--   nivel / paso   qué MP se hizo y en qué posición del ciclo del plan (empieza en 0)
--   medida/lectura cuánto marcaba el medidor al hacerlo
--   lectura_id     la lectura del medidor que dejó este servicio (equipo_lecturas, tabla base)
--
-- Un servicio no se reescribe ni se borra: se ANULA con motivo. Aditiva e idempotente. Las FK nuevas apuntan a
-- tablas con FORCE RLS: se abre la ventana NO FORCE (como en la 0187) y se cierra al final.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE equipos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE equipo_lecturas NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS mantenimiento_servicios (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  equipo_id        INTEGER NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
  nivel            SMALLINT NOT NULL CHECK (nivel BETWEEN 1 AND 3),
  paso             SMALLINT NOT NULL CHECK (paso BETWEEN 0 AND 11),
  medida           VARCHAR(10) NOT NULL CHECK (medida IN ('horometro', 'odometro')),
  lectura          NUMERIC(12,2) NOT NULL CHECK (lectura >= 0),
  lectura_id       BIGINT REFERENCES equipo_lecturas(id) ON DELETE SET NULL,
  hecho_en         TIMESTAMPTZ NOT NULL,
  observacion      TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  anulado_en       TIMESTAMPTZ,
  anulado_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_anulacion TEXT CHECK (motivo_anulacion IS NULL OR length(trim(motivo_anulacion)) > 0),
  CONSTRAINT mantenimiento_servicios_anulado CHECK ((anulado_en IS NULL) = (motivo_anulacion IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_mantenimiento_servicios_tenant
  ON mantenimiento_servicios (tenant_id, equipo_id, hecho_en DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mantenimiento_servicios_equipo
  ON mantenimiento_servicios (equipo_id);
CREATE INDEX IF NOT EXISTS idx_mantenimiento_servicios_lectura
  ON mantenimiento_servicios (lectura_id) WHERE lectura_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mantenimiento_servicios_creado_por
  ON mantenimiento_servicios (creado_por) WHERE creado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mantenimiento_servicios_anulado_por
  ON mantenimiento_servicios (anulado_por) WHERE anulado_por IS NOT NULL;

ALTER TABLE mantenimiento_servicios ENABLE ROW LEVEL SECURITY;
ALTER TABLE mantenimiento_servicios FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'mantenimiento_servicios' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON mantenimiento_servicios
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

ALTER TABLE equipo_lecturas FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE equipos FORCE ROW LEVEL SECURITY;
