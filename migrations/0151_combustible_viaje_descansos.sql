-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: los DESCANSOS de un viaje
--
-- Un conductor descansa en ruta (dormir, comer, una avería) o en una parada. Se ve desde el ERP
-- y se descuenta del tiempo en marcha. El descanso es de la PERSONA, no del viaje: se guarda
-- con el conductor que descansa.
--
-- ── Cuándo detiene la unidad ───────────────────────────────────────────────
-- `detiene` es true cuando descansa quien va al volante: la unidad no avanza hasta que termine.
-- Hoy cada viaje tiene un solo conductor, así que siempre es true; cuando haya relevo, descansar
-- el que NO maneja deja `detiene` en false y el viaje sigue.
--
-- ── Quién y por qué ────────────────────────────────────────────────────────
-- inicio_por / fin_por: 'conductor' desde su celular, 'oficina' cuando el encargado lo marca por
-- él (con motivo obligatorio; lo exige el servicio). origen_hora y cliente_uuid, igual que las
-- marcas de las paradas (0149): hora del servidor, a mano o del celular sin señal, y el reintento
-- de la cola no marca dos veces.
--
-- Una persona descansa una vez a la vez: el índice parcial lo garantiza aunque dos celulares
-- marquen a la vez.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
-- Las FK apuntan a tablas con FORCE RLS (gotcha de 0097): se abre la ventana antes de crear la
-- tabla y se cierra al final.

ALTER TABLE combustible_viajes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS combustible_viaje_descansos (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  viaje_id            BIGINT NOT NULL,
  conductor_dni       VARCHAR(15) NOT NULL,
  conductor_nombre    VARCHAR(150),
  inicio_en           TIMESTAMPTZ NOT NULL,
  fin_en              TIMESTAMPTZ,
  motivo              VARCHAR(500),
  donde               VARCHAR(160) NOT NULL,
  detiene             BOOLEAN NOT NULL DEFAULT true,
  inicio_por          VARCHAR(10) NOT NULL CHECK (inicio_por IN ('conductor', 'oficina')),
  fin_por             VARCHAR(10) CHECK (fin_por IS NULL OR fin_por IN ('conductor', 'oficina')),
  inicio_origen_hora  VARCHAR(12) CHECK (inicio_origen_hora IN ('servidor', 'manual', 'dispositivo')),
  fin_origen_hora     VARCHAR(12) CHECK (fin_origen_hora IS NULL
                                         OR fin_origen_hora IN ('servidor', 'manual', 'dispositivo')),
  inicio_cliente_uuid UUID,
  fin_cliente_uuid    UUID,
  creado_por          UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  cerrado_por         UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, viaje_id)
    REFERENCES combustible_viajes (tenant_id, id) ON DELETE CASCADE,
  CHECK (fin_en IS NULL OR fin_en > inicio_en),
  CHECK ((fin_en IS NULL) = (fin_por IS NULL))
);

-- Una persona descansa una vez a la vez en un viaje.
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_descanso_abierto
  ON combustible_viaje_descansos (tenant_id, viaje_id, conductor_dni)
  WHERE fin_en IS NULL;
-- El reintento de la cola no marca dos veces: un uuid vale una sola marca.
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_descanso_inicio_uuid
  ON combustible_viaje_descansos (tenant_id, inicio_cliente_uuid)
  WHERE inicio_cliente_uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_descanso_fin_uuid
  ON combustible_viaje_descansos (tenant_id, fin_cliente_uuid)
  WHERE fin_cliente_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viaje_descansos_viaje
  ON combustible_viaje_descansos (tenant_id, viaje_id, inicio_en);
CREATE INDEX IF NOT EXISTS idx_viaje_descansos_creado_por
  ON combustible_viaje_descansos (creado_por) WHERE creado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viaje_descansos_cerrado_por
  ON combustible_viaje_descansos (cerrado_por) WHERE cerrado_por IS NOT NULL;

ALTER TABLE combustible_viaje_descansos ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_viaje_descansos'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_viaje_descansos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────

ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_descansos FORCE ROW LEVEL SECURITY;
