-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el vale del almacén y la entrada de urea llevan renglones
--
-- Ver docs/architecture/urea-industrial.md (entrega 10).
--
-- ── El problema ─────────────────────────────────────────────────────────────
--
-- Un volquete carga "1 caja + 2 bolsas" en un mismo vale, y una factura trae
-- cajas y bolsas juntas. Hasta acá el vale del almacén y la entrada guardaban
-- UNA presentación en la propia fila: lo segundo había que partirlo en dos
-- vales con el mismo número de talonario (imposible) y lo segundo en dos
-- entradas de la misma factura.
--
-- ── Una sola forma ──────────────────────────────────────────────────────────
--
-- Igual que la compra en ruta desde 0120: el detalle vive SIEMPRE en
-- renglones, aunque sea uno solo. La fila guarda el total (litros y costo por
-- litro del total) y deja presentación, factor y bultos en NULL. Dos formas a
-- la vez obligarían a cada reporte a leer de dos lugares, y el primero que se
-- olvide descuadra el stock.
--
--   • vale del almacén → combustible_despacho_urea_lineas (la de la compra
--     en ruta; el `origen` del despacho dice de cuál se trata);
--   • entrada          → combustible_recepcion_urea_lineas (nueva).
--
-- ── El precio por bulto de cada renglón ────────────────────────────────────
--
-- `costo_por_bulto` pasa a admitir NULL en los renglones de despacho: un vale
-- del almacén que tomó el PROMEDIO de las entradas no tiene un precio por
-- bulto propio. Declarado (o compra en ruta), lo tiene. En la entrada siempre
-- lo tiene: es lo que dice la factura.
--
-- ── La copia de lo existente ────────────────────────────────────────────────
--
-- Cada vale del almacén y cada entrada de urea pasa a tener UN renglón con sus
-- mismos datos; nada se recalcula, los litros y costos quedan idénticos.
-- Idempotente: copia solo filas que todavía tienen presentación, y ON
-- CONFLICT por (fila, presentación).
--
--   • entrada: costo_por_bulto = costo por litro × factor (siempre declarado);
--   • vale declarado: igual; vale a promedio o viejo sin costo_origen: NULL
--     (no hay precio por bulto propio; la corrección de litros lo deduce).
-- ═══════════════════════════════════════════════════════════════════════════

-- Ventana NO FORCE: la copia y las FK nuevas validan filas con consultas que
-- pasan por RLS, y migrate.ts no tiene `app.tenant_id` (ver 0116/0120).
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despacho_urea_lineas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_presentaciones NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_correccion_filas NO FORCE ROW LEVEL SECURITY;

-- ── 1. El precio por bulto del renglón de despacho puede faltar ─────────────

ALTER TABLE combustible_despacho_urea_lineas ALTER COLUMN costo_por_bulto DROP NOT NULL;
ALTER TABLE combustible_despacho_urea_lineas
  DROP CONSTRAINT IF EXISTS combustible_despacho_urea_lineas_costo_por_bulto_check;
ALTER TABLE combustible_despacho_urea_lineas
  ADD CONSTRAINT combustible_despacho_urea_lineas_costo_por_bulto_check
  CHECK (costo_por_bulto IS NULL OR costo_por_bulto > 0);

