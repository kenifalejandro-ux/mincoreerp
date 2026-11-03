-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el excedente que SE QUEDA EN LA CISTERNA
--
-- El cliente (2026-11-03): la cisterna del proveedor a veces se queda varios
-- días en la empresa (una semana, aprox.) y desde ahí se reparte lo que no
-- cupo en el tanque. Siempre vuelve vacía: lo que sobra se pasa a tanquetas.
--
-- Un destino más del reparto (0110): 'cisterna'. A diferencia de 'equipo'
-- (una línea = una unidad = un vale), la línea de cisterna es un SALDO del
-- que salen varios despachos con el origen de 0112, 'excedente_recepcion':
--
--   - a una unidad: con vale y medidor, como el excedente directo a unidad;
--   - a una tanqueta (reserva_cubeta): como el traspaso del tanque a una
--     tanqueta (0161): sin unidad no lleva vale; con unidad, sí.
--
-- Saldo = cantidad de la línea - despachos vigentes que la apuntan. Ese
-- combustible nunca entró al tanque: el kardex del tanque no lo ve
-- (combustible_id NULL), igual que en 0112.
--
-- ── Por qué se cae el índice único de 0112 ─────────────────────────────────
--
-- `idx_despachos_excedente_linea_vigente` decía "una línea, un despacho
-- vigente". Sigue siendo cierto para 'equipo', pero una línea de cisterna
-- tiene muchos. El índice no puede mirar el destino de la línea (está en
-- otra tabla), así que la regla pasa al servicio: cada despacho de excedente
-- BLOQUEA su línea (FOR UPDATE) antes de mirar si está pendiente o cuánto
-- saldo le queda. Dos despachos a la vez sobre la misma línea se ordenan;
-- el segundo ve lo que dejó el primero.
-- ═══════════════════════════════════════════════════════════════════════════

-- El destino nuevo. El CHECK de 0110 era anónimo: Postgres lo nombró así.
ALTER TABLE combustible_recepcion_excedentes
  DROP CONSTRAINT IF EXISTS combustible_recepcion_excedentes_destino_check;
ALTER TABLE combustible_recepcion_excedentes
  ADD CONSTRAINT combustible_recepcion_excedentes_destino_check
  CHECK (destino IN ('cubeta', 'equipo', 'devolucion', 'cisterna'));

-- El índice de la FK se queda (lo pide la cobertura de índices), sin UNIQUE.
CREATE INDEX IF NOT EXISTS idx_despachos_excedente_linea
  ON combustible_despachos (excedente_linea_id)
  WHERE excedente_linea_id IS NOT NULL;
DROP INDEX IF EXISTS idx_despachos_excedente_linea_vigente;

-- Una tanqueta se llena del tanque (0114) o, ahora, de la cisterna.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_tanqueta_destino_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_tanqueta_destino_check
  CHECK (
    tanqueta_destino_id IS NULL
    OR (origen IN ('tanque_propio', 'excedente_recepcion') AND tipo_destino = 'reserva_cubeta')
  );

-- La forma del despacho de excedente: lo común de 0112 y dos destinos.
--   unidad:   con vale, a lo sumo un medidor, sin tanqueta.
--   tanqueta: sin unidad ni medidor; el vale, los dos campos o ninguno.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_excedente_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_excedente_check
  CHECK (
    origen <> 'excedente_recepcion' OR (
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
        (
          tipo_destino = 'equipo' AND equipo_id IS NOT NULL
          AND tanqueta_destino_id IS NULL
          AND (lectura_horometro IS NULL OR lectura_odometro IS NULL)
          AND serie_talonario IS NOT NULL AND n_vale IS NOT NULL
        ) OR (
          tipo_destino = 'reserva_cubeta' AND equipo_id IS NULL
          AND tanqueta_destino_id IS NOT NULL
          AND lectura_horometro IS NULL AND lectura_odometro IS NULL
          AND (serie_talonario IS NULL) = (n_vale IS NULL)
        )
      )
    )
  );
