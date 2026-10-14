-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: corregir los litros de un envase de urea, con su historial
--
-- Ver docs/architecture/urea-industrial.md (entrega 9).
--
-- ── El problema ─────────────────────────────────────────────────────────────
--
-- Desde la entrega 8 los litros de un envase con movimientos son FIJOS:
-- cambiarlos dejaba el envase mezclado (17 cajas registradas a 16 L con el
-- catálogo en 20 L). Eso cubre "el envase cambió de tamaño" (es otro envase),
-- pero no "se dio de alta mal": la caja siempre fue de 20 L y alguien digitó
-- 16. Para ese caso hace falta corregir el HISTORIAL del envase entero, de una
-- vez, dejando cada valor anterior a la vista.
--
-- Corregir es reescribir litros y costos de filas ya cargadas. En un módulo
-- anti-fraude eso no puede ser silencioso: inflar los litros de un envase es
-- la forma más rápida de tapar un faltante. Por eso:
--
--   • `combustible_urea_correcciones`: quién, cuándo, de cuánto a cuánto, por
--     qué, y el impacto completo.
--   • `combustible_urea_correccion_filas`: cada fila que se tocó, con su valor
--     ANTES y DESPUÉS. Nada se pierde.
--   • `urea_litros_corregidos`: un hallazgo para gerencia, anclado a la
--     corrección (sexta ancla de alertas).
--
-- ── Por qué `costo_origen` ──────────────────────────────────────────────────
--
-- El costo de un vale del almacén sale de dos lugares: lo declaran (precio por
-- bulto, guardado por litro) o es el PROMEDIO de las entradas a esa fecha
-- (resolverCostoUrea). Al corregir los litros esas dos cosas se recalculan
-- distinto -- la declarada conserva el precio por bulto; la del promedio se
-- vuelve a promediar con las entradas corregidas -- y el vale no guardaba de
-- cuál venía. Desde acá lo guarda. Las filas viejas quedan en NULL
-- ("desconocido"), sin default: la corrección lo deduce y deja escrito en
-- `combustible_urea_correccion_filas.regla` qué deducción aplicó.
--
-- ── Por qué el conteo guarda sus renglones ──────────────────────────────────
--
-- Desde #259 el conteo acepta "17 cajas + 32 bolsas", pero guardaba solo el
-- total en litros. Corregir la caja de 16 a 20 L no podría tocar ese conteo:
-- seguiría diciendo 272 L contra un stock que pasa a 340 L, un faltante falso
-- de 68 L. Con los renglones guardados, la corrección arregla el conteo igual
-- que las entradas y los vales. Los conteos viejos no tienen detalle: no se
-- reconstruyen (no hay de dónde), la corrección los informa como "no
-- recalculables".
-- ═══════════════════════════════════════════════════════════════════════════

-- Las FK nuevas validan filas con una consulta que SÍ pasa por RLS, y sin
-- `app.tenant_id` de sesión falla. Ventana NO FORCE dentro de la transacción
-- que migrate.ts abre para el archivo (mismo patrón que 0116/0120).
ALTER TABLE combustible_alertas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_anomalias NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_conteos_urea NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_presentaciones NO FORCE ROW LEVEL SECURITY;

-- ── 1. De dónde salió el costo de un despacho de urea ──────────────────────

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS costo_origen VARCHAR(12);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_costo_origen_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_costo_origen_check
      -- declarado: precio por bulto que trajo el vale; promedio: el de las
      -- entradas a esa fecha; boleta: la compra en ruta (renglones).
      CHECK (costo_origen IS NULL OR costo_origen IN ('declarado', 'promedio', 'boleta'));
  END IF;
END $$;

