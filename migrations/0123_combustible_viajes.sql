-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: VIAJES (recorrido de una unidad de un lugar a otro)
--
-- Un viaje es A → B (ida). El regreso es otro viaje con su ruta propia: vacío
-- consume distinto que cargado. "cuenta_como" (1 por defecto, editable) deja
-- que una empresa cuente ida+vuelta como un solo viaje si así lo mide.
--
-- ── Las cargas del viaje se DERIVAN, no se guardan ─────────────────────────
-- Un despacho pertenece al viaje si es de la misma unidad y su despachado_en
-- cae en [inicio_en − margen, fin_en]. El margen (config) cubre la carga que se
-- hace ANTES de salir. Sin columna viaje_id en despachos: el grifero no elige
-- nada, un viaje registrado después agrupa solo, y corregir una hora no deja
-- asociaciones desfasadas. Sirve igual para combustible y urea (misma tabla de
-- despachos, columna producto).
--
-- ── Programado → en curso → cerrado ────────────────────────────────────────
-- La oficina PROGRAMA el viaje (unidad, conductor, ruta) y quien sale lo
-- INICIA: ahí el servidor pone la hora (inicio_en), nunca el reloj del
-- navegador. Un viaje programado no tiene salida todavía, por eso inicio_en es
-- NULL hasta iniciarlo y no cuenta cargas.
--
-- medidor_previo es la lectura con que la unidad llegó del viaje anterior (o
-- la última carga): queda congelada. Lo que el conductor lee en el tablero al
-- salir menos ese valor es lo que la unidad anduvo FUERA de un viaje.
--
-- ruta_por_confirmar: el conductor salió con la ruta o la unidad mal cargada y
-- avisó a la oficina. No se le bloquea la salida; mientras no se confirme, el
-- viaje no entra a los promedios por ruta.
--
-- Para que un despacho no caiga en dos viajes, los viajes no anulados de una
-- unidad no se traslapan. Eso lo garantiza el service con un candado por
-- unidad (sin btree_gist no hay EXCLUDE con equipo_id).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_lugares (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre      VARCHAR(80) NOT NULL CHECK (length(trim(nombre)) > 0),
  activo      BOOLEAN NOT NULL DEFAULT true,
  creado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lugares_nombre
  ON combustible_lugares (tenant_id, lower(trim(nombre)));
CREATE INDEX IF NOT EXISTS idx_lugares_creado_por
  ON combustible_lugares (creado_por) WHERE creado_por IS NOT NULL;

CREATE TABLE IF NOT EXISTS combustible_viajes (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  numero            INTEGER NOT NULL CHECK (numero > 0),
  equipo_id         INTEGER NOT NULL REFERENCES equipos(id),
  -- Copia del conductor al momento del viaje: rotan entre unidades (0083).
  conductor_nombre  VARCHAR(150),
  conductor_dni     VARCHAR(15),
  origen_id         BIGINT NOT NULL,
  destino_id        BIGINT NOT NULL,
  inicio_en         TIMESTAMPTZ,
  fin_en            TIMESTAMPTZ,
  medidor_previo    NUMERIC(12,1) CHECK (medidor_previo IS NULL OR medidor_previo >= 0),
  medidor_inicio    NUMERIC(12,1) CHECK (medidor_inicio IS NULL OR medidor_inicio >= 0),
  medidor_fin       NUMERIC(12,1) CHECK (medidor_fin IS NULL OR medidor_fin >= 0),
  cuenta_como       NUMERIC(4,2) NOT NULL DEFAULT 1 CHECK (cuenta_como > 0 AND cuenta_como <= 10),
  estado            VARCHAR(10) NOT NULL DEFAULT 'programado'
                    CHECK (estado IN ('programado', 'en_curso', 'cerrado', 'anulado')),
  ruta_por_confirmar BOOLEAN NOT NULL DEFAULT false,
  nota_ruta         TEXT,
  iniciado_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  observaciones     TEXT,
  motivo_anulacion  TEXT,
  anulado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  anulado_en        TIMESTAMPTZ,
  cerrado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_por        UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, numero),
  FOREIGN KEY (tenant_id, origen_id)  REFERENCES combustible_lugares (tenant_id, id),
  FOREIGN KEY (tenant_id, destino_id) REFERENCES combustible_lugares (tenant_id, id),
  CHECK (origen_id <> destino_id),
  CHECK (fin_en IS NULL OR fin_en > inicio_en),
  CHECK (medidor_inicio IS NULL OR medidor_fin IS NULL OR medidor_fin >= medidor_inicio),
  CHECK (estado <> 'en_curso' OR fin_en IS NULL),
  CHECK (estado IN ('programado', 'anulado') OR inicio_en IS NOT NULL),
  CHECK (estado <> 'programado' OR (inicio_en IS NULL AND fin_en IS NULL)),
  CHECK (estado <> 'cerrado' OR fin_en IS NOT NULL),
  CHECK (estado <> 'anulado' OR length(trim(coalesce(motivo_anulacion, ''))) > 0)
);

-- Una unidad no está en dos viajes a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_viajes_un_en_curso_por_equipo
  ON combustible_viajes (tenant_id, equipo_id) WHERE estado = 'en_curso';
CREATE INDEX IF NOT EXISTS idx_viajes_equipo_inicio
  ON combustible_viajes (tenant_id, equipo_id, inicio_en) WHERE estado <> 'anulado';
CREATE INDEX IF NOT EXISTS idx_viajes_inicio
  ON combustible_viajes (tenant_id, inicio_en);
CREATE INDEX IF NOT EXISTS idx_viajes_origen ON combustible_viajes (tenant_id, origen_id);
CREATE INDEX IF NOT EXISTS idx_viajes_destino ON combustible_viajes (tenant_id, destino_id);
CREATE INDEX IF NOT EXISTS idx_viajes_equipo ON combustible_viajes (equipo_id);
CREATE INDEX IF NOT EXISTS idx_viajes_creado_por
  ON combustible_viajes (creado_por) WHERE creado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viajes_iniciado_por
  ON combustible_viajes (iniciado_por) WHERE iniciado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viajes_programados
  ON combustible_viajes (tenant_id, equipo_id) WHERE estado = 'programado';
CREATE INDEX IF NOT EXISTS idx_viajes_cerrado_por
  ON combustible_viajes (cerrado_por) WHERE cerrado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_viajes_anulado_por
  ON combustible_viajes (anulado_por) WHERE anulado_por IS NOT NULL;

ALTER TABLE combustible_lugares ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_viajes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_lugares'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_lugares
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_viajes'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_viajes
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- FORCE al final: las FKs compuestas de arriba se validan contra lugares
-- (gotcha de 0097).
ALTER TABLE combustible_lugares FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_viajes FORCE ROW LEVEL SECURITY;

-- ── El margen previo, en la config ─────────────────────────────────────────
-- Horas antes del inicio en que una carga todavía cuenta para el viaje (la
-- tanqueada antes de salir).
ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS viaje_margen_previo_horas INT NOT NULL DEFAULT 6;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_viaje_margen_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_viaje_margen_check
      CHECK (viaje_margen_previo_horas BETWEEN 0 AND 48);
  END IF;
END $$;
