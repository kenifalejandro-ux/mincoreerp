-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la empresa de transporte de la compra de una cisterna (0171)
--
-- La guía de remisión nombra a la empresa que trae el combustible (razón social y RUC); es un dato
-- que la encargada necesita ver y que se repite compra tras compra con el mismo proveedor. Las
-- placas, el chofer y la licencia NO se piden: viven en el documento adjunto.
--
-- Texto libre a propósito, igual que la placa y el chofer: no es un catálogo ni lee otro módulo
-- (cada módulo funciona solo). El formulario la sugiere desde la última compra del proveedor.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_compras_cisterna
  ADD COLUMN IF NOT EXISTS transportista VARCHAR(150),
  ADD COLUMN IF NOT EXISTS transportista_ruc VARCHAR(11);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_compras_cisterna_ruc_check'
  ) THEN
    ALTER TABLE combustible_compras_cisterna
      ADD CONSTRAINT combustible_compras_cisterna_ruc_check
      CHECK (
        transportista_ruc IS NULL
        OR (transportista_ruc ~ '^[0-9]{11}$' AND length(trim(coalesce(transportista, ''))) > 0)
      );
  END IF;
END $$;
