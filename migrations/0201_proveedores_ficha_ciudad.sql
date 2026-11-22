-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: ciudad del proveedor (columna «Lugar» del Directorio)
--
-- Un dato más de la ficha del proveedor (`proveedores_ficha`, 0198): la ciudad donde está. Opcional: los
-- proveedores que ya existen quedan sin ciudad. Migración aditiva: no toca datos ni RLS.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE proveedores_ficha ADD COLUMN IF NOT EXISTS ciudad VARCHAR(80);
