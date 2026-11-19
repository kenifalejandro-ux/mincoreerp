-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: urea y carga desde tanqueta EN PLANTA a una unidad escrita a mano
--
-- Autonomía de Combustible (sin Flota, o con una unidad que la oficina aún no registró): el vale
-- del tanque propio ya aceptaba una unidad sin alta (0176: tipo_destino 'unidad_sin_alta' + la
-- placa en `placa_sin_alta`). Esta migración le abre el mismo destino a otros dos vales:
--
--   · UREA (almacén y compra en ruta): `forma_urea_check` (0131) exigía tipo_destino 'equipo'
--     con equipo_id. Ahora admite también 'unidad_sin_alta' (sin equipo_id).
--   · CARGA DESDE TANQUETA EN PLANTA: `forma_tanqueta_check` (0115) exigía unidad registrada.
--     Ahora la carga EN PLANTA (con vale del talonario) admite 'unidad_sin_alta'. La carga EN RUTA
--     sigue exigiendo unidad registrada: va por la unidad del conductor, que es dato de Flota.
--
-- Solo se RELAJAN dos CHECK: toda fila que existe hoy los cumple, no hay que migrar datos. El resto
-- de cada forma queda igual, palabra por palabra. La regla de 0176 (la placa va si y solo si el
-- destino es 'unidad_sin_alta') sigue en su propio CHECK.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Urea ─────────────────────────────────────────────────────────────────

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_urea_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_urea_check
  CHECK (
    producto <> 'urea' OR (
      -- La unidad registrada o una escrita a mano; nunca las dos.
      ((tipo_destino = 'equipo' AND equipo_id IS NOT NULL)
        OR (tipo_destino = 'unidad_sin_alta' AND equipo_id IS NULL))
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

-- ── 2. Carga desde tanqueta ─────────────────────────────────────────────────

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_tanqueta_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_tanqueta_check
  CHECK (
    origen <> 'tanqueta' OR (
      producto = 'combustible'
      AND combustible_id IS NULL
      AND grifo_id IS NULL
      AND tipo_combustible IS NOT NULL
      AND lectura_contometro IS NULL
      AND totalizador_lectura IS NULL
      AND surtidor_id IS NULL
      AND horas_abastecidas IS NULL
      AND comprobante_tipo IS NULL AND comprobante_numero IS NULL AND comprobante_key IS NULL
      AND (
        (tanqueta_lugar = 'ruta'
          AND tipo_destino = 'equipo' AND equipo_id IS NOT NULL
          AND serie_talonario IS NULL AND n_vale IS NULL
          AND ((lectura_horometro IS NOT NULL AND lectura_odometro IS NULL)
            OR (lectura_horometro IS NULL AND lectura_odometro IS NOT NULL)))
        OR
        (tanqueta_lugar = 'planta'
          AND ((tipo_destino = 'equipo' AND equipo_id IS NOT NULL)
            OR (tipo_destino = 'unidad_sin_alta' AND equipo_id IS NULL))
          AND serie_talonario IS NOT NULL AND n_vale IS NOT NULL
          AND (lectura_horometro IS NULL OR lectura_odometro IS NULL))
      )
    )
  );
