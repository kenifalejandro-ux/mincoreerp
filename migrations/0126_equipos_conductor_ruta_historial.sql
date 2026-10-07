-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: EQUIPOS como maestro de la flota -- conductor y rutas con historial
--
-- Kenif: "con esta implementación vamos a saber qué conductores manejan tal
-- unidad, la ruta asignada, etc. Si más adelante se cambia la unidad del
-- conductor, acá se hace el cambio y siempre queda en historial la unidad que
-- manejó hace días, semanas, meses: facilita mucho en caso de incidencias."
--
-- ── Qué guarda cada cosa ────────────────────────────────────────────────────
-- equipos.conductor_nombre / conductor_dni (0083): el conductor VIGENTE. Se
--   queda ahí porque el vale lo copia al despachar. NO se toca ese camino.
-- equipo_conductores: el HISTORIAL de quién manejó la unidad y entre qué
--   fechas. Una sola fila vigente (hasta IS NULL) por unidad.
-- equipo_rutas: las rutas habituales (origen → destino, lugares de Viajes) de
--   la unidad, también con vigencia. Varias vigentes a la vez: unas empresas
--   tienen ruta fija por unidad y otras no, así que no se asume nada.
--
-- ── Reglas ──────────────────────────────────────────────────────────────────
-- 1. TODO cambio lleva motivo (NOT NULL con CHECK): seguridad. El cierre de
--    una asignación guarda también su motivo y quién la cerró.
-- 2. Lo pasado no se reescribe: un trigger solo deja cerrar una fila vigente
--    (poner hasta, motivo_cierre y cerrado_por, una vez).
-- 3. La asignación que ya existía al activarse esto entra con desde = ahora y
--    un motivo de sistema. Cuándo empezó de verdad nunca se registró, y
--    inventarlo sería peor que decirlo.
-- 4. Los viajes y los vales siguen guardando SU propia copia del conductor y
--    de la ruta: un JOIN a estas tablas jamás reemplaza esa foto del momento.
--
-- ── Medidor por tipo (pedido del cliente) ───────────────────────────────────
-- Horómetro: volquete, excavadora, retroexcavadora. Odómetro: camioneta,
-- tracto remolcador. Bombona y carreta no llevan medidor: se quedan en NULL
-- (que ya significa "sin medidor"). Solo se rellenan los NULL: lo que alguien
-- ya configuró a mano no se pisa.
-- ═══════════════════════════════════════════════════════════════════════════

-- equipos tiene FORCE RLS y el relleno de abajo lo lee y lo escribe sin
-- app.tenant_id: se afloja durante la migración y se vuelve a cerrar al final
-- (mismo camino que 0097).
ALTER TABLE equipos NO FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS equipo_conductores (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  equipo_id        INTEGER NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
  conductor_nombre VARCHAR(150),
  conductor_dni    VARCHAR(15),
  desde            TIMESTAMPTZ NOT NULL DEFAULT now(),
  hasta            TIMESTAMPTZ,
  motivo           TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  usuario_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_cierre    TEXT CHECK (motivo_cierre IS NULL OR length(trim(motivo_cierre)) > 0),
  cerrado_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  CHECK (conductor_nombre IS NOT NULL OR conductor_dni IS NOT NULL),
  CHECK (hasta IS NULL OR hasta >= desde),
  CHECK ((hasta IS NULL) = (motivo_cierre IS NULL))
);

CREATE TABLE IF NOT EXISTS equipo_rutas (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  equipo_id     INTEGER NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
  origen_id     BIGINT NOT NULL,
  destino_id    BIGINT NOT NULL,
  desde         TIMESTAMPTZ NOT NULL DEFAULT now(),
  hasta         TIMESTAMPTZ,
  motivo        TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  usuario_id    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_cierre TEXT CHECK (motivo_cierre IS NULL OR length(trim(motivo_cierre)) > 0),
  cerrado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  CHECK (origen_id <> destino_id),
  CHECK (hasta IS NULL OR hasta >= desde),
  CHECK ((hasta IS NULL) = (motivo_cierre IS NULL)),
  FOREIGN KEY (tenant_id, origen_id)  REFERENCES combustible_lugares (tenant_id, id),
  FOREIGN KEY (tenant_id, destino_id) REFERENCES combustible_lugares (tenant_id, id)
);

-- Un solo conductor vigente por unidad; la misma ruta no puede estar vigente
-- dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipo_conductores_vigente
  ON equipo_conductores (equipo_id) WHERE hasta IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipo_rutas_vigente
  ON equipo_rutas (equipo_id, origen_id, destino_id) WHERE hasta IS NULL;

CREATE INDEX IF NOT EXISTS idx_equipo_conductores_equipo
  ON equipo_conductores (tenant_id, equipo_id, desde);
