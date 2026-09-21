-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: PRECINTOS NUMERADOS del tanque
--
-- El robo por FUERA del surtidor (balde por la boca, válvula de drenaje) no lo
-- ve el totalizador, y la varilla solo lo ve por encima de su error (±150 L).
-- El precinto no lo MIDE: lo IMPIDE o lo deja a la vista. Es un sello con un
-- número impreso que, una vez cortado, no se vuelve a cerrar. El control está
-- en anotar el número: si en la varilla el número que se ve no es el
-- registrado, alguien abrió el tanque.
--
-- Hay aperturas legítimas (la recepción abre la boca de llenado), así que
-- cada apertura se registra como un CAMBIO de precinto (se colocó el N°X, con
-- motivo). Lo que no está registrado es la alerta.
--
-- Nace APAGADO por tanque (`usa_precintos`), igual que el totalizador (0094):
-- un cliente sin precintos no tiene que ver ni un campo de más.
--
-- Tres tablas, todas append-only:
--   puntos         -- DÓNDE hay un precinto (boca de llenado, drenaje...).
--   precintos      -- CADA colocación. El vigente de un punto en un instante
--                     es la última colocación hasta ese instante: no hay
--                     "retirado_en", la colocación siguiente ES el retiro.
--   verificaciones -- lo que se VIO en cada varilla, contra lo esperado.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS usa_precintos BOOLEAN NOT NULL DEFAULT false;

-- ── 1. Los puntos precintados de cada tanque ────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_precinto_puntos (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- CASCADE, igual que combustible_lecturas: un punto no existe sin su tanque.
  combustible_id        INTEGER NOT NULL REFERENCES combustible(id) ON DELETE CASCADE,
  -- Texto del cliente ("boca de llenado", "drenaje 2"): cada tanque es
  -- distinto y un enum obligaría a migrar por cada caso nuevo.
  nombre                VARCHAR(60) NOT NULL CHECK (length(trim(nombre)) > 0),
  -- La recepción EXIGE cambiar el precinto de estos puntos: es la apertura
  -- legítima de todos los días, y sin esto cada recepción daría una alerta.
  se_abre_en_recepcion  BOOLEAN NOT NULL DEFAULT false,
  -- Desactivar un punto es dejar de vigilarlo: lleva motivo y queda en la
  -- bitácora como aflojamiento, no se borra.
  activo                BOOLEAN NOT NULL DEFAULT true,
  motivo_baja           TEXT,
  creado_por            UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (activo OR length(trim(coalesce(motivo_baja, ''))) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_combustible_precinto_puntos_nombre
  ON combustible_precinto_puntos (tenant_id, combustible_id, lower(trim(nombre)));
CREATE INDEX IF NOT EXISTS idx_combustible_precinto_puntos_creado_por
  ON combustible_precinto_puntos (creado_por) WHERE creado_por IS NOT NULL;

-- ── 2. Cada colocación de un precinto ───────────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_precintos (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  punto_id      INTEGER NOT NULL REFERENCES combustible_precinto_puntos(id) ON DELETE CASCADE,
  -- NORMALIZADO por el servidor (mayúsculas, sin espacios ni guiones, sin
  -- ceros a la izquierda si es solo número): "00-1234" y "1234" son el mismo
  -- sello, y compararlos crudos daría alertas falsas por cómo se tipeó.
  numero        VARCHAR(40) NOT NULL CHECK (length(numero) > 0),
  colocado_en   TIMESTAMPTZ NOT NULL,
  colocado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo        TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  -- La recepción que lo cambió, si fue en una. SET NULL: el wipe de tenant
  -- borra las recepciones antes que los tanques (ver registry.ts), y el
  -- cambio de sello pasó igual aunque la recepción ya no esté.
  recepcion_id  BIGINT REFERENCES combustible_recepciones(id) ON DELETE SET NULL,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un número de precinto se usa UNA vez en la vida de la empresa. Reusarlo es
-- la forma de volver a "cerrar" un sello cortado con un número que el
-- sistema ya conoce.
CREATE UNIQUE INDEX IF NOT EXISTS idx_combustible_precintos_numero
  ON combustible_precintos (tenant_id, numero);
-- El vigente de un punto en un instante: la última colocación hasta ahí.
CREATE INDEX IF NOT EXISTS idx_combustible_precintos_punto_fecha
  ON combustible_precintos (tenant_id, punto_id, colocado_en DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_combustible_precintos_colocado_por
  ON combustible_precintos (colocado_por) WHERE colocado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_precintos_recepcion
  ON combustible_precintos (recepcion_id) WHERE recepcion_id IS NOT NULL;

-- ── 3. Lo que se vio en cada varilla ────────────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_precinto_verificaciones (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lectura_id       BIGINT NOT NULL REFERENCES combustible_lecturas(id) ON DELETE CASCADE,
  punto_id         INTEGER NOT NULL REFERENCES combustible_precinto_puntos(id) ON DELETE CASCADE,
  -- NULL = "no hay precinto": el sello no está. Es un hallazgo, no un dato
  -- que falta.
  numero_visto     VARCHAR(40),
  -- El vigente AL MOMENTO DE LA MEDICIÓN (leido_en), no el de ahora: una
  -- varilla offline que llega después de una recepción se compara contra el
  -- precinto que había cuando se midió.
  numero_esperado  VARCHAR(40) NOT NULL,
  coincide         BOOLEAN NOT NULL,
  UNIQUE (lectura_id, punto_id)
);

CREATE INDEX IF NOT EXISTS idx_combustible_precinto_verif_punto
  ON combustible_precinto_verificaciones (tenant_id, punto_id);

-- ── RLS: mismo aislamiento por tenant que el resto del módulo ──────────
ALTER TABLE combustible_precinto_puntos ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_precinto_puntos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_precintos ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_precintos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_precinto_verificaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_precinto_verificaciones FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'combustible_precinto_puntos', 'combustible_precintos', 'combustible_precinto_verificaciones'
  ] LOOP
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

-- ── Los dos tipos de alerta nuevos ──────────────────────────────────────
-- precinto_alterado: en la varilla, el número visto no es el registrado (o
--   no había precinto). Alguien abrió el tanque sin registrarlo.
-- precinto_reemplazado: se cambió un precinto FUERA de una recepción. Se
--   permite (un sello se rompe de verdad), pero es exactamente la puerta que
--   usaría el que roba: corta, drena, pone uno nuevo y escribe
--   "mantenimiento". No se puede impedir; tiene que quedar a la vista.
-- Los dos son hallazgos: se congelan como anomalía si nadie los explica.
ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
    'tanque_sin_vigilancia',
    'recepcion_anulada', 'recepcion_discrepante', 'recepcion_sin_validar',
    'recepcion_retroactiva', 'consumo_excedido', 'varilla_sin_control',
    'varilla_exacta',
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso',
    'precinto_alterado', 'precinto_reemplazado'
  ));

ALTER TABLE combustible_anomalias
  DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;
ALTER TABLE combustible_anomalias
  ADD CONSTRAINT combustible_anomalias_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
    'recepcion_anulada', 'recepcion_discrepante', 'recepcion_retroactiva',
    'consumo_excedido', 'varilla_exacta',
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso',
    'precinto_alterado', 'precinto_reemplazado'
  ));
