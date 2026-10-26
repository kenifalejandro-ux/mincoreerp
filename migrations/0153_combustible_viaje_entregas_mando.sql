-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la ENTREGA DEL MANDO entre titular y relevo
--
-- Quien maneja entrega el volante (con el medidor del tablero y, si quiere, el lugar) y el otro
-- conductor la ACEPTA. Hasta que acepte sigue al volante quien entregó: la entrega es solo un
-- aviso pendiente. Al aceptar se cierra el turno de uno y se abre el del otro (0152).
--
-- Una entrega vive en una fila: nace al entregar y se completa al aceptar (aceptada_en) o se
-- retira (cancelada_en: la anula quien entregó, o el cierre del viaje). Como máximo hay UNA
-- pendiente por viaje (índice parcial). Cada marca lleva su origen de hora: sin señal la marca
-- llega con la hora del celular y así se ve.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_viajes NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS combustible_viaje_entregas (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  viaje_id            BIGINT NOT NULL,
  de_dni              VARCHAR(15) NOT NULL,
  de_nombre           VARCHAR(150),
  a_dni               VARCHAR(15) NOT NULL,
  a_nombre            VARCHAR(150),
  entrega_en          TIMESTAMPTZ NOT NULL,
  entrega_origen_hora VARCHAR(10) NOT NULL DEFAULT 'servidor'
                      CHECK (entrega_origen_hora IN ('servidor', 'manual', 'dispositivo')),
  medidor             NUMERIC(12, 1) CHECK (medidor IS NULL OR medidor >= 0),
  lugar               VARCHAR(160),
  entrega_cliente_uuid UUID,
  aceptada_en         TIMESTAMPTZ,
  aceptada_origen_hora VARCHAR(10)
                      CHECK (aceptada_origen_hora IN ('servidor', 'manual', 'dispositivo')),
  aceptada_cliente_uuid UUID,
  cancelada_en        TIMESTAMPTZ,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, viaje_id)
    REFERENCES combustible_viajes (tenant_id, id) ON DELETE CASCADE,
  CHECK (de_dni <> a_dni),
  CHECK (aceptada_en IS NULL OR cancelada_en IS NULL),
  CHECK (aceptada_en IS NULL OR aceptada_en >= entrega_en)
);

-- A lo sumo una entrega pendiente por viaje.
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_entrega_pendiente
  ON combustible_viaje_entregas (tenant_id, viaje_id)
  WHERE aceptada_en IS NULL AND cancelada_en IS NULL;
-- Reintentos de la cola sin señal: la misma marca no se aplica dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_entrega_uuid
  ON combustible_viaje_entregas (tenant_id, entrega_cliente_uuid)
  WHERE entrega_cliente_uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_entrega_aceptada_uuid
  ON combustible_viaje_entregas (tenant_id, aceptada_cliente_uuid)
  WHERE aceptada_cliente_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viaje_entregas_viaje
  ON combustible_viaje_entregas (tenant_id, viaje_id, entrega_en);

ALTER TABLE combustible_viaje_entregas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_viaje_entregas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_viaje_entregas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────

ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_entregas FORCE ROW LEVEL SECURITY;