-- "¿Qué unidades manejó este conductor?" (incidencias).
CREATE INDEX IF NOT EXISTS idx_equipo_conductores_dni
  ON equipo_conductores (tenant_id, conductor_dni, desde) WHERE conductor_dni IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_equipo_conductores_usuario
  ON equipo_conductores (usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_equipo_conductores_cerrado_por
  ON equipo_conductores (cerrado_por) WHERE cerrado_por IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_equipo_rutas_equipo
  ON equipo_rutas (tenant_id, equipo_id, desde);
CREATE INDEX IF NOT EXISTS idx_equipo_rutas_origen
  ON equipo_rutas (tenant_id, origen_id);
CREATE INDEX IF NOT EXISTS idx_equipo_rutas_destino
  ON equipo_rutas (tenant_id, destino_id);
CREATE INDEX IF NOT EXISTS idx_equipo_rutas_usuario
  ON equipo_rutas (usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_equipo_rutas_cerrado_por
  ON equipo_rutas (cerrado_por) WHERE cerrado_por IS NOT NULL;

-- ── Lo pasado no se reescribe ───────────────────────────────────────────────
-- Solo se puede CERRAR una fila vigente, una vez. Los autores (usuario_id,
-- cerrado_por) solo pueden pasar a NULL -- es lo que hace ON DELETE SET NULL
-- al borrar al usuario --, nunca a OTRA persona: atribuirle un cambio a quien
-- no lo hizo es justamente reescribir el historial.
CREATE OR REPLACE FUNCTION equipo_historial_inmutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  campos_libres TEXT[] := ARRAY['hasta', 'motivo_cierre', 'cerrado_por', 'usuario_id'];
BEGIN
  IF (to_jsonb(NEW) - campos_libres) IS DISTINCT FROM (to_jsonb(OLD) - campos_libres) THEN
    RAISE EXCEPTION 'El historial de equipos no se reescribe: solo se puede cerrar una asignación vigente'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.usuario_id IS DISTINCT FROM OLD.usuario_id AND NEW.usuario_id IS NOT NULL THEN
    RAISE EXCEPTION 'El historial de equipos no se reescribe: el autor de una asignación no cambia'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.hasta IS NOT NULL THEN
    IF NEW.hasta IS DISTINCT FROM OLD.hasta
       OR NEW.motivo_cierre IS DISTINCT FROM OLD.motivo_cierre
       OR (NEW.cerrado_por IS DISTINCT FROM OLD.cerrado_por AND NEW.cerrado_por IS NOT NULL) THEN
      RAISE EXCEPTION 'Esta asignación ya está cerrada y no se puede modificar'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_equipo_conductores_inmutable ON equipo_conductores;
CREATE TRIGGER trg_equipo_conductores_inmutable BEFORE UPDATE ON equipo_conductores
  FOR EACH ROW EXECUTE FUNCTION equipo_historial_inmutable();
DROP TRIGGER IF EXISTS trg_equipo_rutas_inmutable ON equipo_rutas;
CREATE TRIGGER trg_equipo_rutas_inmutable BEFORE UPDATE ON equipo_rutas
  FOR EACH ROW EXECUTE FUNCTION equipo_historial_inmutable();

-- ── Los conductores que ya estaban cargados ─────────────────────────────────
INSERT INTO equipo_conductores (tenant_id, equipo_id, conductor_nombre, conductor_dni, motivo)
SELECT e.tenant_id, e.id, e.conductor_nombre, e.conductor_dni,
       'Asignación vigente al activarse el historial'
  FROM equipos e
 WHERE (e.conductor_nombre IS NOT NULL OR e.conductor_dni IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM equipo_conductores c WHERE c.equipo_id = e.id AND c.hasta IS NULL);

-- ── Medidor por tipo: solo donde todavía no se configuró ────────────────────
UPDATE equipos SET tipo_medidor = 'horometro'
 WHERE tipo_medidor IS NULL
   AND (lower(trim(tipo)) LIKE 'volquete%'
        OR lower(trim(tipo)) LIKE 'excavadora%'
        OR lower(trim(tipo)) LIKE 'retroexcavadora%');
UPDATE equipos SET tipo_medidor = 'odometro'
 WHERE tipo_medidor IS NULL
   AND (lower(trim(tipo)) LIKE 'camioneta%'
        OR lower(trim(tipo)) LIKE 'tracto%');

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE equipo_conductores ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipo_rutas ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['equipo_conductores', 'equipo_rutas'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I
           USING (tenant_id = current_setting(''app.tenant_id'')::uuid)
           WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;

-- FORCE al final (gotcha de 0097): las FKs de arriba se validan contra tablas
-- con RLS.
ALTER TABLE equipos FORCE ROW LEVEL SECURITY;
ALTER TABLE equipo_conductores FORCE ROW LEVEL SECURITY;
ALTER TABLE equipo_rutas FORCE ROW LEVEL SECURITY;
