-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: checklist NO APTO, orden de trabajo automática y lectura del medidor (E5-2)
--
--   checklists.resultado            admite además 'no_apta' (falló un punto crítico; la columna no tiene CHECK)
--   checklists.lectura_valor        lo que se anotó del horómetro u odómetro al llenarlo (opcional)
--   checklists.aviso_registro       qué no se pudo hacer al registrarlo (lectura rechazada, cuota llena)
--   checklist_items.critica         si ese punto era crítico en la versión con que se llenó
--   ordenes_trabajo.origen          'manual' o 'checklist'
--   ordenes_trabajo.checklist_id    el checklist que la generó. Sin FK: `checklists` está particionada y su
--                                   clave incluye creado_en; al borrar el checklist la app lo deja en NULL.
--
-- Aditiva e idempotente. Las órdenes que ya existen quedan 'manual'.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE checklists
  ADD COLUMN IF NOT EXISTS lectura_valor  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS aviso_registro VARCHAR(600);

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS critica BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE ordenes_trabajo
  ADD COLUMN IF NOT EXISTS origen       VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS checklist_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ordenes_trabajo'::regclass AND conname = 'ordenes_trabajo_origen_check'
  ) THEN
    ALTER TABLE ordenes_trabajo
      ADD CONSTRAINT ordenes_trabajo_origen_check CHECK (origen IN ('manual', 'checklist'));
  END IF;
END $$;

-- Un checklist genera como mucho una orden.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ordenes_trabajo_checklist
  ON ordenes_trabajo (tenant_id, checklist_id)
  WHERE checklist_id IS NOT NULL;
