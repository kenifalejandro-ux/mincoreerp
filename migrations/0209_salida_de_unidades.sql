-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: salida de unidades según el checklist
--
--   checklists.salida          'libre' (sin fallas), 'no_sale' (falla crítica), 'por_autorizar' (falla
--                              menor), 'autorizada' o 'rechazada' (decidida). NULL en los anteriores.
--   checklists.salida_por/_en/_motivo   quién decidió, cuándo y por qué. Sin FK: `checklists` está
--                              particionada y con FORCE RLS; el respaldo sí remapea el usuario.
--   orden_trabajo_hallazgos    qué fallas de qué checklist cubre cada orden. Con esto no se repite una
--                              orden por la misma falla mientras la anterior siga abierta. Es de Órdenes de
--                              trabajo (se restaura después de las órdenes). `checklist_id` sin FK por la
--                              partición; al borrar el checklist la app lo deja en NULL.
--
-- Aditiva e idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE checklists
  ADD COLUMN IF NOT EXISTS salida        VARCHAR(15),
  ADD COLUMN IF NOT EXISTS salida_por    UUID,
  ADD COLUMN IF NOT EXISTS salida_en     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS salida_motivo VARCHAR(300);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'checklists'::regclass AND conname = 'checklists_salida_check'
  ) THEN
    ALTER TABLE checklists
      ADD CONSTRAINT checklists_salida_check
      CHECK (salida IN ('libre', 'no_sale', 'por_autorizar', 'autorizada', 'rechazada'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_checklists_por_autorizar
  ON checklists (tenant_id, id) WHERE salida = 'por_autorizar';

CREATE TABLE IF NOT EXISTS orden_trabajo_hallazgos (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id) ON DELETE CASCADE,
  checklist_id     INTEGER,
  descripcion      VARCHAR(300) NOT NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orden_trabajo_hallazgos_tenant
  ON orden_trabajo_hallazgos (tenant_id, checklist_id);
CREATE INDEX IF NOT EXISTS idx_orden_trabajo_hallazgos_orden
  ON orden_trabajo_hallazgos (orden_trabajo_id);

ALTER TABLE orden_trabajo_hallazgos ENABLE ROW LEVEL SECURITY;
ALTER TABLE orden_trabajo_hallazgos FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'orden_trabajo_hallazgos'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON orden_trabajo_hallazgos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
