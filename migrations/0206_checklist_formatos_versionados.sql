-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: formatos de checklist editables, con versiones y puntos críticos (E5-1)
--
-- Hasta ahora un formato solo se creaba o se borraba. Ahora se edita: cada cambio es una versión nueva con su
-- «qué cambió», se puede volver a una anterior (que crea otra versión) y desactivar el formato.
--
--   checklist_plantillas.version / activa   la versión vigente y si se ofrece para llenar
--   checklist_plantilla_items.critica       un punto crítico: si falla, la unidad no sale (se usa en E5-2)
--   checklist_plantilla_versiones           la foto de cada versión (preguntas incluidas)
--   checklists.plantilla_version            con qué versión se llenó (NULL en los anteriores a esta migración)
--
-- Los formatos que ya existen son la versión 1 y NO se les crea foto aquí: la guarda el servicio antes de la
-- primera edición (así no hace falta una migración de datos bajo RLS). Los checklists ya llenados no cambian:
-- sus preguntas se copian al llenarlos (0006).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE checklist_plantillas
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS activa  BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE checklist_plantilla_items
  ADD COLUMN IF NOT EXISTS critica BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE checklists
  ADD COLUMN IF NOT EXISTS plantilla_version INTEGER;

CREATE TABLE IF NOT EXISTS checklist_plantilla_versiones (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plantilla_id INTEGER NOT NULL REFERENCES checklist_plantillas(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL CHECK (version >= 1),
  nombre       VARCHAR(150) NOT NULL,
  tipo_equipo  VARCHAR(100),
  -- [{ "descripcion": "...", "critica": false }] en el orden en que se preguntan
  items        JSONB NOT NULL,
  -- «Qué cambió». NULL solo en la foto de la versión original.
  cambio       VARCHAR(300),
  creado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plantilla_id, version)
);

CREATE INDEX IF NOT EXISTS idx_checklist_plantilla_versiones_tenant
  ON checklist_plantilla_versiones (tenant_id);
CREATE INDEX IF NOT EXISTS idx_checklist_plantilla_versiones_creado_por
  ON checklist_plantilla_versiones (creado_por) WHERE creado_por IS NOT NULL;

ALTER TABLE checklist_plantilla_versiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_plantilla_versiones FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'checklist_plantilla_versiones'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON checklist_plantilla_versiones
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
