-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: EL TOTALIZADOR TAMBIÉN AL TOMAR LA VARILLA
--
-- Hasta 0094 el totalizador acumulativo del surtidor solo se anotaba en cada
-- vale, así que solo se comparaba ENTRE vales. Dos huecos:
--   - Lo que sale por la manguera DESPUÉS del último vale del día no aparece
--     hasta que llega el vale siguiente (o nunca, si no llega: fin de mes,
--     tanque que deja de usarse).
--   - Lo lee siempre la misma persona, el que despacha. Si esconde X litros
--     anotando el totalizador por debajo, nadie más lo lee.
--
-- Quien toma la varilla lo lee de forma independiente. La lectura entra en la
-- misma cadena que los vales, por VALOR, como un punto de 0 litros: lo que el
-- totalizador avanzó desde el punto anterior y ningún vale explica salió por
-- la manguera sin vale.
--
-- NULL para todo lo que no lo lleva: el historial anterior, la lectura
-- `inicial` del alta y los tanques con `usa_totalizador` apagado. No hace
-- falta tocar los tipos de alerta: se reusan totalizador_salto y
-- totalizador_retroceso, con `detalle.ancla = 'varilla'` y `lectura_id`.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_lecturas
  ADD COLUMN IF NOT EXISTS totalizador_lectura NUMERIC(14,3)
    CHECK (totalizador_lectura IS NULL OR totalizador_lectura >= 0);

-- Mismo índice parcial que el de los vales (0094): "el punto con el
-- totalizador más cercano por debajo". Parcial porque casi todo el historial
-- no lo trae.
CREATE INDEX IF NOT EXISTS idx_combustible_lecturas_totalizador
  ON combustible_lecturas (tenant_id, combustible_id, totalizador_lectura)
  WHERE totalizador_lectura IS NOT NULL AND anulada_en IS NULL;
