-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la recepción con dos testigos, el horómetro en el vale propio y
-- el consumo máximo por equipo
--
-- 5ª auditoría (red team técnico, 2026-09-14), hallazgos C4, A5 y V2/V6.
-- (0087 la usa otra rama -- cuentas de usuario --; esta es independiente.)
--
-- ── 1. La recepción sub-declarada ───────────────────────────────────────
--
-- Llegaron 10.000 L, el grifero registró 9.000 y se llevó los 1.000 antes de
-- medir. Resultado: CERO alertas (el gemelo honesto disparó tres). La
-- diferencia de recepción dio exactamente 0 porque `cantidad` era a la vez
-- "lo que dice la guía" y "lo que entró", y la escribía una sola persona:
-- la que estaba parada al lado de la cisterna.
--
-- Kenif (2026-09-14): la guía la reciben el grifero Y administración, y la
-- política tiene que poder cambiarse por empresa. Entonces:
--
--   · el grifero sigue registrando la recepción, y su combustible CUENTA
--     desde ese momento (si no, la próxima varilla mostraría un sobrante
--     falso cada vez que administración tarde un día -- ver 0085);
--   · administración la VALIDA escribiendo la cantidad de la guía SIN VER la
--     que cargó el grifero. Si no coinciden, alerta `recepcion_discrepante`;
--   · si pasa el plazo sin validar, alerta `recepcion_sin_validar`.
--
-- `requiere_validacion` se guarda POR RECEPCIÓN, estampado al crearla con la
-- política vigente. Las recepciones que ya existen quedan en false: se
-- registraron cuando validar no existía, y marcarlas pendientes haría saltar
-- una alerta por cada entrega histórica el día del despliegue -- el ruido que
-- mata un control el primer día. Tampoco se las marca "validadas": nadie las
-- comparó contra una guía, y decirlo sería mentir en el registro.
--
-- ── 2. El horómetro en el vale del tanque propio ────────────────────────
--
-- El vale del tanque propio NO aceptaba horómetro ni odómetro (CHECK de
-- 0062). O sea: para el canal principal de salida no existía forma de saber
-- cuánto consume un equipo por hora de motor, y el robo que sale CON vale
-- --se declaran 400 L y el volquete recibe 380-- no tenía ningún control del
-- lado del tanque: el tanque cuadra perfecto, el papel dice 400.
--
-- Kenif confirmó que el horómetro es legible en cancha. Se permite en el vale
-- propio cuando el destino es un equipo, y nunca los dos medidores a la vez.
--
-- ── 3. El consumo máximo del equipo ─────────────────────────────────────
--
-- `equipos.consumo_maximo_l`: litros por hora de motor (horómetro) o por km
-- (odómetro), según el `tipo_medidor` del equipo. NULL = sin configurar = no
-- alerta, mismo criterio que `capacidad_tanque` (0069): el número lo sabe la
-- operación, y el sistema lo SUGIERE desde el historial del equipo, nunca lo
-- inventa.
--
-- ── 4. Configuración nueva del tenant ───────────────────────────────────
--
-- Las tres con default del lado ESTRICTO, a propósito: el PUT de la config
-- reemplaza la fila entera, y un cliente viejo que no mande estos campos
-- tiene que poder solo ENDURECER, nunca aflojar en silencio.
--
-- EJECUTAR (después de 0086):
--   psql -d mincoreerp -f migrations/0088_combustible_recepcion_validada_horometro_y_consumo.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Recepciones ──────────────────────────────────────────────────────
ALTER TABLE combustible_recepciones
  ADD COLUMN IF NOT EXISTS requiere_validacion BOOLEAN NOT NULL DEFAULT false,
  -- Lo que dice la guía/factura según quien VALIDA, no según quien recibió.
  ADD COLUMN IF NOT EXISTS cantidad_documento NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS validada_en TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_validacion_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_validacion_check
      -- Validar ES escribir la cantidad de la guía: una sin la otra no existe.
      -- `validada_por` queda afuera porque puede volverse NULL si el usuario
      -- se borra, y eso no des-valida la recepción.
      CHECK (
        (validada_en IS NULL) = (cantidad_documento IS NULL)
        AND (cantidad_documento IS NULL OR cantidad_documento > 0)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_validada_por
  ON combustible_recepciones(validada_por) WHERE validada_por IS NOT NULL;

-- La consulta del worker: recepciones que esperan validación.
CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_pendientes
  ON combustible_recepciones(tenant_id, creado_en)
  WHERE requiere_validacion AND validada_en IS NULL AND anulada_en IS NULL;

-- ── 2. Horómetro/odómetro en el vale del tanque propio ─────────────────
-- Envuelto con app.tenant_id seteado por la misma razón que 0073: la tabla
-- tiene RLS forzado y el runner no abre transacción ni setea el parámetro.
BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';

ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_tanque_propio_check;

ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_tanque_propio_check
  CHECK (
    origen <> 'tanque_propio' OR (
      combustible_id IS NOT NULL
      AND lectura_contometro IS NOT NULL
      AND grifo_id IS NULL
      AND horas_abastecidas IS NULL
      -- Nunca los dos medidores en el mismo vale.
      AND (lectura_horometro IS NULL OR lectura_odometro IS NULL)
      -- Y solo si el combustible fue a un equipo: planta o cubeta no tienen
      -- horómetro que leer.
      AND (tipo_destino = 'equipo' OR (lectura_horometro IS NULL AND lectura_odometro IS NULL))
    )
  );

COMMIT;

-- ── 3. Consumo máximo por equipo ────────────────────────────────────────
ALTER TABLE equipos
  ADD COLUMN IF NOT EXISTS consumo_maximo_l NUMERIC(10, 3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipos_consumo_maximo_check'
  ) THEN
    ALTER TABLE equipos
      ADD CONSTRAINT equipos_consumo_maximo_check
      CHECK (consumo_maximo_l IS NULL OR consumo_maximo_l > 0);
  END IF;
END $$;

COMMENT ON COLUMN equipos.consumo_maximo_l IS
  'Consumo máximo tolerado: litros por hora de motor si tipo_medidor = horometro, '
  'litros por km si es odometro. NULL = sin configurar, no alerta.';

-- ── 4. Configuración del tenant ─────────────────────────────────────────
ALTER TABLE combustible_config
  ADD COLUMN IF NOT EXISTS recepcion_requiere_validacion BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS horas_para_validar_recepcion INT NOT NULL DEFAULT 48,
  -- NULL = la empresa decidió que no tiene a nadie además del grifero para
  -- medir (queda auditado como aflojamiento). Default 7 días.
  ADD COLUMN IF NOT EXISTS dias_sin_varilla_de_control INT DEFAULT 7;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_validar_recepcion_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_validar_recepcion_check
      CHECK (horas_para_validar_recepcion BETWEEN 1 AND 720);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_varilla_control_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_varilla_control_check
      CHECK (dias_sin_varilla_de_control IS NULL OR dias_sin_varilla_de_control BETWEEN 1 AND 90);
  END IF;
END $$;
