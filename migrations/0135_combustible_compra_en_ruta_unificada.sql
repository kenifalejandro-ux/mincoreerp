-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: una compra en ruta con combustible y urea en UNA boleta
--
-- El conductor compra combustible y urea en el mismo grifo y recibe UNA sola
-- boleta o factura. Hasta ahora eso se registraba en dos formularios, y el
-- total de la boleta nunca quedaba guardado: no había forma de auditar si lo
-- que se registró cuadra con el papel.
--
-- Esta tabla es la CABECERA de esa compra. No reemplaza a los despachos: cada
-- producto sigue siendo su propio despacho (combustible_despachos), con sus
-- validaciones, alertas y kardex de siempre. Acá queda la boleta completa:
--   - el total que dice el papel (lo escribe el conductor),
--   - el total que calcula el sistema (combustible + urea),
--   - la diferencia, y el motivo si pasa de la tolerancia,
--   - y los dos despachos que la componen.
--
-- ── Por qué una tabla aparte y no columnas en combustible_despachos ────────
--
-- Una boleta es un papel, no un despacho. Con columnas en el despacho habría
-- que repetir el total de la boleta en cada producto y acordarse de que
-- coincidan. Acá vive una sola vez.
--
-- ── Idempotencia ───────────────────────────────────────────────────────────
--
-- cliente_uuid es el de la COMPRA, generado una sola vez por el dispositivo.
-- Los dos despachos reciben uuids derivados de él (uno por producto), porque
-- combustible_despachos tiene UNIQUE sobre cliente_uuid. El índice de acá
-- impide que un reintento de la cola offline cree una compra gemela.
--
-- ── Tolerancia del cuadre ──────────────────────────────────────────────────
--
-- Un descuadre de hasta S/ 0.10 es redondeo por línea y no necesita motivo.
-- Por encima, el motivo es obligatorio. La regla vive también en la base, no
-- solo en el servidor, para que ninguna otra vía la rompa.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Ventana NO FORCE ────────────────────────────────────────────────────
-- Las FK de la tabla nueva apuntan a tablas con FORCE RLS. Postgres valida
-- esas FK con una consulta que sí aplica la política tenant_isolation, y sin
-- app.tenant_id en la migración falla (gotcha de 0097). Por eso se abre la
-- ventana ANTES de crear la tabla y se cierra al final.

ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_grifos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE equipos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;

-- ── 1. La tabla ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS combustible_compras_ruta (
  id                       BIGSERIAL PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cliente_uuid             UUID NOT NULL,
  grifo_id                 INTEGER NOT NULL REFERENCES combustible_grifos(id),
  comprobante_tipo         VARCHAR(10) NOT NULL CHECK (comprobante_tipo IN ('boleta', 'factura')),
  comprobante_numero       VARCHAR(40) NOT NULL CHECK (length(trim(comprobante_numero)) > 0),
  unidad_equipo_id         INTEGER NOT NULL REFERENCES equipos(id),
  despachado_en            TIMESTAMPTZ NOT NULL,
  total_boleta             NUMERIC(12, 2) NOT NULL CHECK (total_boleta >= 0),
  total_sistema            NUMERIC(12, 2) NOT NULL CHECK (total_sistema >= 0),
  diferencia               NUMERIC(12, 2) NOT NULL,
  motivo_descuadre         TEXT CHECK (motivo_descuadre IS NULL OR length(trim(motivo_descuadre)) > 0),
  despacho_combustible_id  BIGINT REFERENCES combustible_despachos(id),
  despacho_urea_id         BIGINT REFERENCES combustible_despachos(id),
  usuario_id               UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Una compra tiene al menos uno de los dos productos.
  CHECK (despacho_combustible_id IS NOT NULL OR despacho_urea_id IS NOT NULL),
  -- La diferencia es exactamente lo que dice el papel menos lo que calculó el sistema.
  CHECK (diferencia = total_boleta - total_sistema),
  -- Más de S/ 0.10 de descuadre exige el motivo.
  CHECK (abs(diferencia) <= 0.10 OR motivo_descuadre IS NOT NULL)
);

-- El reintento de la cola offline no crea una segunda compra.
CREATE UNIQUE INDEX IF NOT EXISTS idx_combustible_compras_ruta_cliente_uuid
  ON combustible_compras_ruta (tenant_id, cliente_uuid);

-- Historial y alertas: buscar por unidad y por fecha.
CREATE INDEX IF NOT EXISTS idx_combustible_compras_ruta_unidad
  ON combustible_compras_ruta (tenant_id, unidad_equipo_id, despachado_en);

-- Bandeja: las compras que no cuadran.
CREATE INDEX IF NOT EXISTS idx_combustible_compras_ruta_descuadre
  ON combustible_compras_ruta (tenant_id, despachado_en)
  WHERE motivo_descuadre IS NOT NULL;

-- ── 2. Políticas ───────────────────────────────────────────────────────────

ALTER TABLE combustible_compras_ruta ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_compras_ruta'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_compras_ruta
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── 3. Fin de la ventana NO FORCE ──────────────────────────────────────────

ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_grifos FORCE ROW LEVEL SECURITY;
ALTER TABLE equipos FORCE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_compras_ruta FORCE ROW LEVEL SECURITY;
