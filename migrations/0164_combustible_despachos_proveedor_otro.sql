-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el nombre del grifo "Otros" vive en el despacho, no en un proveedor
--
-- Kenif (2026-10-31): los grifos que se usan una o dos veces no deben crear un
-- proveedor por conductor y por nombre (0163 creaba "Otros: <nombre>" por cada
-- nombre distinto). El nombre que escribe el conductor se guarda en el despacho;
-- hay UN solo proveedor interno "Otros" por empresa (el oculto de 0163, para que
-- grifo_id siga siendo NOT NULL y ningún JOIN pierda filas). El historial y los
-- exportes muestran "Otros: <nombre>" y marcan la compra como no registrada.
--
-- El índice único de comprobante (0119) ahora también distingue el nombre
-- escrito: dos grifos distintos de "Otros" con la MISMA boleta no se bloquean
-- entre sí. Es más permisivo que el anterior (los despachos que ya existen
-- tienen proveedor_otro NULL, o sea ''), así que no puede fallar con los datos
-- actuales.
--
-- Las filas "Otros: <nombre>" que 0163 alcanzó a crear en producción siguen
-- mostrándose bien (su nombre ya trae el prefijo); no se migran.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS proveedor_otro VARCHAR(80)
    CHECK (proveedor_otro IS NULL OR length(trim(proveedor_otro)) >= 3);

DROP INDEX IF EXISTS idx_combustible_despachos_comprobante_vigente;
CREATE UNIQUE INDEX idx_combustible_despachos_comprobante_vigente
  ON combustible_despachos(
    tenant_id, producto, grifo_id, comprobante_tipo,
    combustible_comprobante_canonico(comprobante_numero),
    (COALESCE(lower(proveedor_otro), ''))
  )
  WHERE comprobante_numero IS NOT NULL AND anulada_en IS NULL;
