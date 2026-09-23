-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el umbral pasa a ser PISO FIJO + PORCENTAJE SOBRE LO MOVIDO
--
-- Planteo de Kenif (2026-09-11, confirmado 2026-09-22): *"el 2 % siempre va a
-- ser volátil en relación a la capacidad... para un tanque de 20.000 está
-- bien, para uno de 1.000 no"*.
--
-- ── Por qué el modelo viejo está mal, y no es cuestión de elegir otro número
--
-- Hasta acá los tres umbrales de descuadre se calculaban así:
--
--     tolerado = capacidad_total × umbral_pct / 100
--
-- O sea: un número FIJO en litros para todos los tramos del tanque, escrito
-- como porcentaje de la capacidad. Y el ruido que tiene que cubrir NO es fijo,
-- porque son dos fuentes que escalan distinto:
--
--   · La VARILLA. Su error es del instrumento, no del movimiento: una lectura
--     se equivoca lo mismo en un domingo sin despachos que en un día pico. Y
--     tampoco escala con el tamaño del tanque como lo hace un porcentaje.
--     Son siempre DOS lecturas (la anterior y la actual), sume un tramo o
--     treinta días -- por eso no se multiplica por la cantidad de tramos (el
--     mismo argumento por el que la ventana de 0080 no lleva √n: los tramos
--     telescopan y el error entra +e y −e).
--
--   · LOS MEDIDORES (el contómetro del surtidor, el del camión en la
--     recepción). Ese error sí es proporcional al volumen que pasó por
--     ellos. Un medidor descalibrado se equivoca siempre para el mismo lado,
--     así que su error se ACUMULA EN LÍNEA RECTA con lo despachado.
--
-- Con un solo número hay que cubrir las dos con el mismo valor, y el resultado
-- es que el tramo tranquilo paga el ruido del tramo movido. En un tanque de
-- 2.000 gal al 2 % (= 40 gal fijos):
--
--     tramo sin movimiento:  ruido real ~5 gal  → tolera 40 → 35 gal gratis
--     tramo de 1.500 gal:    ruido real ~12 gal → tolera 40 → 28 gal gratis
--
-- No hay número que arregle eso: bajarlo para cubrir el domingo hace que el
-- día pico alerte por ruido de medidor, y un control ruidoso termina ignorado.
-- La física tiene dos parámetros y el modelo tenía uno.
--
-- ── El modelo nuevo ─────────────────────────────────────────────────────
--
--     tolerado = piso + (umbral_pct / 100) × movimiento
--
-- donde `movimiento` es lo que pasó por los medidores en el período que cada
-- control mira (despachos + recepciones del tramo, del ciclo, o de la
-- ventana). El piso cubre la varilla; el porcentaje cubre los medidores.
--
-- Efecto lateral buscado: los tres controles dejan de ser tres números
-- inventados sin relación entre sí (la escalera 2/3/4 % que el propio código
-- admitía como "punto de partida RAZONADO, no medido") y pasan a ser LA MISMA
-- medición física del tanque aplicada a tres ventanas distintas. No pueden
-- contradecirse entre ellos, porque el que abarca más movimiento tolera más
-- por construcción.
--
-- El piso va en la UNIDAD DEL TANQUE (L o gal), como `nivel_minimo` y
-- `capacidad_total`. Por eso la columna NO se llama `_l`: en un tanque en
-- galones, leerla como litros la multiplicaría por 3,785.
--
-- ── La conversión NO cambia el comportamiento de ningún tanque ──────────
--
-- Es la parte más importante de esta migración. Para los tres umbrales de
-- descuadre la BASE cambia (de la capacidad a lo movido), así que dejar el
-- porcentaje donde está multiplicaría o dividiría la tolerancia de golpe. Se
-- convierte de forma que el día después de aplicarla cada tanque tolere
-- exactamente los mismos litros que el día anterior:
--
--     piso := capacidad_total × umbral_pct / 100     ← los litros de hoy
--     pct  := 0                                      ← sin parte proporcional
--
-- Con eso `tolerado = piso + 0 × movimiento = piso`, que es el mismo número
-- que devolvía la fórmula vieja. La parte proporcional arranca en 0, que es
-- el lado ESTRICTO: agregarla solo puede aflojar, y aflojar exige motivo
-- (`evaluarAflojamiento`). Es la regla que dejó la 5ª auditoría para los
-- campos de configuración nuevos.
--
-- `umbral_diferencia_pct` es el caso fácil y va distinto: su base NO cambia
-- (ya se medía contra la cantidad recibida, no contra la capacidad), así que
-- conserva su porcentaje tal cual y solo estrena piso en 0 = sin piso.
--
-- NULL sigue significando "sin configurar, no alerta" (0075). El par
-- (pct, piso) es atómico: o los dos son NULL o ninguno lo es, y el CHECK lo
-- garantiza. Así no existe el estado ambiguo "tiene piso pero no vigila".
--
-- ── Gotcha de RLS, tercera vez (ver 0073 y 0075) ────────────────────────
--
-- `combustible` tiene RLS FORZADO. La conversión de datos NO puede ir como
-- UPDATE: con el GUC seteado en un tenant dummy, el UPDATE se filtraría a las
-- filas de ESE tenant --ninguna-- y la migración reportaría éxito sin haber
-- tocado nada. Un no-op silencioso, que se ve verde en CI y es peor que un
-- error. Por eso va como DDL (`ALTER COLUMN ... TYPE ... USING`, mismo tipo,
-- solo para forzar el rewrite), que recorre las filas FÍSICAS sin evaluar la
-- policy.
--
-- VERIFICAR DESPUÉS DE CORRER (no confiar en que el runner diga "aplicada"):
--   SELECT codigo, capacidad_total, unidad,
--          umbral_descuadre_pct, umbral_descuadre_piso
--     FROM combustible WHERE umbral_descuadre_piso IS NOT NULL;
--   -- piso debe ser capacidad × (el pct que tenía antes) / 100, y pct = 0.
--
-- EJECUTAR (después de 0100):
--   psql -d mincoreerp -f migrations/0101_combustible_umbral_piso_litros.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';

