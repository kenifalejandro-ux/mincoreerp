-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: ALERTAS DE VIAJE en su propia tabla (Viajes)
--
-- Las alertas de un viaje (demorado, detenido y «creado por el conductor») vivían en
-- `combustible_alertas`, la tabla de alertas de Combustible. Eso ataba Viajes a Combustible: una
-- empresa con Viajes y sin Combustible no tenía dónde ver sus alertas, porque la Bandeja solo leía
-- `/combustible/alertas`.
--
-- `viaje_alertas` es la tabla de Viajes. Funciona sola: el motor de alertas de viaje la escribe y la
-- Bandeja la lee por `/viajes/alertas`, haya o no Combustible.
--
-- Los tres tipos son ESTADOS: se abren una sola vez por viaje y tipo (índice único parcial) y se
-- cierran solos cuando el viaje llega, se cierra, se anula o la detención termina. Por eso la tabla
-- es más simple que la de Combustible: no hay resolución manual (`resuelta_por`), ni congelado, ni
-- anclas a vales o tanques.
--
-- ── Qué NO hace ─────────────────────────────────────────────────────────────
-- No borra ni cambia nada de `combustible_alertas`: copia las filas de viaje que ya existen (con
-- su estado de leída y resuelta) y las deja allí intactas. Combustible deja de mostrarlas por
-- código, no por datos: si hubiera que volver atrás, las filas siguen en su sitio.
-- La copia es idempotente (no repite una fila ya copiada), así que correrla otra vez no duplica.
--
-- La FK nueva y la copia leen tablas con FORCE RLS: se abre la ventana NO FORCE (gotcha 0097) y se
-- cierra al final.
--
-- EJECUTAR (después de 0187):
--   psql -d mincoreerp -f migrations/0188_viaje_alertas.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
ALTER TABLE combustible_viajes NO FORCE ROW LEVEL SECURITY;
-- También la de origen: la copia de abajo la lee.
ALTER TABLE combustible_alertas NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS viaje_alertas (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo             TEXT NOT NULL
                   CHECK (tipo IN ('viaje_demorado', 'viaje_detenido', 'viaje_creado_por_conductor')),
  viaje_id         BIGINT NOT NULL REFERENCES combustible_viajes(id) ON DELETE CASCADE,
  detalle          JSONB NOT NULL DEFAULT '{}',
  -- El grifo de la unidad del viaje: quien tiene alcance a ese grifo (Combustible) ve la alerta.
  -- Sin FK a propósito, igual que en combustible_alertas: Viajes no depende de que existan grifos.
  grifo_interno_id INTEGER,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lectura compartida entre quienes la ven, como en combustible_alertas (0068).
  leida_en         TIMESTAMPTZ,
  resuelta_en      TIMESTAMPTZ
);

-- Una alerta abierta por viaje y tipo: el motor abre con ON CONFLICT DO NOTHING sobre este índice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_viaje_alertas_abierta
  ON viaje_alertas (tenant_id, viaje_id, tipo)
  WHERE resuelta_en IS NULL;
-- Cubre la FK `viaje_id` (tests/db-index-coverage.test.ts) y las consultas por viaje.
CREATE INDEX IF NOT EXISTS idx_viaje_alertas_viaje ON viaje_alertas (viaje_id);
-- La Bandeja: lo más reciente primero, por empresa. Cubre la FK `tenant_id`.
CREATE INDEX IF NOT EXISTS idx_viaje_alertas_bandeja ON viaje_alertas (tenant_id, creado_en DESC);
-- El contador: cuántas sin leer. Parcial porque las leídas son la mayoría con el tiempo.
CREATE INDEX IF NOT EXISTS idx_viaje_alertas_no_leidas
  ON viaje_alertas (tenant_id) WHERE leida_en IS NULL;

ALTER TABLE viaje_alertas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'viaje_alertas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON viaje_alertas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Copia de lo que ya existe ──────────────────────────────────────────────
-- Todas las alertas de viaje de combustible_alertas, resueltas o no, con su estado. Sin
-- UPDATE ni DELETE sobre la tabla de origen. `creado_en` y el viaje identifican la fila: una copia
-- ya hecha no se repite.
INSERT INTO viaje_alertas
  (tenant_id, tipo, viaje_id, detalle, grifo_interno_id, creado_en, leida_en, resuelta_en)
SELECT a.tenant_id, a.tipo, a.viaje_id, a.detalle, a.grifo_interno_id, a.creado_en, a.leida_en,
       a.resuelta_en
  FROM combustible_alertas a
 WHERE a.viaje_id IS NOT NULL
   AND a.tipo IN ('viaje_demorado', 'viaje_detenido', 'viaje_creado_por_conductor')
   AND NOT EXISTS (
     SELECT 1 FROM viaje_alertas v
      WHERE v.tenant_id = a.tenant_id AND v.viaje_id = a.viaje_id
        AND v.tipo = a.tipo AND v.creado_en = a.creado_en
   );

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────
ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_alertas FORCE ROW LEVEL SECURITY;
ALTER TABLE viaje_alertas FORCE ROW LEVEL SECURITY;
