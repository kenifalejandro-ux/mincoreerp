-- La compra en ruta que registra un administrador puede ir sin lectura del
-- medidor ni horas abastecidas (el conductor sigue obligado: lo exige el
-- schema de la API). Se reemplaza el CHECK de 0109 solo en esas dos líneas:
-- horas_abastecidas pasa a ser opcional y la lectura pasa de "exactamente
-- una" a "como mucho una". El resto es igual.

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_compra_externa_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_compra_externa_check
  CHECK (
    producto <> 'combustible' OR origen <> 'compra_externa' OR (
      combustible_id IS NULL
      AND tipo_combustible IS NOT NULL
      AND lectura_contometro IS NULL
      AND grifo_id IS NOT NULL
      AND (lectura_horometro IS NULL OR lectura_odometro IS NULL)
      AND (
        (comprobante_tipo IS NOT NULL
          AND comprobante_numero IS NOT NULL
          AND serie_talonario IS NULL
          AND n_vale IS NULL)
        OR
        (serie_talonario IS NOT NULL
          AND n_vale IS NOT NULL
          AND comprobante_tipo IS NULL
          AND comprobante_numero IS NULL)
      )
    )
  );
