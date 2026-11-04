-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la COMPRA de una cisterna, antes de que llegue
--
-- La encargada de combustible registra la compra de una cisterna cuando se hace:
-- proveedor, factura, fecha de compra, fecha estimada de llegada, cantidad
-- facturada y costo. NO es una orden de compra (no hay aprobación ni pago): solo
-- deja anotado lo que viene en camino, para que la descarga ya sepa de quién es,
-- cuánto dice la factura y a qué costo.
--
-- Esta migración solo crea la compra. Que una recepción apunte a ella, la
-- diferencia entre lo facturado y lo descargado y su alerta van en la siguiente.
--
-- ── Estados (se derivan, no se guardan) ────────────────────────────────────
--
--   registrada  solo la ve quien gestiona compras (la encargada).
--   por_llegar  la ve también la cancha para descargarla: la encargada la
--               habilitó (`habilitada_en`) o llegó el día estimado de llegada.
--               Derivarlo al leer evita una tarea programada que se pueda caer.
--   anulada     con motivo; nunca se borra.
--
-- Un cambio de día en Lima mueve registrada -> por_llegar sin que nadie haga nada.
--
-- ── Idempotencia sin señal ─────────────────────────────────────────────────
--
-- `cliente_uuid` lo manda el equipo cuando la compra se registra sin señal: el
-- reintento de un envío ya guardado no crea una segunda fila.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_compras_cisterna (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cliente_uuid        UUID NOT NULL DEFAULT gen_random_uuid(),
  -- La sede a la que llega: define quién la ve en cancha (el alcance por sede).
  grifo_interno_id    INTEGER NOT NULL,
  -- El proveedor (combustible_grifos), marcado como proveedor de tanque.
  grifo_id            INTEGER NOT NULL REFERENCES combustible_grifos(id),
  tipo_combustible    VARCHAR(20) NOT NULL
                      CHECK (tipo_combustible IN ('diesel_b5', 'gasolina_90', 'glp')),
  unidad              VARCHAR(3) NOT NULL DEFAULT 'gal' CHECK (unidad IN ('gal', 'L')),
  tipo_documento      VARCHAR(20) NOT NULL CHECK (tipo_documento IN ('factura', 'guia_remision')),
  numero_documento    TEXT NOT NULL CHECK (length(trim(numero_documento)) > 0),
  fecha_compra        DATE NOT NULL,
  llegada_estimada    DATE NOT NULL,
  cantidad_facturada  NUMERIC(14,2) NOT NULL CHECK (cantidad_facturada > 0),
  costo_unitario      NUMERIC(10,4) NOT NULL CHECK (costo_unitario > 0),
  -- Texto libre a propósito: no lee Flota (cada módulo funciona solo).
  placa               VARCHAR(20),
  chofer              VARCHAR(120),
  habilitada_en       TIMESTAMPTZ,
  habilitada_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_id          UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  anulada_en          TIMESTAMPTZ,
  anulada_por         UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_anulacion    TEXT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, cliente_uuid),
  FOREIGN KEY (tenant_id, grifo_interno_id) REFERENCES grifos_internos (tenant_id, id),
  CHECK (llegada_estimada >= fecha_compra),
  CHECK (
    (anulada_en IS NULL AND motivo_anulacion IS NULL)
    OR (anulada_en IS NOT NULL AND length(trim(coalesce(motivo_anulacion, ''))) > 0)
  )
);

-- La misma factura del mismo proveedor no se registra dos veces (una anulada no cuenta).
CREATE UNIQUE INDEX IF NOT EXISTS idx_compras_cisterna_documento
  ON combustible_compras_cisterna (tenant_id, grifo_id, tipo_documento, lower(trim(numero_documento)))
  WHERE anulada_en IS NULL;

-- Un índice por cada FK (el gate db-index-coverage lo exige) y el de la lista por sede.
CREATE INDEX IF NOT EXISTS idx_compras_cisterna_sede
  ON combustible_compras_cisterna (tenant_id, grifo_interno_id, llegada_estimada);
CREATE INDEX IF NOT EXISTS idx_compras_cisterna_proveedor
  ON combustible_compras_cisterna (grifo_id);
CREATE INDEX IF NOT EXISTS idx_compras_cisterna_usuario
  ON combustible_compras_cisterna (usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compras_cisterna_habilitada_por
  ON combustible_compras_cisterna (habilitada_por) WHERE habilitada_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compras_cisterna_anulada_por
  ON combustible_compras_cisterna (anulada_por) WHERE anulada_por IS NOT NULL;

ALTER TABLE combustible_compras_cisterna ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_compras_cisterna FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_compras_cisterna'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_compras_cisterna
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
