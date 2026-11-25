-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: hora de inicio, «la unidad no puede operar» y tareas de la orden de trabajo (E5-5)
--
--   ordenes_trabajo.inicio_en        cuándo empezó el trabajo; se escribe a mano (también después). La
--                                    hora de fin es `fecha_cierre`; la duración se calcula, no se guarda.
--   ordenes_trabajo.unidad_no_opera  solo se anota: no cambia el estado de la unidad.
--   orden_trabajo_tareas             lista de tareas de la orden, hecha o pendiente.
--
-- Aditiva e idempotente. Las órdenes que ya existen quedan sin hora de inicio, así que el CHECK no las toca.
-- La tabla nueva está vacía: su FK se valida sin filas (no hace falta ventana NO FORCE).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ordenes_trabajo
  ADD COLUMN IF NOT EXISTS inicio_en       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unidad_no_opera BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ordenes_trabajo'::regclass AND conname = 'ordenes_trabajo_inicio_antes_del_cierre'
  ) THEN
    ALTER TABLE ordenes_trabajo
      ADD CONSTRAINT ordenes_trabajo_inicio_antes_del_cierre
      CHECK (inicio_en IS NULL OR fecha_cierre IS NULL OR inicio_en <= fecha_cierre);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS orden_trabajo_tareas (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  orden_trabajo_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id) ON DELETE CASCADE,
  descripcion      VARCHAR(300) NOT NULL CHECK (btrim(descripcion) <> ''),
  hecha            BOOLEAN NOT NULL DEFAULT false,
  orden            INTEGER NOT NULL DEFAULT 0,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orden_trabajo_tareas_tenant
  ON orden_trabajo_tareas (tenant_id);
CREATE INDEX IF NOT EXISTS idx_orden_trabajo_tareas_orden
  ON orden_trabajo_tareas (orden_trabajo_id, orden, id);

ALTER TABLE orden_trabajo_tareas ENABLE ROW LEVEL SECURITY;
ALTER TABLE orden_trabajo_tareas FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'orden_trabajo_tareas' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON orden_trabajo_tareas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
