-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: conformidad de las órdenes de trabajo (M8)
--
--   requiere_conformidad   se fija al COMPLETAR la orden, si en ese momento la empresa exige conformidad
--                          (regla de Mantenimiento). Las órdenes cerradas antes quedan en falso: ninguna
--                          pasa a estar pendiente por encender la regla.
--   conformidad_por/_en    quién probó el equipo y dio la conformidad, y cuándo.
--
-- Aditiva e idempotente. La FK nueva apunta a `usuarios` (FORCE RLS): se abre la ventana NO FORCE
-- (gotcha 0097) y se cierra al final.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ordenes_trabajo NO FORCE ROW LEVEL SECURITY;

ALTER TABLE ordenes_trabajo
  ADD COLUMN IF NOT EXISTS requiere_conformidad BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conformidad_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conformidad_en       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ordenes_trabajo_conformidad_por
  ON ordenes_trabajo (conformidad_por) WHERE conformidad_por IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ordenes_trabajo_por_conformar
  ON ordenes_trabajo (tenant_id, id) WHERE requiere_conformidad AND conformidad_en IS NULL;

ALTER TABLE ordenes_trabajo FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
