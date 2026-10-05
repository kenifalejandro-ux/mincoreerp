-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la carga desde una tanqueta puede ser EN RUTA o EN PLANTA
--
-- Kenif (2026-10-05): la tanqueta tiene tres usos, y no se decide al darla de
-- alta (la misma tanqueta guarda excedente hoy y sale de reserva mañana):
--   a) reserva para ruta, llenada desde el tanque con vale;
--   b) excedente que sale a ruta: se descarga igual que (a);
--   c) excedente que se queda en la planta y desde ahí carga unidades.
--
-- Lo que se registra es CÓMO SALE el combustible, en cada carga:
--   'ruta'   sin vale (la tanqueta salió con el suyo); medidor obligatorio,
--            que es el control del consumo en ruta.
--   'planta' CON vale del talonario de la empresa, igual que el tanque; el
--            medidor sigue la opción `despacho_pide_medidor` (0113).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_despachos ADD COLUMN IF NOT EXISTS tanqueta_lugar VARCHAR(6);

-- Las cargas desde tanqueta anteriores (0114) eran todas en ruta. UPDATE
-- dentro de la ventana NO FORCE: en una migración no hay app.tenant_id.
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
UPDATE combustible_despachos SET tanqueta_lugar = 'ruta'
 WHERE origen = 'tanqueta' AND tanqueta_lugar IS NULL;
ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;

ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_tanqueta_lugar_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_tanqueta_lugar_check
  CHECK (
    (origen = 'tanqueta') = (tanqueta_lugar IS NOT NULL)
    AND (tanqueta_lugar IS NULL OR tanqueta_lugar IN ('ruta', 'planta'))
  );

-- La forma de 0114, ahora con los dos lugares.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_tanqueta_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_tanqueta_check
  CHECK (
    origen <> 'tanqueta' OR (
      producto = 'combustible'
      AND combustible_id IS NULL
      AND grifo_id IS NULL
      AND tipo_combustible IS NOT NULL
      AND tipo_destino = 'equipo' AND equipo_id IS NOT NULL
      AND lectura_contometro IS NULL
      AND totalizador_lectura IS NULL
      AND surtidor_id IS NULL
      AND horas_abastecidas IS NULL
      AND comprobante_tipo IS NULL AND comprobante_numero IS NULL AND comprobante_key IS NULL
      AND (
        (tanqueta_lugar = 'ruta'
          AND serie_talonario IS NULL AND n_vale IS NULL
          AND ((lectura_horometro IS NOT NULL AND lectura_odometro IS NULL)
            OR (lectura_horometro IS NULL AND lectura_odometro IS NOT NULL)))
        OR
        (tanqueta_lugar = 'planta'
          AND serie_talonario IS NOT NULL AND n_vale IS NOT NULL
          AND (lectura_horometro IS NULL OR lectura_odometro IS NULL))
      )
    )
  );
