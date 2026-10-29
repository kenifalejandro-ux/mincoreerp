-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: RUC opcional del proveedor
--
-- El alta de proveedor (Combustible > Proveedores) acepta ahora el RUC. Es
-- opcional: los proveedores que ya existen quedan sin RUC y nada deja de
-- funcionar. En Perú el RUC tiene 11 dígitos.
--
--   • CHECK: si viene, son exactamente 11 dígitos. Es la última defensa; el
--     schema de la API ya lo rechaza con 400 antes de llegar acá.
--   • Único por tenant SOLO cuando viene lleno: dos proveedores sin RUC
--     conviven (NULL no entra al índice parcial). Mismo RUC en otro tenant
--     pasa. Que dos proveedores del mismo grupo compartan RUC no se soporta
--     a propósito (caso raro, decisión del cliente 2026-10-21).
--
-- Migración aditiva: no toca datos ni RLS, así que no necesita la ventana
-- NO FORCE de 0063/0133.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_grifos
  ADD COLUMN IF NOT EXISTS ruc TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_grifos_ruc_formato'
  ) THEN
    ALTER TABLE combustible_grifos
      ADD CONSTRAINT combustible_grifos_ruc_formato
      CHECK (ruc IS NULL OR ruc ~ '^[0-9]{11}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS combustible_grifos_ruc_tenant_unique
  ON combustible_grifos (tenant_id, ruc)
  WHERE ruc IS NOT NULL;
