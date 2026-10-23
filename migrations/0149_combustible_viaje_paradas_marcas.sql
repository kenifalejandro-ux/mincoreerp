-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: de dónde salió cada marca de una parada, y el reintento sin señal
--
-- Cada llegada y cada salida de una parada la marca el conductor desde el
-- celular (a veces sin señal) o la oficina por él. Igual que la salida y la
-- llegada final del viaje (0124):
--
-- origen_hora  'servidor'    la puso el servidor al recibir la marca (lo normal)
--              'manual'      la escribió la oficina porque alguien se olvidó
--              'dispositivo' la marca esperó en la cola sin señal; vale la hora
--                            del celular, a la vista de la oficina
-- cliente_uuid el uuid de la marca: si la cola reenvía la misma, el servidor
--              devuelve el viaje como quedó en vez de un 409.
--
-- NULL en las paradas anteriores a esta migración: no se sabe y no se inventa.
-- La salida de la parada 0 y la llegada de la última siguen siendo las del
-- viaje (inicio_origen_hora, fin_origen_hora), que el servicio copia.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_viaje_paradas
  ADD COLUMN IF NOT EXISTS llegada_origen_hora  VARCHAR(12),
  ADD COLUMN IF NOT EXISTS salida_origen_hora   VARCHAR(12),
  ADD COLUMN IF NOT EXISTS llegada_cliente_uuid UUID,
  ADD COLUMN IF NOT EXISTS salida_cliente_uuid  UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'viaje_paradas_llegada_origen_hora_check'
  ) THEN
    ALTER TABLE combustible_viaje_paradas
      ADD CONSTRAINT viaje_paradas_llegada_origen_hora_check
      CHECK (llegada_origen_hora IS NULL
             OR llegada_origen_hora IN ('servidor', 'manual', 'dispositivo'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'viaje_paradas_salida_origen_hora_check'
  ) THEN
    ALTER TABLE combustible_viaje_paradas
      ADD CONSTRAINT viaje_paradas_salida_origen_hora_check
      CHECK (salida_origen_hora IS NULL
             OR salida_origen_hora IN ('servidor', 'manual', 'dispositivo'));
  END IF;
END $$;

-- El reintento de la cola no marca dos veces: un uuid vale una sola marca.
CREATE UNIQUE INDEX IF NOT EXISTS idx_viaje_paradas_llegada_uuid
  ON combustible_viaje_paradas (tenant_id, llegada_cliente_uuid)
  WHERE llegada_cliente_uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_viaje_paradas_salida_uuid
  ON combustible_viaje_paradas (tenant_id, salida_cliente_uuid)
  WHERE salida_cliente_uuid IS NOT NULL;
