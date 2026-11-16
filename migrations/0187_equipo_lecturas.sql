-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: LECTURAS DEL MEDIDOR de una unidad (Flota)
--
-- Hasta aquí la unidad solo sabía QUÉ medidor usa (`equipos.tipo_medidor`, 0062); la lectura
-- misma vivía en otros módulos: los vales de Combustible (`lectura_horometro` y
-- `lectura_odometro`) y los viajes (`medidor_previo`, `medidor_inicio`, `medidor_fin`). Una
-- empresa solo con Flota no tenía dónde registrar ni consultar el horómetro o el kilometraje.
--
-- `equipo_lecturas` es el historial de lecturas de la unidad, de Flota. Funciona solo: cada lectura
-- dice de dónde vino (`origen`). Hoy se registra únicamente 'manual'; 'checklist', 'vale' y
-- 'viaje' ya están permitidos para que los otros módulos puedan dejar la suya (siempre opcional)
-- sin una migración nueva.
--
-- ── Reglas ──────────────────────────────────────────────────────────────────
-- 1. Lo pasado no se reescribe: un trigger solo deja ANULAR una lectura vigente (con motivo y
--    quién). Corregir es anular y registrar otra; nada se edita ni se borra.
-- 2. `tipo` copia el medidor que tenía la unidad al registrar: si después le cambian el tipo, las
--    lecturas viejas conservan el suyo.
-- 3. `cliente_uuid` único por empresa: el reintento de una lectura que estuvo en la cola sin
--    señal no deja dos filas.
-- 4. 'no retroceder' (una lectura no es menor que la anterior de la unidad ni mayor que la
--    siguiente) lo exige el servicio, bajo el candado de la unidad: no se puede expresar como
--    CHECK entre filas.
--
-- Aditiva. Las FK nuevas apuntan a tablas con FORCE RLS: se abre la ventana NO FORCE (gotcha 0097)
-- y se cierra al final.
--
-- EJECUTAR (después de 0186):
--   psql -d mincoreerp -f migrations/0187_equipo_lecturas.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
ALTER TABLE equipos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS equipo_lecturas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  equipo_id       INTEGER NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
  tipo            VARCHAR(10) NOT NULL CHECK (tipo IN ('horometro', 'odometro')),
  -- Dos decimales: es la misma precisión de la lectura de un vale (0062).
  valor           NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  -- Cuándo marcaba eso el medidor (puede ser pasado: se anota después).
  leido_en        TIMESTAMPTZ NOT NULL,
  origen          VARCHAR(10) NOT NULL DEFAULT 'manual'
                  CHECK (origen IN ('manual', 'checklist', 'vale', 'viaje')),
  cliente_uuid    UUID,
  usuario_id      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  anulada_en      TIMESTAMPTZ,
  anulada_por     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_anulacion TEXT CHECK (motivo_anulacion IS NULL OR length(trim(motivo_anulacion)) > 0),
  CHECK ((anulada_en IS NULL) = (motivo_anulacion IS NULL))
);

-- La última lectura vigente y sus vecinas por fecha: lo que consulta el servicio.
CREATE INDEX IF NOT EXISTS idx_equipo_lecturas_equipo
  ON equipo_lecturas (tenant_id, equipo_id, leido_en DESC, id DESC)
  WHERE anulada_en IS NULL;
-- Historial completo, también las anuladas. Cubre la FK `equipo_id`.
CREATE INDEX IF NOT EXISTS idx_equipo_lecturas_historial
  ON equipo_lecturas (equipo_id, creado_en DESC);
-- Toda FK lleva índice (tests/db-index-coverage.test.ts).
CREATE INDEX IF NOT EXISTS idx_equipo_lecturas_usuario
  ON equipo_lecturas (usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_equipo_lecturas_anulada_por
  ON equipo_lecturas (anulada_por) WHERE anulada_por IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipo_lecturas_cliente
  ON equipo_lecturas (tenant_id, cliente_uuid)
  WHERE cliente_uuid IS NOT NULL;

-- ── Lo pasado no se reescribe ──────────────────────────────────────────────
-- Solo se puede anular una lectura vigente: poner anulada_en, anulada_por y su motivo, una vez.
-- `usuario_id` queda libre solo para que ON DELETE SET NULL pueda borrar al autor.
CREATE OR REPLACE FUNCTION equipo_lecturas_inmutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  campos_libres TEXT[] := ARRAY['anulada_en', 'anulada_por', 'motivo_anulacion', 'usuario_id'];
BEGIN
  IF (to_jsonb(NEW) - campos_libres) IS DISTINCT FROM (to_jsonb(OLD) - campos_libres) THEN
    RAISE EXCEPTION 'Las lecturas del medidor no se reescriben: solo se pueden anular'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.usuario_id IS DISTINCT FROM OLD.usuario_id AND NEW.usuario_id IS NOT NULL THEN
    RAISE EXCEPTION 'Las lecturas del medidor no se reescriben: el autor no cambia'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.anulada_en IS NOT NULL THEN
    IF NEW.anulada_en IS DISTINCT FROM OLD.anulada_en
       OR NEW.motivo_anulacion IS DISTINCT FROM OLD.motivo_anulacion
       OR (NEW.anulada_por IS DISTINCT FROM OLD.anulada_por AND NEW.anulada_por IS NOT NULL) THEN
      RAISE EXCEPTION 'Esta lectura ya está anulada y no se puede modificar'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_equipo_lecturas_inmutable ON equipo_lecturas;
CREATE TRIGGER trg_equipo_lecturas_inmutable BEFORE UPDATE ON equipo_lecturas
  FOR EACH ROW EXECUTE FUNCTION equipo_lecturas_inmutable();

ALTER TABLE equipo_lecturas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'equipo_lecturas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON equipo_lecturas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Fin de la ventana NO FORCE ─────────────────────────────────────────────
ALTER TABLE equipos FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE equipo_lecturas FORCE ROW LEVEL SECURITY;
