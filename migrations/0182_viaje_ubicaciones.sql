-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: HISTORIAL DE UBICACIONES de un viaje
--
-- La oficina anota dónde está la unidad de un viaje (por ejemplo, lo que ve en su GPS externo): un
-- punto con fecha y hora, un lugar del catálogo o un texto libre, y una nota. El viaje conserva
-- todos los puntos; el último es su «última ubicación». Sin GPS real en esta entrega.
--
-- Un descanso con «¿Dónde?» escrito deja también un punto aquí (origen 'descanso', ligado al
-- descanso); lo hace una entrega posterior. El conductor no registra ubicaciones: solo dice dónde
-- descansa.
--
-- `texto` siempre lleva el nombre mostrado: el del lugar del catálogo (copiado al guardar, para que
-- renombrar el lugar no cambie el historial) o lo que se escribió.
--
-- Aditiva. Las FK nuevas apuntan a tablas con FORCE RLS: se abre la ventana NO FORCE (gotcha 0097)
-- y se cierra al final.
--
-- EJECUTAR (después de 0181):
--   psql -d mincoreerp -f migrations/0182_viaje_ubicaciones.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
ALTER TABLE combustible_viajes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lugares NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_descansos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS combustible_viaje_ubicaciones (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  viaje_id       BIGINT NOT NULL,
  -- Lugar del catálogo, si se eligió uno; null cuando es texto libre.
  lugar_id       BIGINT,
  texto          VARCHAR(160) NOT NULL CHECK (length(trim(texto)) > 0),
  nota           VARCHAR(300),
  -- Cuándo estaba la unidad ahí (puede ser pasado: la oficina lo anota después).
  registrado_en  TIMESTAMPTZ NOT NULL,
  origen         VARCHAR(10) NOT NULL DEFAULT 'oficina' CHECK (origen IN ('oficina', 'descanso')),
  descanso_id    BIGINT,
  -- El reenvío con el mismo identificador no deja dos filas.
  cliente_uuid   UUID,
  creado_por     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, viaje_id)
    REFERENCES combustible_viajes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lugar_id)
    REFERENCES combustible_lugares (tenant_id, id),
  FOREIGN KEY (tenant_id, descanso_id)
    REFERENCES combustible_viaje_descansos (tenant_id, id) ON DELETE CASCADE,
  CHECK ((origen = 'descanso') = (descanso_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_viaje_ubicaciones_viaje
  ON combustible_viaje_ubicaciones (tenant_id, viaje_id, registrado_en DESC, id DESC);
-- Toda FK lleva índice (tests/db-index-coverage.test.ts).
CREATE INDEX IF NOT EXISTS idx_viaje_ubicaciones_lugar
  ON combustible_viaje_ubicaciones (tenant_id, lugar_id) WHERE lugar_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viaje_ubicaciones_descanso
  ON combustible_viaje_ubicaciones (tenant_id, descanso_id) WHERE descanso_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viaje_ubicaciones_creado_por
  ON combustible_viaje_ubicaciones (creado_por) WHERE creado_por IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_ubicaciones_cliente
  ON combustible_viaje_ubicaciones (tenant_id, cliente_uuid)
  WHERE cliente_uuid IS NOT NULL;

ALTER TABLE combustible_viaje_ubicaciones ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_viaje_ubicaciones'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_viaje_ubicaciones
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────
ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lugares FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_descansos FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_ubicaciones FORCE ROW LEVEL SECURITY;