-- ── 2. Los renglones de la entrada ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS combustible_recepcion_urea_lineas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recepcion_id    BIGINT NOT NULL REFERENCES combustible_recepciones(id) ON DELETE CASCADE,
  presentacion    VARCHAR(20) NOT NULL,
  factor_litros   NUMERIC(8, 2) NOT NULL CHECK (factor_litros > 0),
  cantidad_bultos INTEGER NOT NULL CHECK (cantidad_bultos > 0),
  litros          NUMERIC(12, 2) NOT NULL,
  -- Lo que dice la factura, por bulto.
  costo_por_bulto NUMERIC(10, 4) NOT NULL CHECK (costo_por_bulto > 0),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (litros = cantidad_bultos * factor_litros),
  UNIQUE (recepcion_id, presentacion),
  -- Compuesta: la verificación de una FK no pasa por RLS (ver 0116).
  FOREIGN KEY (tenant_id, presentacion)
    REFERENCES combustible_urea_presentaciones (tenant_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_recepcion_urea_lineas_presentacion
  ON combustible_recepcion_urea_lineas (tenant_id, presentacion);

ALTER TABLE combustible_recepcion_urea_lineas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_recepcion_urea_lineas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_recepcion_urea_lineas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── 3. La copia: cada vale del almacén y cada entrada, un renglón ───────────

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_urea_check;
ALTER TABLE combustible_recepciones DROP CONSTRAINT IF EXISTS combustible_recepciones_forma_check;

INSERT INTO combustible_despacho_urea_lineas
  (tenant_id, despacho_id, presentacion, factor_litros, cantidad_bultos, litros, costo_por_bulto)
SELECT d.tenant_id, d.id, d.presentacion, d.factor_litros, d.cantidad_bultos,
       d.cantidad_bultos * d.factor_litros,
       CASE WHEN d.costo_origen = 'declarado' AND d.costo_unitario > 0
            THEN ROUND(d.costo_unitario * d.factor_litros, 4) END
  FROM combustible_despachos d
 WHERE d.producto = 'urea' AND d.origen = 'almacen' AND d.presentacion IS NOT NULL
ON CONFLICT (despacho_id, presentacion) DO NOTHING;

UPDATE combustible_despachos
   SET presentacion = NULL, factor_litros = NULL, cantidad_bultos = NULL
 WHERE producto = 'urea' AND origen = 'almacen' AND presentacion IS NOT NULL;

INSERT INTO combustible_recepcion_urea_lineas
  (tenant_id, recepcion_id, presentacion, factor_litros, cantidad_bultos, litros, costo_por_bulto)
SELECT r.tenant_id, r.id, r.presentacion, r.factor_litros, r.cantidad_bultos,
       r.cantidad_bultos * r.factor_litros,
       ROUND(r.costo_unitario * r.factor_litros, 4)
  FROM combustible_recepciones r
 WHERE r.producto = 'urea' AND r.presentacion IS NOT NULL
ON CONFLICT (recepcion_id, presentacion) DO NOTHING;

UPDATE combustible_recepciones
   SET presentacion = NULL, factor_litros = NULL, cantidad_bultos = NULL
 WHERE producto = 'urea' AND presentacion IS NOT NULL;

-- ── 4. La forma: urea siempre con su detalle en renglones ──────────────────

ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_urea_check
  CHECK (
    producto <> 'urea' OR (
      tipo_destino = 'equipo'
      AND equipo_id IS NOT NULL
      AND grifo_id IS NOT NULL
      AND combustible_id IS NULL
      AND tipo_combustible IS NULL
      AND lectura_contometro IS NULL
      AND lectura_horometro IS NULL
      AND lectura_odometro IS NULL
      AND horas_abastecidas IS NULL
      AND cantidad > 0
      -- El detalle, para los dos orígenes, en combustible_despacho_urea_lineas.
      AND presentacion IS NULL
      AND factor_litros IS NULL
      AND cantidad_bultos IS NULL
      AND (
        -- Reparto del almacén: el talonario de la empresa.
        (origen = 'almacen'
          AND serie_talonario IS NOT NULL
          AND n_vale IS NOT NULL
          AND comprobante_tipo IS NULL
          AND comprobante_numero IS NULL
          AND comprobante_key IS NULL)
        OR
        -- Compra en ruta: el comprobante del proveedor.
        (origen = 'compra_externa'
          AND comprobante_tipo IS NOT NULL
          AND comprobante_numero IS NOT NULL
          AND serie_talonario IS NULL
          AND n_vale IS NULL)
      )
    )
  );

ALTER TABLE combustible_recepciones
  ADD CONSTRAINT combustible_recepciones_forma_check
  CHECK (
    (
      producto = 'combustible'
      AND combustible_id IS NOT NULL
      AND presentacion IS NULL
      AND factor_litros IS NULL
      AND cantidad_bultos IS NULL
    ) OR (
      -- Urea: el detalle en combustible_recepcion_urea_lineas.
      producto = 'urea'
      AND combustible_id IS NULL
      AND presentacion IS NULL
      AND factor_litros IS NULL
      AND cantidad_bultos IS NULL
    )
  );

-- ── 5. El registro de la corrección conoce los renglones nuevos ─────────────

ALTER TABLE combustible_urea_correccion_filas
  DROP CONSTRAINT IF EXISTS combustible_urea_correccion_filas_tabla_check;
ALTER TABLE combustible_urea_correccion_filas
  ADD CONSTRAINT combustible_urea_correccion_filas_tabla_check
  CHECK (tabla IN (
    'entrada', 'entrada_renglon', 'vale', 'vale_renglon',
    'compra', 'compra_renglon', 'conteo', 'conteo_renglon'
  ));

-- ── Fin de la ventana NO FORCE ──────────────────────────────────────────────

ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despacho_urea_lineas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_presentaciones FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_correccion_filas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepcion_urea_lineas FORCE ROW LEVEL SECURITY;
