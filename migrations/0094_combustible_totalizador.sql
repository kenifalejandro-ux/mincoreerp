-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: TOTALIZADOR ACUMULATIVO del surtidor (punto 3 de la hoja de ruta)
--
-- `lectura_contometro` es el contador que vuelve a 0 en cada despacho: el
-- servicio exige que sea IGUAL a `cantidad`, o sea que es una copia y no
-- aporta ningún dato independiente. El TOTALIZADOR es el otro contador del
-- surtidor, el acumulativo que no se resetea: dice cuánto combustible salió
-- por la manguera en toda la vida del aparato. Entre dos vales seguidos su
-- avance tiene que igualar los litros del vale; lo que sobre salió SIN vale.
--
-- Nace APAGADO por tanque (`usa_totalizador` = false): falta confirmar con el
-- cliente que sus surtidores lo tienen y que el grifero lo anota. Los tanques
-- que no lo activan se comportan exactamente como hasta hoy.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS usa_totalizador BOOLEAN NOT NULL DEFAULT false,
  -- En la unidad del tanque. Lo que el avance del totalizador puede diferir de
  -- lo declarado sin alertar (redondeo de la lectura, no un robo). Por tanque
  -- y no por tenant: cada surtidor tiene su propia resolución.
  ADD COLUMN IF NOT EXISTS totalizador_tolerancia NUMERIC(8,3) NOT NULL DEFAULT 1
    CHECK (totalizador_tolerancia >= 0);

-- La lectura del totalizador DESPUÉS de despachar. NULL para todo lo que no la
-- lleva: el historial anterior, urea y compras externas. Una cadena de
-- totalizador arranca en el primer vale que la trae.
ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS totalizador_lectura NUMERIC(14,3)
    CHECK (totalizador_lectura IS NULL OR totalizador_lectura >= 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_totalizador_forma_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_totalizador_forma_check
      CHECK (
        totalizador_lectura IS NULL
        OR (origen = 'tanque_propio' AND producto = 'combustible')
      );
  END IF;
END $$;

-- Los vecinos por valor: "el vale de este tanque con el totalizador más
-- cercano por debajo". Parcial porque casi todo el historial no lo trae.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_totalizador
  ON combustible_despachos (tenant_id, combustible_id, totalizador_lectura)
  WHERE totalizador_lectura IS NOT NULL AND anulada_en IS NULL;

-- ── Los dos tipos de alerta nuevos ──────────────────────────────────────
-- totalizador_salto: el avance del totalizador no coincide con los litros del
--   vale (sobra = salió combustible sin vale; falta = el vale declara de más).
-- totalizador_retroceso: el totalizador marca MENOS que el de un vale
--   anterior en el tiempo. Un medidor acumulativo no vuelve atrás.
-- Los dos son hallazgos: se congelan como anomalía si nadie los explica.
ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
    'tanque_sin_vigilancia',
    'recepcion_anulada', 'recepcion_discrepante', 'recepcion_sin_validar',
    'recepcion_retroactiva', 'consumo_excedido', 'varilla_sin_control',
    'varilla_exacta',
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso'
  ));

ALTER TABLE combustible_anomalias
  DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;
ALTER TABLE combustible_anomalias
  ADD CONSTRAINT combustible_anomalias_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
    'recepcion_anulada', 'recepcion_discrepante', 'recepcion_retroactiva',
    'consumo_excedido', 'varilla_exacta',
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
    'historial_sin_contrastar',
    'totalizador_salto', 'totalizador_retroceso'
  ));