-- ── 1. Las cuatro columnas de piso ──────────────────────────────────────
--
-- NUMERIC(12,2) como `capacidad_total` y `nivel_minimo`: misma escala, misma
-- unidad del tanque. Nacen NULL, que es lo correcto para un tanque sin
-- configurar; el paso 2 las llena en los que sí lo están.
ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS umbral_diferencia_piso        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS umbral_descuadre_piso         NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS umbral_descuadre_ciclo_piso   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS umbral_descuadre_ventana_piso NUMERIC(12,2);

-- ── 2. La conversión que preserva el comportamiento ─────────────────────
--
-- Los tres de descuadre: el piso se queda con los litros que la fórmula vieja
-- toleraba. ROUND a 2 decimales porque la columna es NUMERIC(12,2); el desvío
-- máximo contra la cuenta vieja es de medio centilitro, muy por debajo de
-- cualquier varilla.
--
-- Las siete columnas (los 4 pisos y los 3 porcentajes que se pisan a 0) van
-- en UNA sola sentencia, y es seguro: todas las cláusulas `USING` de un mismo
-- `ALTER TABLE` se evalúan contra la fila COMO ERA ANTES de la sentencia --
-- igual que un `UPDATE a = b, b = a` intercambia dos columnas en vez de
-- pisar una con la otra. Verificado en vivo antes de escribir esto (una
-- prueba de intercambio de dos columnas en una tabla temporal, y la misma
-- estructura de esta migración con una fila real). El piso del descuadre lee
-- `umbral_descuadre_pct` con su valor de ANTES aunque esa misma sentencia lo
-- vaya a pisar a 0 más abajo.
ALTER TABLE combustible
  ALTER COLUMN umbral_descuadre_piso TYPE NUMERIC(12,2)
    USING CASE
            WHEN umbral_descuadre_pct IS NULL THEN NULL
            ELSE ROUND(capacidad_total * umbral_descuadre_pct / 100, 2)
          END,
  ALTER COLUMN umbral_descuadre_ciclo_piso TYPE NUMERIC(12,2)
    USING CASE
            WHEN umbral_descuadre_ciclo_pct IS NULL THEN NULL
            ELSE ROUND(capacidad_total * umbral_descuadre_ciclo_pct / 100, 2)
          END,
  ALTER COLUMN umbral_descuadre_ventana_piso TYPE NUMERIC(12,2)
    USING CASE
            WHEN umbral_descuadre_ventana_pct IS NULL THEN NULL
            ELSE ROUND(capacidad_total * umbral_descuadre_ventana_pct / 100, 2)
          END,
  -- El de diferencia conserva su porcentaje (su base no cambia) y estrena
  -- piso en 0: hoy no tiene ninguno, y 0 es exactamente "sin piso".
  ALTER COLUMN umbral_diferencia_piso TYPE NUMERIC(12,2)
    USING CASE WHEN umbral_diferencia_pct IS NULL THEN NULL ELSE 0 END,
  -- Los tres porcentajes de descuadre quedan en 0 = sin parte proporcional,
  -- en la MISMA sentencia que calculó sus pisos arriba (ver el porqué al
  -- principio de este bloque).
  ALTER COLUMN umbral_descuadre_pct TYPE NUMERIC(5,2)
    USING CASE WHEN umbral_descuadre_pct IS NULL THEN NULL ELSE 0 END,
  ALTER COLUMN umbral_descuadre_ciclo_pct TYPE NUMERIC(5,2)
    USING CASE WHEN umbral_descuadre_ciclo_pct IS NULL THEN NULL ELSE 0 END,
  ALTER COLUMN umbral_descuadre_ventana_pct TYPE NUMERIC(5,2)
    USING CASE WHEN umbral_descuadre_ventana_pct IS NULL THEN NULL ELSE 0 END;

