-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el conductor marca su propio viaje (inicio y fin) desde el celular
--
-- ── De dónde salió cada hora ────────────────────────────────────────────────
-- 'servidor'   : la puso el servidor al recibir la marca (lo normal).
-- 'manual'     : la escribió la oficina porque alguien se olvidó (con motivo).
-- 'dispositivo': la marca se hizo SIN SEÑAL, quedó en la cola del celular y
--                llegó tarde; vale la hora del celular, a la vista de la
--                oficina. Sin esto la salida quedaría corrida horas.
-- NULL en los viajes anteriores a esta migración: no se sabe y no se inventa.
--
-- ── El uuid de cada marca ───────────────────────────────────────────────────
-- La cola offline reintenta: si la respuesta se perdió, el mismo "Iniciar"
-- vuelve a llegar. Con el uuid guardado, el reintento devuelve el viaje tal
-- como quedó en vez de un 409 que la cola descartaría como error.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_viajes
  ADD COLUMN IF NOT EXISTS inicio_origen_hora VARCHAR(12),
  ADD COLUMN IF NOT EXISTS fin_origen_hora    VARCHAR(12),
  ADD COLUMN IF NOT EXISTS inicio_cliente_uuid UUID,
  ADD COLUMN IF NOT EXISTS fin_cliente_uuid    UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_viajes_inicio_origen_hora_check'
  ) THEN
    ALTER TABLE combustible_viajes
      ADD CONSTRAINT combustible_viajes_inicio_origen_hora_check
      CHECK (inicio_origen_hora IS NULL
             OR inicio_origen_hora IN ('servidor', 'manual', 'dispositivo'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_viajes_fin_origen_hora_check'
  ) THEN
    ALTER TABLE combustible_viajes
      ADD CONSTRAINT combustible_viajes_fin_origen_hora_check
      CHECK (fin_origen_hora IS NULL
             OR fin_origen_hora IN ('servidor', 'manual', 'dispositivo'));
  END IF;
END $$;

-- Para que el conductor encuentre lo suyo sin recorrer todos los viajes.
CREATE INDEX IF NOT EXISTS idx_viajes_conductor_dni
  ON combustible_viajes (tenant_id, conductor_dni)
  WHERE estado IN ('programado', 'en_curso');
