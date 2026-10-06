-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: catálogo de precios de urea, y la alerta de precio fuera de él
--
-- Kenif, 2026-10-05: "¿no sería posible poner una pestaña donde se grabe el
-- precio de la urea, marca, etc., y luego al registrar jale automáticamente?".
-- Decisiones suyas: precio por PROVEEDOR y PRESENTACIÓN (cada grifo cobra
-- distinto), la marca como referencia, y una alerta si la boleta se aparta
-- del catálogo más de un 10 %.
--
-- ── El mismo modelo que combustible_precios (0063) ─────────────────────────
--
-- El precio se APILA con su `vigente_desde`, nunca se pisa: si PRIMAX sube la
-- caja, se carga un precio nuevo y el anterior queda como historia. Se busca
-- "el más reciente <= la fecha de la compra", no "el más reciente a secas":
-- una compra offline que llega tarde se compara contra el precio de SU día.
-- Un precio mal cargado se ANULA con motivo, nunca se borra ni se edita.
--
-- ── Dónde se usa y dónde no ────────────────────────────────────────────────
--
-- Autocompleta el precio en la COMPRA EN RUTA y en la ENTRADA al almacén, y
-- queda editable: manda lo que dice el papel. NO se usa en el vale del
-- almacén: ese lleva el costo promedio de lo que la empresa efectivamente
-- pagó por la urea que está en el depósito, que es otro número que el precio
-- de lista de hoy.
--
-- ── La alerta ──────────────────────────────────────────────────────────────
--
-- `urea_precio_fuera_de_catalogo`: una compra en ruta declara, para alguna
-- presentación, un precio por bulto que se aparta del catálogo vigente de ese
-- proveedor más que la tolerancia. Es el caso del conductor que declara S/ 80
-- la caja cuando el precio pactado es S/ 50. No bloquea: el grifo pudo haber
-- subido el precio, y la compra tiene que quedar registrada igual.
--
-- Es un HALLAZGO (entra en las dos listas): "esta boleta declaró un precio
-- distinto" sigue siendo cierto aunque mañana se actualice el catálogo.
--
-- La tolerancia es un número de la config, no del código. Arranca en 10 %
-- porque Kenif lo aprobó así (2026-10-05). NULL = no alerta. Subirla o
-- apagarla AFLOJA y pide motivo (evaluarAflojamientoConfig).
--
-- Aplicar: `npm run migrate`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. El catálogo ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_urea_precios (
  id               SERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Sin ON DELETE, igual que combustible_precios.grifo_id: un proveedor no se
  -- borra (se desactiva), y si alguna vez se borrara, su historia de precios
  -- no debería irse con él en silencio. Por eso la tabla va en `raices`.
  grifo_id         INTEGER NOT NULL REFERENCES combustible_grifos(id),
  presentacion     VARCHAR(20) NOT NULL,
  -- Referencia: "Green 32", "AdBlue". Texto libre a propósito (decisión de
  -- Kenif): no hay reportes por marca, y un catálogo de marcas sería
  -- mantenimiento sin uso.
  marca            VARCHAR(80),
  precio_por_bulto NUMERIC(10, 4) NOT NULL CHECK (precio_por_bulto > 0),
  vigente_desde    TIMESTAMPTZ NOT NULL,
  usuario_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  anulada_en       TIMESTAMPTZ,
  anulada_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_anulacion TEXT,
  CHECK (
    (anulada_en IS NULL AND anulada_por IS NULL AND motivo_anulacion IS NULL)
    OR (anulada_en IS NOT NULL AND length(trim(motivo_anulacion)) > 0)
  ),
  -- Compuesta, mismo motivo que en 0116/0120: la verificación de una FK no
  -- pasa por RLS.
  FOREIGN KEY (tenant_id, presentacion)
    REFERENCES combustible_urea_presentaciones (tenant_id, codigo)
);

-- "El precio vigente de esta presentación en este proveedor a esta fecha":
-- corre en cada compra en ruta. Parcial sobre los no anulados.
CREATE INDEX IF NOT EXISTS idx_urea_precios_vigente
  ON combustible_urea_precios (tenant_id, grifo_id, presentacion, vigente_desde DESC)
  WHERE anulada_en IS NULL;
-- Cobertura de las FK (tests/db-index-coverage.test.ts).
CREATE INDEX IF NOT EXISTS idx_urea_precios_grifo ON combustible_urea_precios (grifo_id);
CREATE INDEX IF NOT EXISTS idx_urea_precios_presentacion
  ON combustible_urea_precios (tenant_id, presentacion);
CREATE INDEX IF NOT EXISTS idx_urea_precios_usuario
  ON combustible_urea_precios (usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_urea_precios_anulada_por
  ON combustible_urea_precios (anulada_por) WHERE anulada_por IS NOT NULL;

ALTER TABLE combustible_urea_precios ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_precios FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_urea_precios'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_urea_precios
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── 2. La tolerancia, en la config ─────────────────────────────────────────
ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS tolerancia_precio_urea_pct NUMERIC(5, 2) DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_tolerancia_precio_urea_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_tolerancia_precio_urea_check
      -- Mayor que 0: con 0, cualquier centavo de redondeo en la boleta sería
      -- una alerta. Para no alertar está NULL.
      CHECK (tolerancia_precio_urea_pct IS NULL
             OR (tolerancia_precio_urea_pct > 0 AND tolerancia_precio_urea_pct <= 100));
  END IF;
END $$;

-- ── 3. El tipo de alerta, en las dos listas (es un hallazgo) ───────────────
DO $$
BEGIN
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
      -- 0121
      'urea_precio_fuera_de_catalogo',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada'
    ));

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
      'tanqueta_sobregirada'
    ));
END $$;