-- ── 3. Los CHECK ────────────────────────────────────────────────────────
--
-- Dos reglas por umbral:
--   · el piso no puede ser negativo (un piso negativo sería tolerancia
--     negativa: alertaría incluso con el tanque cuadrado al litro);
--   · el par (pct, piso) es atómico. `(a IS NULL) = (b IS NULL)` compara dos
--     booleanos, así que siempre da TRUE o FALSE -- nunca NULL -- y el CHECK
--     rechaza de verdad el estado mitad configurado.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_umbral_pisos_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_umbral_pisos_check
      CHECK (
        (umbral_diferencia_piso        IS NULL OR umbral_diferencia_piso        >= 0)
        AND (umbral_descuadre_piso     IS NULL OR umbral_descuadre_piso         >= 0)
        AND (umbral_descuadre_ciclo_piso   IS NULL OR umbral_descuadre_ciclo_piso   >= 0)
        AND (umbral_descuadre_ventana_piso IS NULL OR umbral_descuadre_ventana_piso >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_umbral_par_atomico_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_umbral_par_atomico_check
      CHECK (
        (umbral_diferencia_pct        IS NULL) = (umbral_diferencia_piso        IS NULL)
        AND (umbral_descuadre_pct     IS NULL) = (umbral_descuadre_piso         IS NULL)
        AND (umbral_descuadre_ciclo_pct   IS NULL) = (umbral_descuadre_ciclo_piso   IS NULL)
        AND (umbral_descuadre_ventana_pct IS NULL) = (umbral_descuadre_ventana_piso IS NULL)
      );
  END IF;
END $$;

COMMIT;

-- Los CHECK viejos de rango (0066, 0074, 0080: `pct BETWEEN 0 AND 100`) siguen
-- valiendo tal cual. El porcentaje nuevo se mide sobre lo movido y en la
-- práctica va a vivir cerca de 0,5 %, muy lejos del techo de 100 -- pero el
-- techo no molesta y sacarlo sería relajar una validación sin necesidad.
