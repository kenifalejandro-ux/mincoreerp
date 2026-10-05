-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: A DÓNDE VA EL EXCEDENTE DE UNA RECEPCIÓN (reemplaza el diseño de 0102)
--
-- El cliente decidió (2026-10-03): ya no hay tolerancia de capacidad ni tope
-- de excedente. Cuando una recepción no cabe en el tanque y la casilla
-- "dejar decidir" está marcada, quien decide reparte el excedente entre:
--
--   cubeta      tanquetas o cubetas de 280 gal (desde ahí se despacha a
--               unidades o se lleva en ruta).
--   equipo      se carga directo de la cisterna a unidades.
--   devolucion  se devuelve al proveedor (no aplica a todas las empresas,
--               queda como opción).
--
-- ── Por qué `cantidad` NO cambia de significado ────────────────────────────
--
-- `combustible_recepciones.cantidad` sigue siendo lo que ENTRÓ AL TANQUE.
-- Las ~22 consultas de kardex, nivel teórico y costo promedio suman esa
-- columna, y un excedente que fue a una cubeta nunca pasó por la varilla:
-- si se sumara, el nivel teórico inventaría litros que no están.
--
-- Lo que la cisterna entregó en total (lo que dice la guía y lo que se
-- paga) es `cantidad + cantidad_derivada`. Con eso la validación contra la
-- guía no da una discrepancia falsa: guía 1200 = 1000 al tanque + 200
-- derivados.
--
-- El costo es el de la factura para TODOS los litros: `costo_unitario` es
-- único por recepción.
--
-- ── Las líneas ─────────────────────────────────────────────────────────────
--
-- Una fila por destino del reparto. La suma de las líneas de una recepción
-- es exactamente su `cantidad_derivada` (lo impone el service dentro de la
-- misma transacción). Un excedente se puede dividir: parte a cubeta, parte
-- directo a unidades.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_recepciones
  ADD COLUMN IF NOT EXISTS cantidad_derivada NUMERIC(14,2) NOT NULL DEFAULT 0
    CHECK (cantidad_derivada >= 0);

COMMENT ON COLUMN combustible_recepciones.cantidad_derivada IS
  'Litros de la entrega que NO entraron al tanque (excedente repartido a cubetas, unidades o devuelto). Total entregado = cantidad + cantidad_derivada. Las líneas están en combustible_recepcion_excedentes.';

CREATE TABLE IF NOT EXISTS combustible_recepcion_excedentes (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recepcion_id    BIGINT NOT NULL REFERENCES combustible_recepciones(id) ON DELETE CASCADE,
  destino         VARCHAR(12) NOT NULL CHECK (destino IN ('cubeta', 'equipo', 'devolucion')),
  cantidad        NUMERIC(14,2) NOT NULL CHECK (cantidad > 0),
  -- Solo cuando se carga directo a una unidad.
  equipo_id       INTEGER REFERENCES equipos(id),
  observaciones   TEXT,
  -- Quién decidió el reparto (el mismo para todas las líneas de la recepción).
  decidido_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((destino = 'equipo') = (equipo_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_recepcion_excedentes_recepcion
  ON combustible_recepcion_excedentes (tenant_id, recepcion_id);
CREATE INDEX IF NOT EXISTS idx_recepcion_excedentes_equipo
  ON combustible_recepcion_excedentes (equipo_id) WHERE equipo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recepcion_excedentes_decidido_por
  ON combustible_recepcion_excedentes (decidido_por) WHERE decidido_por IS NOT NULL;

ALTER TABLE combustible_recepcion_excedentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepcion_excedentes FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_recepcion_excedentes'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_recepcion_excedentes
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
