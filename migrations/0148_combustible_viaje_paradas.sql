-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: las PARADAS de un viaje (A → B → A, A → B → C → A)
--
-- Hasta ahora un viaje era A → B (origen y destino). Un viaje de ida y vuelta
-- o un circuito necesita una lista ordenada de lugares, con la hora y el
-- medidor de cada llegada y de cada salida.
--
-- ── Qué guarda cada fila ───────────────────────────────────────────────────
-- orden 0 es la salida; la última parada es la llegada final. Una parada
-- intermedia tiene las dos marcas (llega, y después sale).
--
-- ── Por qué origen_id / destino_id se quedan en combustible_viajes ─────────
-- Siguen siendo la "ida" (paradas 0 y 1): el CHECK origen <> destino sigue
-- valiendo, y los promedios por ruta y la lista de viajes siguen leyéndolos
-- hasta que pasen a calcularse por tramo. Un viaje A → B → A tiene origen A,
-- destino B y tres paradas.
--
-- ── Las marcas de los extremos no se duplican a mano ───────────────────────
-- inicio_en / medidor_inicio y fin_en / medidor_fin del viaje son la salida
-- de la parada 0 y la llegada de la última. El servicio las copia a las
-- paradas después de cada cambio, así que ninguna vía (marcar, cerrar,
-- corregir) deja las dos tablas contradiciéndose.
--
-- ── Viajes que ya existen ──────────────────────────────────────────────────
-- Se les crean sus dos paradas (origen y destino) con las marcas que ya
-- tienen. Es idempotente: volver a correr la migración no duplica nada.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
-- Las FK compuestas apuntan a tablas con FORCE RLS y el backfill lee viajes
-- sin app.tenant_id (gotcha de 0097). Se abre la ventana ANTES de crear la
-- tabla y se cierra al final.

ALTER TABLE combustible_viajes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lugares NO FORCE ROW LEVEL SECURITY;

-- ── 1. La tabla ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS combustible_viaje_paradas (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  viaje_id         BIGINT NOT NULL,
  orden            SMALLINT NOT NULL CHECK (orden >= 0 AND orden < 20),
  lugar_id         BIGINT NOT NULL,
  llegada_en       TIMESTAMPTZ,
  llegada_medidor  NUMERIC(12, 1) CHECK (llegada_medidor IS NULL OR llegada_medidor >= 0),
  salida_en        TIMESTAMPTZ,
  salida_medidor   NUMERIC(12, 1) CHECK (salida_medidor IS NULL OR salida_medidor >= 0),
  UNIQUE (tenant_id, viaje_id, orden),
  FOREIGN KEY (tenant_id, viaje_id)
    REFERENCES combustible_viajes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lugar_id)
    REFERENCES combustible_lugares (tenant_id, id),
  CHECK (llegada_en IS NULL OR salida_en IS NULL OR salida_en >= llegada_en),
  CHECK (llegada_medidor IS NULL OR salida_medidor IS NULL OR salida_medidor >= llegada_medidor)
);

-- La FK hacia lugares la usa el borrado de un lugar.
CREATE INDEX IF NOT EXISTS idx_viaje_paradas_lugar
  ON combustible_viaje_paradas (tenant_id, lugar_id);

-- ── 2. Viajes que ya existen ───────────────────────────────────────────────

INSERT INTO combustible_viaje_paradas
  (tenant_id, viaje_id, orden, lugar_id, salida_en, salida_medidor)
SELECT v.tenant_id, v.id, 0, v.origen_id, v.inicio_en, v.medidor_inicio
  FROM combustible_viajes v
 WHERE NOT EXISTS (
   SELECT 1 FROM combustible_viaje_paradas p
    WHERE p.tenant_id = v.tenant_id AND p.viaje_id = v.id
 );

INSERT INTO combustible_viaje_paradas
  (tenant_id, viaje_id, orden, lugar_id, llegada_en, llegada_medidor)
SELECT v.tenant_id, v.id, 1, v.destino_id, v.fin_en, v.medidor_fin
  FROM combustible_viajes v
 WHERE NOT EXISTS (
   SELECT 1 FROM combustible_viaje_paradas p
    WHERE p.tenant_id = v.tenant_id AND p.viaje_id = v.id AND p.orden = 1
 );

-- ── 3. Políticas ───────────────────────────────────────────────────────────

ALTER TABLE combustible_viaje_paradas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_viaje_paradas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_viaje_paradas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── 4. Fin de la ventana NO FORCE ──────────────────────────────────────────

ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lugares FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_paradas FORCE ROW LEVEL SECURITY;
