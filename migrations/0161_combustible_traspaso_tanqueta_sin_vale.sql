-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: llenar una tanqueta desde el tanque, sin unidad, no lleva vale
--
-- Kenif (2026-10-29): hoy, si el grifero llena una tanqueta desde el tanque y
-- no dice para qué unidad va, se le pide un vale; después, al asignarla a una
-- unidad desde la pestaña Tanquetas, se le pide OTRO por los mismos galones.
-- El vale es de la ENTREGA A LA UNIDAD. Llenar una tanqueta sin unidad es un
-- traspaso interno (del tanque a la tanqueta) y no lleva vale.
--
-- Se reemplaza la forma del despacho del tanque propio de 0109 (Postgres no
-- permite extender un CHECK). Lo único que cambia es el vale:
--   · antes:  serie y n_vale obligatorios siempre
--   · ahora:  los dos, O ninguno de los dos si el despacho es una "reserva en
--             cubeta" que llena una tanqueta (tanqueta_destino_id)
-- La base no sabe si se eligió unidad al llenar (esa unidad no se guarda en el
-- despacho: se usa para asignar la tanqueta), así que "con unidad, el vale es
-- obligatorio" lo sigue exigiendo el schema Zod.
--
-- Las filas existentes cumplen la regla nueva (todas tienen vale), así que no
-- hay datos que tocar ni ventana NO FORCE.
--
-- Para deshacer: volver a crear la regla de 0109 (serie_talonario IS NOT NULL
-- AND n_vale IS NOT NULL). Falla si ya hay traspasos sin vale: antes habría
-- que anularlos o ponerles vale.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_tanque_propio_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_tanque_propio_check
  CHECK (
    producto <> 'combustible' OR origen <> 'tanque_propio' OR (
      combustible_id IS NOT NULL
      AND tipo_combustible IS NOT NULL
      AND lectura_contometro IS NOT NULL
      AND grifo_id IS NULL
      AND horas_abastecidas IS NULL
      AND (lectura_horometro IS NULL OR lectura_odometro IS NULL)
      AND (tipo_destino = 'equipo' OR (lectura_horometro IS NULL AND lectura_odometro IS NULL))
      -- [0161] El vale del talonario sigue siendo obligatorio, salvo en el
      -- traspaso del tanque a una tanqueta: ahí van los dos campos o ninguno.
      AND (
        (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
        OR (serie_talonario IS NULL AND n_vale IS NULL
            AND tipo_destino = 'reserva_cubeta' AND tanqueta_destino_id IS NOT NULL)
      )
      AND comprobante_tipo IS NULL
      AND comprobante_numero IS NULL
      AND comprobante_key IS NULL
    )
  );
