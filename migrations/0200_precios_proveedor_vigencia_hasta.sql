-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: «Vigencia hasta» OPCIONAL en los precios de proveedor
--
-- Un acuerdo con un proveedor puede tener fecha de fin («este precio rige hasta el 31/12»). El campo es
-- opcional: los precios que ya existen, y los que carga Combustible, quedan sin fecha (NULL) y se comportan
-- exactamente igual.
--
-- La fecha es SOLO una alerta: un precio cuya vigencia ya pasó sigue siendo el precio vigente para los
-- despachos, las compras en ruta y los viajes hasta que se cargue uno nuevo (si no, esas pantallas se
-- quedarían sin referencia por una fecha olvidada). Gestión comercial lo marca «vencido» y cuenta los que
-- «vencen en 30 días».
--
-- DATE (día de Lima, inclusive), no TIMESTAMPTZ: es lo que se escribe en el formulario («hasta el 31/12»).
-- Migración aditiva: no toca datos ni RLS.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_precios ADD COLUMN IF NOT EXISTS vigente_hasta DATE;
ALTER TABLE combustible_urea_precios ADD COLUMN IF NOT EXISTS vigente_hasta DATE;
