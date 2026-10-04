-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: CALIBRACIÓN DEL CONTÓMETRO (dato del surtidor)
--
-- Preguntas pendientes desde 2026-09-14 (memoria "preguntas-cliente-
-- contometro"): el error del contómetro NO se cancela entre tramos como el de
-- la varilla -- cada vale es una medición nueva y un sesgo se suma en todas.
-- El asistente de 0101/0102 estima el % del medidor por regresión sobre el
-- historial del propio tanque, pero no puede distinguir un medidor
-- descalibrado de un robo proporcional al despacho: ambos producen la misma
-- recta (combustible.controller.ts, fila "El límite honesto"). El EMP del
-- certificado es la única fuente independiente de esos datos.
--
-- Entrega 1 (esta migración): capturar el dato en el surtidor y mostrarlo en
-- el panel, con aviso visual de vencimiento. Entrega 2 (pendiente, fuera de
-- alcance acá): usar el EMP como techo de referencia en el asistente .xlsx y
-- alertar por correo cuando un certificado vence -- requiere tocar el motor
-- de fórmulas de calibracion.controller y el worker de alertas.
--
-- Va en `surtidores`, no en una tabla con historia (a diferencia de
-- surtidor_tanques): el certificado vigente es lo único que importa para la
-- lectura de hoy, y no hay ningún vale retroactivo que necesite reconstruir
-- qué EMP regía en una fecha pasada -- el control que lo usa (entrega 2)
-- siempre mira el surtidor TAL COMO ESTÁ, no un corte histórico.
--
-- Tres columnas independientes, sin CHECK de pareja: un tenant puede conocer
-- el EMP sin saber la fecha de vencimiento (certificado en trámite), o viceversa.
-- NULL es "sin dato" en las tres, igual que el resto de la configuración de
-- umbrales (0075): nace sin vigilar hasta que el cliente lo carga.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE surtidores
  ADD COLUMN IF NOT EXISTS calibracion_emp_pct      NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS calibracion_certificado  VARCHAR(80),
  ADD COLUMN IF NOT EXISTS calibracion_vence        DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'surtidores_calibracion_emp_pct_check'
  ) THEN
    ALTER TABLE surtidores
      ADD CONSTRAINT surtidores_calibracion_emp_pct_check
      CHECK (calibracion_emp_pct IS NULL OR calibracion_emp_pct >= 0);
  END IF;
END $$;

COMMENT ON COLUMN surtidores.calibracion_emp_pct IS
  'Error Máximo Permisible declarado en el certificado de calibración del contómetro, en % de lo despachado. NULL = sin certificado cargado.';
COMMENT ON COLUMN surtidores.calibracion_vence IS
  'Vencimiento del certificado. El panel avisa dentro de los 30 días previos y cuando ya venció.';
