-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: planes de mantenimiento preventivo (M9)
--
-- Un plan por TIPO de equipo (texto, como `equipos.tipo`; se compara sin mayúsculas ni espacios de más):
--   medida       con qué se cuenta: horómetro (horas) u odómetro (km)
--   intervalo    cada cuánto toca un servicio
--   aviso_antes  cuánto antes se avisa que está «Próximo» (editable por plan)
--   ciclo        la secuencia de niveles que se repite, p. ej. {1,2,1,3} = MP1, MP2, MP1, MP3
--   niveles      por cada nivel del ciclo, sus tareas nuevas y sus repuestos sugeridos (texto):
--                {"1": {"tareas": [...], "repuestos": [...]}, ...}. Objeto y no arreglo: así viaja bien en el
--                respaldo.
--   version      sube en cada guardado: quien edita sobre una versión vieja recibe un 409.
--
-- Esta entrega solo guarda planes; el próximo servicio se calcula (no se guarda) en la siguiente.
-- Aditiva e idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mantenimiento_planes (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo_equipo     VARCHAR(60) NOT NULL CHECK (btrim(tipo_equipo) <> ''),
  medida          VARCHAR(10) NOT NULL CHECK (medida IN ('horometro', 'odometro')),
  intervalo       INTEGER NOT NULL CHECK (intervalo BETWEEN 1 AND 1000000),
  aviso_antes     INTEGER NOT NULL CHECK (aviso_antes >= 0),
  ciclo           SMALLINT[] NOT NULL CHECK (
                    cardinality(ciclo) BETWEEN 1 AND 12 AND ciclo <@ ARRAY[1, 2, 3]::smallint[]
                  ),
  niveles         JSONB NOT NULL CHECK (jsonb_typeof(niveles) = 'object'),
  version         INTEGER NOT NULL DEFAULT 1,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT mantenimiento_planes_aviso_menor CHECK (aviso_antes < intervalo)
);

-- Un plan por tipo en cada empresa (también sirve de índice de la FK a tenants).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mantenimiento_planes_tipo
  ON mantenimiento_planes (tenant_id, lower(btrim(tipo_equipo)));
CREATE INDEX IF NOT EXISTS idx_mantenimiento_planes_creado_por
  ON mantenimiento_planes (creado_por) WHERE creado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mantenimiento_planes_actualizado_por
  ON mantenimiento_planes (actualizado_por) WHERE actualizado_por IS NOT NULL;

ALTER TABLE mantenimiento_planes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mantenimiento_planes FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'mantenimiento_planes' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON mantenimiento_planes
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
