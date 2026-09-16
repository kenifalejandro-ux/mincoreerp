-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la lista de tipos de alerta deja de poder desincronizarse
--
-- 5ª auditoría (red team técnico, 2026-09-14). El hallazgo más grave de esa
-- ronda no fue un robo: fue que el control se APAGABA SOLO.
--
-- ── Lo que pasaba ───────────────────────────────────────────────────────
--
-- `combustible_anomalias_tipo_check` se reescribió por última vez en 0076,
-- con seis tipos. Después llegaron `tope_diario_excedido` (0079),
-- `descuadre_ventana` (0080) y `vale_recargado` (0081), y el worker de
-- conciliación empezó a congelarlos -- pero nadie volvió a tocar el CHECK.
--
-- Una alerta de cualquiera de esos tres tipos que pasaba su ventana de gracia
-- sin revisar (72 h, o sea: operación normal) hacía fallar el INSERT de la
-- anomalía. El error deshacía la corrida ENTERA del tenant --incluidas las
-- alertas de "tanque sin medir" y "operando sin vigilancia" que se acababan de
-- detectar-- y cortaba el recorrido de los tenants que venían después.
--
-- Verificado atacando la API: un tanque con diez días sin varilla no recibió
-- su alerta. Y "dejar de medir" apaga los cuatro umbrales a la vez, así que
-- el efecto final era la vigilancia completa apagada por no mirar una alerta.
--
-- ── Por qué pasó, que es lo que esta migración cierra ───────────────────
--
-- La lista de tipos vivía en CUATRO lugares escritos a mano: el CHECK de
-- alertas, el CHECK de anomalías, la consulta del worker y la lista de tipos
-- que se revisan a mano. Cada tipo nuevo tenía que acordarse de los cuatro.
--
-- Ahora la fuente de verdad es el código (`TIPOS_ALERTA`, `TIPOS_CONGELABLES`
-- y `TIPOS_REVISABLES` en combustible.repository.ts) y un test
-- (tests/combustible-tipos-de-alerta-sincronizados.test.ts) compara esas
-- listas contra los CHECK REALES de la base. El próximo tipo que se agregue
-- en un lado y no en el otro rompe CI, no producción.
--
-- ── Qué se congela y qué no ─────────────────────────────────────────────
--
-- Se congela todo HALLAZGO que alguien tiene que explicar y no explicó dentro
-- de la ventana de gracia. La 5ª auditoría agregó cuatro que antes nunca se
-- congelaban y podían quedar abiertos para siempre: `vale_anulado` (la
-- maniobra de fraude más limpia), `vale_fuera_de_orden`, `lectura_retroactiva`
-- y `despacho_retroactivo`. Y `despacho_tardio`, que ya se revisaba a mano.
--
-- NO se congelan los ESTADOS, que se resuelven solos cuando el problema deja
-- de existir: `nivel_bajo` (se repone), `tanque_sin_medir` (se mide),
-- `tanque_sin_vigilancia` (se configura un umbral), `recepcion_sin_validar`
-- (se valida) y `varilla_sin_control` (alguien independiente mide). Congelar
-- un estado dejaría una "anomalía" permanente de algo que ya se arregló.
--
-- ── Tipos nuevos (5ª auditoría) ─────────────────────────────────────────
--
--   recepcion_anulada      anular una recepción no avisaba a nadie
--   recepcion_discrepante  administración validó otra cantidad que la cargada
--   recepcion_sin_validar  la recepción sigue sin validar pasado el plazo
--   recepcion_retroactiva  recepción fechada atrás, detrás de movimientos
--   consumo_excedido       el equipo consumió más por hora/km que su máximo
--   varilla_sin_control    N días sin una varilla de alguien que no despacha
--   varilla_exacta         varillas que cuadran al litro una y otra vez
--
-- ── lectura_id: sobre QUÉ varilla es la alerta ──────────────────────────
--
-- Las alertas de descuadre se anclaban al tanque y nada más. Por eso cerrar
-- la alerta de la varilla PROPIA nunca contaba como autorrevisión: el sistema
-- no sabía quién la había tomado. Con `lectura_id` la pregunta "¿el que
-- cierra es el que midió?" tiene respuesta.
--
-- CASCADE y no SET NULL, mismo criterio que 0073: una lectura no se borra
-- nunca (se anula), así que esto solo actúa al borrar el tenant entero.
--
-- EJECUTAR (después de 0085):
--   psql -d mincoreerp -f migrations/0086_combustible_tipos_de_alerta_y_varilla_de_origen.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Todos los tipos que puede tener una alerta ──────────────────────────
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
    'varilla_exacta'
  ));

-- ── Los que se congelan como anomalía permanente ────────────────────────
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
    'consumo_excedido', 'varilla_exacta'
  ));

-- ── La varilla sobre la que es la alerta ────────────────────────────────
ALTER TABLE combustible_alertas
  ADD COLUMN IF NOT EXISTS lectura_id BIGINT
    REFERENCES combustible_lecturas(id) ON DELETE CASCADE;

ALTER TABLE combustible_anomalias
  ADD COLUMN IF NOT EXISTS lectura_id BIGINT
    REFERENCES combustible_lecturas(id) ON DELETE CASCADE;

-- Cobertura de FK (tests/db-index-coverage.test.ts lo exige).
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_lectura
  ON combustible_alertas(lectura_id) WHERE lectura_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_lectura
  ON combustible_anomalias(lectura_id) WHERE lectura_id IS NOT NULL;

-- La deduplicación de las alertas de acumulado (ciclo y ventana): "¿este
-- tanque ya tiene una abierta de este tipo?". Antes cada varilla creaba una
-- nueva, con su correo, mientras el acumulado siguiera pasado -- cinco
-- varillas, cinco alertas iguales, y el control moría por ruidoso.
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_acumulado_abierto
  ON combustible_alertas(tenant_id, combustible_id, tipo)
  WHERE resuelta_en IS NULL AND congelada_en IS NULL;
