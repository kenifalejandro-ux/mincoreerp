-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: «El relevo maneja» para un relevo que no tiene cuenta (solo historial).
--
-- Cuando el conductor crea su viaje y anota un relevo que no está registrado (0179), ese relevo
-- no tiene cuenta ni DNI: no puede tomar el mando en el sistema (los turnos y el mando se apoyan
-- en el DNI). Para no complicarlo, el conductor solo deja constancia en su celular de quién va al
-- volante, como ya hace con el odómetro y los descansos: un historial, sin turnos ni cola.
--
-- 1. combustible_viajes.relevo_sin_cuenta: el nombre del relevo anotado sin cuenta. Antes solo
--    quedaba escrito en las observaciones.
--
-- 2. combustible_viaje_manejo: una fila cada vez que el conductor marca «El relevo maneja» o
--    «Vuelvo a manejar yo». `cliente_uuid` hace que el reenvío sin señal no duplique.
--
-- Aditiva. La FK nueva (manejo → viajes) va dentro de la ventana NO FORCE de 0097: la validación
-- inicial de una FK lee la tabla con RLS y la migración no tiene app.tenant_id.
--
-- EJECUTAR (después de 0179):
--   psql -d mincoreerp -f migrations/0180_viajes_relevo_maneja_historial.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
ALTER TABLE combustible_viajes NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_viajes
  ADD COLUMN IF NOT EXISTS relevo_sin_cuenta VARCHAR(150);

CREATE TABLE IF NOT EXISTS combustible_viaje_manejo (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  viaje_id      BIGINT NOT NULL,
  -- Quién pasó a ir al volante: el titular (el conductor) o el relevo sin cuenta.
  quien         VARCHAR(10) NOT NULL CHECK (quien IN ('titular', 'relevo')),
  en            TIMESTAMPTZ NOT NULL,
  origen_hora   VARCHAR(10) NOT NULL DEFAULT 'servidor'
                CHECK (origen_hora IN ('servidor', 'dispositivo')),
  cliente_uuid  UUID,
  creado_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, viaje_id)
    REFERENCES combustible_viajes (tenant_id, id) ON DELETE CASCADE
);

-- Un reenvío con el mismo identificador no deja dos filas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_manejo_cliente
  ON combustible_viaje_manejo (tenant_id, cliente_uuid)
  WHERE cliente_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viaje_manejo_viaje
  ON combustible_viaje_manejo (tenant_id, viaje_id, en);
-- Toda FK lleva índice (tests/db-index-coverage.test.ts): borrar un usuario no recorre la tabla entera.
CREATE INDEX IF NOT EXISTS idx_viaje_manejo_creado_por
  ON combustible_viaje_manejo (creado_por) WHERE creado_por IS NOT NULL;

ALTER TABLE combustible_viaje_manejo NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_manejo ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_viaje_manejo'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_viaje_manejo
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────
ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viaje_manejo FORCE ROW LEVEL SECURITY;
