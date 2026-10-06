-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: una compra de urea en ruta puede traer varias presentaciones
--
-- Kenif, 2026-10-05: "el cliente dijo que un volquete consumía 1 caja + 2
-- bolsas de urea". Y sobre cómo pasa de verdad: "solo se hace compra [...]
-- compran y envían hoy la foto de la factura y la cantidad de compra". Así que
-- los renglones van SOLO en la compra en ruta: el reparto del almacén y el
-- conteo siguen con una presentación por fila.
--
-- ── Una compra, un registro, sus renglones adentro ─────────────────────────
--
-- Se descartó cargar un despacho por presentación bajo la misma boleta. Una
-- compra es UN papel con UNA foto, y el historial necesita "ver comprobante"
-- y "reemplazar comprobante" sobre esa compra -- con un despacho por
-- presentación, la foto quedaba repetida en dos filas y reemplazarla era
-- reemplazarla en pedazos. Además el índice único de la boleta (0119) es por
-- producto: dos filas de urea con la misma boleta chocarían entre sí.
--
-- Así que el despacho de la compra guarda el TOTAL (litros y costo) y esta
-- tabla guarda de qué está hecho, renglón por renglón, cada uno con su factor
-- CONGELADO (mismo principio que 0092: corregir la caja mañana no reinterpreta
-- esta compra) y su precio por bulto tal como figura en la boleta.
--
-- ── Qué pasa con las columnas de presentación del despacho ─────────────────
--
-- En la compra en ruta quedan en NULL: el detalle vive acá. Que la misma
-- información viviera en los dos lados sería una invitación a que se
-- contradigan. El reparto del almacén no cambia: sigue con su presentación
-- en la fila.
--
-- Que la suma de los renglones sea la cantidad del despacho lo garantiza el
-- service, en la misma transacción que crea las dos cosas -- un CHECK no
-- puede mirar otra tabla. Hay un test que lo ata.
--
-- Aplicar: `npm run migrate`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Los renglones ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_despacho_urea_lineas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Cascada: un renglón no existe sin su compra. La compra no se borra nunca
  -- (se anula), así que esto solo actúa en el wipe de un tenant.
  despacho_id     BIGINT NOT NULL REFERENCES combustible_despachos(id) ON DELETE CASCADE,
  presentacion    VARCHAR(20) NOT NULL,
  factor_litros   NUMERIC(8, 2) NOT NULL CHECK (factor_litros > 0),
  cantidad_bultos INTEGER NOT NULL CHECK (cantidad_bultos > 0),
  litros          NUMERIC(12, 2) NOT NULL,
  -- Lo que dice la boleta, por bulto. El despacho guarda el costo por litro
  -- del total (ver costoPorLitroUrea); acá queda el precio de cada envase,
  -- que es lo que hay que poder cotejar contra el papel.
  costo_por_bulto NUMERIC(10, 4) NOT NULL CHECK (costo_por_bulto > 0),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (litros = cantidad_bultos * factor_litros),
  -- Una presentación, un renglón: "2 cajas" y "1 caja" sueltos en la misma
  -- compra son "3 cajas".
  UNIQUE (despacho_id, presentacion),
  -- Compuesta, por la misma razón que en 0116: la verificación de una FK no
  -- pasa por RLS, y una FK solo por código dejaría usar el envase de otra
  -- empresa.
  FOREIGN KEY (tenant_id, presentacion)
    REFERENCES combustible_urea_presentaciones (tenant_id, codigo)
);

-- Cobertura de las FK (tests/db-index-coverage.test.ts). La de despacho_id la
-- cubre el UNIQUE de arriba.
CREATE INDEX IF NOT EXISTS idx_despacho_urea_lineas_presentacion
  ON combustible_despacho_urea_lineas (tenant_id, presentacion);

ALTER TABLE combustible_despacho_urea_lineas ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_despacho_urea_lineas FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_despacho_urea_lineas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_despacho_urea_lineas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── 2. Las compras ya cargadas pasan a renglones ───────────────────────────
-- Solo existen en entornos de prueba (0119 no llegó a producción), pero la
-- migración tiene que dejar la base coherente igual: cada compra con su
-- presentación en la fila pasa a un renglón, y la fila queda con el total.
-- Ventana NO FORCE: sin `app.tenant_id` de sesión, con FORCE el INSERT/UPDATE
-- no vería ninguna fila (gotcha de 0097/0116).
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despacho_urea_lineas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_presentaciones NO FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_urea_check;

INSERT INTO combustible_despacho_urea_lineas
  (tenant_id, despacho_id, presentacion, factor_litros, cantidad_bultos, litros, costo_por_bulto)
SELECT d.tenant_id, d.id, d.presentacion, d.factor_litros, d.cantidad_bultos,
       d.cantidad_bultos * d.factor_litros,
       -- El despacho guarda costo por litro (0119): por bulto es × factor.
       d.costo_unitario * d.factor_litros
  FROM combustible_despachos d
 WHERE d.producto = 'urea' AND d.origen = 'compra_externa' AND d.presentacion IS NOT NULL
ON CONFLICT (despacho_id, presentacion) DO NOTHING;

UPDATE combustible_despachos
   SET presentacion = NULL, factor_litros = NULL, cantidad_bultos = NULL
 WHERE producto = 'urea' AND origen = 'compra_externa' AND presentacion IS NOT NULL;

-- ── 3. La forma de la urea: almacén con su presentación, compra sin ella ───
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
      AND (
        -- Reparto del almacén (0119): una presentación, en la fila.
        (origen = 'almacen'
          AND presentacion IS NOT NULL
          AND factor_litros IS NOT NULL
          AND cantidad_bultos IS NOT NULL
          AND cantidad = cantidad_bultos * factor_litros
          AND serie_talonario IS NOT NULL
          AND n_vale IS NOT NULL
          AND comprobante_tipo IS NULL
          AND comprobante_numero IS NULL
          AND comprobante_key IS NULL)
        OR
        -- Compra en ruta (0120): el detalle en combustible_despacho_urea_lineas.
        (origen = 'compra_externa'
          AND presentacion IS NULL
          AND factor_litros IS NULL
          AND cantidad_bultos IS NULL
          AND comprobante_tipo IS NOT NULL
          AND comprobante_numero IS NOT NULL
          AND serie_talonario IS NULL
          AND n_vale IS NULL)
      )
    )
  );

ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despacho_urea_lineas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_presentaciones FORCE ROW LEVEL SECURITY;
