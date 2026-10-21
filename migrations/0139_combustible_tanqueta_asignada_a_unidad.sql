-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la tanqueta se ASIGNA a la unidad que la lleva
--
-- Kenif (2026-10-21): hoy el conductor elige a mano la tanqueta y la unidad al
-- cargar. Quien llena la tanqueta (grifero o encargado) dice para qué unidad
-- va; el conductor ya no elige nada. Esta migración solo guarda la asignación.
--
--   * Una tanqueta va con UNA unidad a la vez; una unidad puede llevar hasta 3
--     (lo hace cumplir el servicio, bajo bloqueo de la unidad).
--   * NO hay columna de "libre": la asignación vale mientras la tanqueta tenga
--     saldo (> 0), que ya se deriva de entradas menos salidas. Al vaciarse deja
--     de contar sola, sin cron; si se vuelve a llenar, el llenado la limpia.
--   * Liberar o reasignar a mano queda en la bitácora (quién, por qué).
--
-- Nullable a propósito: las tanquetas existentes nacen sin asignar.
-- ═══════════════════════════════════════════════════════════════════════════

-- La FK se valida contra filas existentes con una consulta que pasa por RLS y
-- acá no hay app.tenant_id: dentro de la ventana NO FORCE (gotcha de 0097).
ALTER TABLE combustible_tanquetas NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_tanquetas
  ADD COLUMN IF NOT EXISTS equipo_asignado_id INTEGER REFERENCES equipos(id),
  ADD COLUMN IF NOT EXISTS asignada_en TIMESTAMPTZ;

ALTER TABLE combustible_tanquetas
  DROP CONSTRAINT IF EXISTS combustible_tanquetas_asignacion_check;
ALTER TABLE combustible_tanquetas
  ADD CONSTRAINT combustible_tanquetas_asignacion_check
  CHECK ((equipo_asignado_id IS NULL) = (asignada_en IS NULL));

CREATE INDEX IF NOT EXISTS idx_tanquetas_equipo_asignado
  ON combustible_tanquetas (tenant_id, equipo_asignado_id) WHERE equipo_asignado_id IS NOT NULL;

ALTER TABLE combustible_tanquetas FORCE ROW LEVEL SECURITY;