-- ── 2. Los renglones del conteo físico ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS combustible_conteo_urea_lineas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conteo_id       BIGINT NOT NULL REFERENCES combustible_conteos_urea(id) ON DELETE CASCADE,
  presentacion    VARCHAR(20) NOT NULL,
  factor_litros   NUMERIC(8, 2) NOT NULL CHECK (factor_litros > 0),
  -- Puede ser 0: "contamos y no hay bolsas" es un dato, distinto de no contar.
  cantidad_bultos INTEGER NOT NULL CHECK (cantidad_bultos >= 0),
  litros          NUMERIC(12, 2) NOT NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (litros = cantidad_bultos * factor_litros),
  UNIQUE (conteo_id, presentacion),
  -- Compuesta: la verificación de una FK no pasa por RLS (ver 0116).
  FOREIGN KEY (tenant_id, presentacion)
    REFERENCES combustible_urea_presentaciones (tenant_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_conteo_urea_lineas_presentacion
  ON combustible_conteo_urea_lineas (tenant_id, presentacion);

ALTER TABLE combustible_conteo_urea_lineas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_conteo_urea_lineas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_conteo_urea_lineas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── 3. La corrección y cada fila que tocó ───────────────────────────────────

CREATE TABLE IF NOT EXISTS combustible_urea_correcciones (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  presentacion    VARCHAR(20) NOT NULL,
  litros_antes    NUMERIC(8, 2) NOT NULL CHECK (litros_antes > 0),
  litros_despues  NUMERIC(8, 2) NOT NULL CHECK (litros_despues > 0),
  motivo          TEXT NOT NULL CHECK (length(btrim(motivo)) > 0),
  usuario_id      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  -- El impacto tal como se mostró en la vista previa: stock antes y después,
  -- cuántas filas de cada tipo, conteos sin detalle.
  resumen         JSONB NOT NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- SIN CHECK (litros_despues <> litros_antes) a propósito: el caso real es
  -- un catálogo que ya dice 20 L con filas registradas a 16 L. La corrección
  -- deja las filas en 20 L aunque el catálogo no cambie; los factores con
  -- que estaban registradas quedan en `resumen` y en cada fila corregida.
  FOREIGN KEY (tenant_id, presentacion)
    REFERENCES combustible_urea_presentaciones (tenant_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_urea_correcciones_tenant
  ON combustible_urea_correcciones (tenant_id, creado_en DESC);
-- La FK compuesta al catálogo y la de usuario necesitan su índice
-- (tests/db-index-coverage.test.ts).
CREATE INDEX IF NOT EXISTS idx_urea_correcciones_presentacion
  ON combustible_urea_correcciones (tenant_id, presentacion);
CREATE INDEX IF NOT EXISTS idx_urea_correcciones_usuario
  ON combustible_urea_correcciones (usuario_id) WHERE usuario_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS combustible_urea_correccion_filas (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  correccion_id  BIGINT NOT NULL REFERENCES combustible_urea_correcciones(id) ON DELETE CASCADE,
  -- Qué tabla y qué fila. Sin FK a cada una a propósito: son cinco tablas
  -- distintas, y el registro tiene que sobrevivir aunque la fila se anule.
  tabla          VARCHAR(20) NOT NULL CHECK (tabla IN (
                   'entrada', 'vale', 'compra', 'compra_renglon', 'conteo', 'conteo_renglon'
                 )),
  fila_id        BIGINT NOT NULL,
  antes          JSONB NOT NULL,
  despues        JSONB NOT NULL,
  -- Cómo se recalculó el costo de un vale: declarado, promedio, o la
  -- deducción aplicada a uno viejo sin `costo_origen`.
  regla          VARCHAR(24),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_urea_correccion_filas_correccion
  ON combustible_urea_correccion_filas (correccion_id);
CREATE INDEX IF NOT EXISTS idx_urea_correccion_filas_tenant
  ON combustible_urea_correccion_filas (tenant_id, correccion_id);

ALTER TABLE combustible_urea_correcciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_correccion_filas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_urea_correcciones'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_urea_correcciones
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_urea_correccion_filas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_urea_correccion_filas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── 4. El hallazgo, con su propia ancla ─────────────────────────────────────

ALTER TABLE combustible_alertas
  ADD COLUMN IF NOT EXISTS urea_correccion_id BIGINT
    REFERENCES combustible_urea_correcciones(id) ON DELETE CASCADE;
ALTER TABLE combustible_anomalias
  ADD COLUMN IF NOT EXISTS urea_correccion_id BIGINT
    REFERENCES combustible_urea_correcciones(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_combustible_alertas_urea_correccion
  ON combustible_alertas (urea_correccion_id) WHERE urea_correccion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_urea_correccion
  ON combustible_anomalias (urea_correccion_id) WHERE urea_correccion_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_ancla_check;
  ALTER TABLE combustible_alertas
    ADD CONSTRAINT combustible_alertas_ancla_check
    CHECK (
      (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
      OR combustible_id IS NOT NULL
      OR recepcion_id IS NOT NULL
      OR urea_conteo_id IS NOT NULL
      OR despacho_id IS NOT NULL
      OR urea_correccion_id IS NOT NULL
    );

  ALTER TABLE combustible_anomalias DROP CONSTRAINT IF EXISTS combustible_anomalias_ancla_check;
  ALTER TABLE combustible_anomalias
    ADD CONSTRAINT combustible_anomalias_ancla_check
    CHECK (
      (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
      OR combustible_id IS NOT NULL
      OR recepcion_id IS NOT NULL
      OR urea_conteo_id IS NOT NULL
      OR despacho_id IS NOT NULL
      OR urea_correccion_id IS NOT NULL
    );

  ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
  ALTER TABLE combustible_alertas
    ADD CONSTRAINT combustible_alertas_tipo_check
    CHECK (tipo IN (
      'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
      'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
      'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
      'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
      'tanque_sin_vigilancia', 'recepcion_sin_validar', 'varilla_sin_control',
      'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
      'recepcion_anulada', 'recepcion_discrepante', 'recepcion_retroactiva',
      'consumo_excedido', 'varilla_exacta',
      'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
      'urea_stock_bajo', 'urea_stock_excedido',
      'urea_conteo_recargado',
      'urea_precio_fuera_de_catalogo',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada',
      'vale_excede_tanque',
      'comprobante_sin_foto',
      -- 0130
      'urea_litros_corregidos'
    ));

  -- Es un HALLAZGO (no deja de ser verdad): va también en la lista de
  -- anomalías, o el worker no podría congelarlo.
  ALTER TABLE combustible_anomalias DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;
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
      'urea_stock_excedido',
      'urea_conteo_recargado',
      'urea_precio_fuera_de_catalogo',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada',
      'vale_excede_tanque',
      'urea_litros_corregidos'
    ));
END $$;

-- ── Fin de la ventana NO FORCE ──────────────────────────────────────────────

ALTER TABLE combustible_alertas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_anomalias FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_conteos_urea FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_presentaciones FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_conteo_urea_lineas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_correcciones FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_correccion_filas FORCE ROW LEVEL SECURITY;
