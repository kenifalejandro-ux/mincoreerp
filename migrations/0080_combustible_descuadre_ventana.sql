-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: descuadre acumulado en ventana deslizante
--
-- Hallazgos 1 y 4 de la simulación de robo, y el más grave de los siete: es
-- el único que se podía sostener PARA SIEMPRE sin ser detectado.
--
-- ── El hueco ────────────────────────────────────────────────────────────
--
-- El descuadre del ciclo (0076) arranca en la primera lectura POSTERIOR a la
-- última recepción. Dicho de otra forma: cada recepción borra el acumulado.
--
-- Con eso, robar de a poco es gratis. 50 L por día de un tanque de 20.000
-- con umbral de 1% (= 200 L):
--
--   · Por tramo: 50 L de descuadre, muy por debajo de 200. No alerta.
--   · Por ciclo: 50, 100, 150... y el jueves llega el camión, la recepción
--     cierra el ciclo y el contador vuelve a CERO. No alerta nunca.
--
-- El único requisito para robar indefinidamente era que el tanque se cargara
-- seguido, que es exactamente lo que hace un tanque en operación.
--
-- ── El control ──────────────────────────────────────────────────────────
--
-- Se suma el descuadre de todos los tramos de los últimos N días. La ventana
-- se corre con el tiempo y NO se resetea con nada: ni con una recepción, ni
-- con una varilla, ni con un cierre de mes. Es el único acumulado del módulo
-- que no tiene botón de reinicio, y ese es todo el punto.
--
-- ── Por qué se suma CON SIGNO y no en valor absoluto ────────────────────
--
-- Es lo que separa a un ladrón de una varilla mal leída, y es la razón por
-- la que este control funciona:
--
--   · Un error de medición es aleatorio. Un día la varilla marca de más,
--     otro de menos. Sumados con signo se cancelan y en 30 días el total
--     queda cerca de cero.
--   · Un robo es sistemático. Siempre falta, siempre para el mismo lado.
--     Sumado con signo crece lineal: 50 L/día × 30 días = 1.500 L.
--
-- Sumar valores absolutos --que es lo que hace la calibración de 0066 para
-- estimar el RUIDO de un tanque-- acá sería un error: delataría al operador
-- de pulso tembloroso junto con el ladrón, el control se llenaría de falsos
-- positivos y terminaría ignorado, que es como mueren los controles.
--
-- ── Por qué un umbral propio y no el del ciclo ──────────────────────────
--
-- Porque miden cosas distintas y el número correcto es distinto. El del
-- ciclo pregunta "¿cuánto se puede haber perdido desde la última carga?" --
-- días, un puñado de tramos. Este pregunta "¿cuánto se fue en un mes?" y
-- acumula treinta veces más tramos, así que tolera más en litros aunque el
-- porcentaje sea parecido. Reusar el del ciclo obligaría a elegir un número
-- que no sirve bien para ninguno de los dos.
--
-- NULL = sin configurar = no alerta, igual que los otros tres desde 0075.
--
-- `dias_ventana_descuadre` va en `combustible_config` (por tenant) y no en
-- el tanque: es una política de la empresa --cada cuánto quiere mirar para
-- atrás-- no una propiedad física del recipiente. Mismo criterio que
-- `dias_sin_medir` en 0076. Default 30 días: un mes es el período con el que
-- ya razona la operación (cierre, factura, planilla de vales).
--
-- EJECUTAR (después de 0079):
--   psql -d mincoreerp -f migrations/0080_combustible_descuadre_ventana.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS umbral_descuadre_ventana_pct NUMERIC(5,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_umbral_ventana_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_umbral_ventana_check
      -- 0 SÍ es válido acá, a diferencia de los topes de 0079: significa
      -- "cualquier faltante acumulado alerta", que es una postura estricta
      -- legítima. Es la misma semántica de los otros tres umbrales (0075).
      CHECK (umbral_descuadre_ventana_pct IS NULL
             OR umbral_descuadre_ventana_pct BETWEEN 0 AND 100);
  END IF;
END $$;

ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS dias_ventana_descuadre INT NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_dias_ventana_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_dias_ventana_check
      -- Mínimo 7: con menos de una semana no hay tramos suficientes para que
      -- el ruido se cancele, y el control se vuelve una versión ruidosa del
      -- descuadre de ciclo. Máximo 365: más que eso no es "mirar para
      -- atrás", es no cerrar nunca un período.
      CHECK (dias_ventana_descuadre BETWEEN 7 AND 365);
  END IF;
END $$;

-- ── Tipo de alerta nuevo ────────────────────────────────────────────────

ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana'
  ));
