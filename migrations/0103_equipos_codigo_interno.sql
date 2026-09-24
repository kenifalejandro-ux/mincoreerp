-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: código interno del equipo (columna CODIGO de la planilla de flota)
--
-- La planilla real de flota (ver DATOS DE FLOTA_SANTA ISABEL.xlsx, importada
-- desde Equipos → "Importar Excel") trae TIPO/ITEM/PLACA/CODIGO/MARCA/MODELO.
-- "CODIGO" (CU-14, CU-10, ...) es un código propio de la empresa, distinto de
-- la placa -- el ERP no lo tenía y la importación lo descartaba en silencio.
--
-- Nullable y sin exigir unicidad total: no toda la flota trae este código
-- (los volquetes más nuevos de la planilla real vienen con la celda vacía), y
-- obligarlo habría bloqueado la importación de esas filas. El índice único
-- es PARCIAL (solo sobre los valores cargados) para que dos equipos SIN
-- código no choquen entre sí -- mismo criterio que capacidad_tanque
-- (migración 0069): un campo opcional no se valida como si fuera obligatorio.
--
-- EJECUTAR:
--   psql -d mincoreerp -f migrations/0103_equipos_codigo_interno.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE equipos
  ADD COLUMN IF NOT EXISTS codigo_interno VARCHAR(50);

CREATE UNIQUE INDEX IF NOT EXISTS idx_equipos_codigo_interno
  ON equipos(tenant_id, codigo_interno)
  WHERE codigo_interno IS NOT NULL;
