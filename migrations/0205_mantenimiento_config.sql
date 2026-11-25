-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: configuración del ecosistema «Gestión de mantenimiento» (M2)
--
-- Reglas operativas (cuatro interruptores) y metas del área (cuatro números) que cada empresa decide. Esta
-- entrega solo las GUARDA: las reglas todavía no actúan (se aplican en el módulo dueño de cada flujo cuando
-- Órdenes de trabajo, Preventivo e IPERC entren al ecosistema) y las metas se comparan cuando existan los
-- indicadores. El presupuesto no va aquí: llega con los costos.
--
-- UNA fila por empresa, sin sembrar ninguna: la empresa que nunca guardó usa los valores por defecto, que el
-- servicio devuelve al leer (CONFIG_POR_DEFECTO en mantenimiento.service.ts; un test comprueba que coinciden
-- con los DEFAULT de abajo). `id` serial + UNIQUE(tenant_id), y no tenant_id como clave primaria, porque el
-- respaldo y la restauración asumen que cada tabla de módulo tiene su `id` (mismo patrón que combustible_config).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mantenimiento_config (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

  -- Reglas operativas
  ot_de_hallazgo      BOOLEAN NOT NULL DEFAULT true,
  bloquea_sin_iperc   BOOLEAN NOT NULL DEFAULT true,
  alerta_repuestos    BOOLEAN NOT NULL DEFAULT true,
  exige_conformidad   BOOLEAN NOT NULL DEFAULT false,

  -- Metas del área
  meta_disponibilidad INTEGER NOT NULL DEFAULT 90  CHECK (meta_disponibilidad BETWEEN 1 AND 100),
  meta_preventivo     INTEGER NOT NULL DEFAULT 90  CHECK (meta_preventivo BETWEEN 1 AND 100),
  meta_mttr_horas     INTEGER NOT NULL DEFAULT 24  CHECK (meta_mttr_horas BETWEEN 1 AND 10000),
  meta_mtbf_horas     INTEGER NOT NULL DEFAULT 300 CHECK (meta_mtbf_horas BETWEEN 1 AND 100000),

  actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por     UUID REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mantenimiento_config_actualizado_por
  ON mantenimiento_config (actualizado_por) WHERE actualizado_por IS NOT NULL;

ALTER TABLE mantenimiento_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE mantenimiento_config FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'mantenimiento_config' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON mantenimiento_config
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
