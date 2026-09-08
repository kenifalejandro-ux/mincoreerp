-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: tope diario por actor (cuánto puede recibir UNO en 24 horas)
--
-- Hallazgos 1 y 2 de la simulación de robo contra el módulo ya endurecido.
--
-- ── El hueco ────────────────────────────────────────────────────────────
--
-- `evaluarSobredespacho` (0069/0070) compara UN vale contra la capacidad del
-- tanque del equipo. Es un control por vale, no por actor. En la simulación
-- alcanzó con partir el robo: tres vales de 400 L al mismo volquete, que
-- tiene un tanque de 500 L. Ninguno excedió nada. Se fueron 1.200 L.
--
-- Y hay un segundo hueco más grande: `planta` y `reserva_cubeta` no tienen
-- equipo, así que NO TIENEN NINGÚN TECHO. Un vale a "planta" por 8.000 L
-- pasa igual que uno por 80. El único límite es el nivel del tanque.
--
-- ── El control ──────────────────────────────────────────────────────────
--
-- Se acumula lo despachado a un mismo actor en una ventana móvil de 24 horas
-- y se compara contra su techo. "Actor" es el equipo cuando el destino es un
-- equipo, y el tipo de destino cuando no lo hay (todos los vales a planta
-- suman juntos).
--
-- VENTANA MÓVIL, no día calendario. Un corte a medianoche es un regalo: se
-- sacan dos topes completos en cuatro horas, 22:00 y 02:00, y ninguno de los
-- dos días excede. Además evita la pregunta de en qué huso horario empieza
-- el día del tenant.
--
-- ── Los dos techos ──────────────────────────────────────────────────────
--
-- `llenados_por_dia_max` -- cuántas veces por día puede llenarse el tanque
-- de un equipo. El techo sale de multiplicarlo por `equipos.capacidad_tanque`
-- (0069), así que solo funciona en equipos que TENGAN la capacidad cargada.
-- Hoy están todas en NULL a propósito: sin el dato no se inventa un límite.
--
-- `tope_diario_sin_capacidad_l` -- litros por día, absoluto, para todo lo
-- demás: planta, reserva en cubeta, y los equipos sin capacidad cargada. Es
-- el que tapa el agujero grande, y no depende de ningún dato de equipo.
--
-- LOS DOS ARRANCAN EN NULL. Misma semántica que los umbrales desde 0075:
-- NULL = sin configurar = no alerta. No se inventa un número: un techo
-- inventado o alerta por trabajo normal (y entonces se ignora, como ya
-- enseñó "marcar todas leídas") o queda tan alto que no atrapa nada.
--
-- ── Por qué alerta y no bloquea ─────────────────────────────────────────
--
-- Mismo criterio que sobredespacho y que la lectura retroactiva (0078): hay
-- días legítimos en que un equipo carga de más -- un turno doble, una
-- máquina que se quedó en cancha. Bloquear el vale haría que el operador
-- deje de registrarlo, y un despacho sin registrar es peor que uno marcado.
--
-- ── Por qué solo alerta el vale que CRUZA la línea ──────────────────────
--
-- Si un volquete pasó el techo en el vale 3, los vales 4 y 5 del mismo día
-- también lo superan -- pero es la misma situación, no tres hallazgos. Se
-- alerta una sola vez, en el vale que cruzó. El exceso posterior queda en el
-- detalle de esa alerta cuando se revisa.
--
-- EJECUTAR (después de 0078):
--   psql -d mincoreerp -f migrations/0079_combustible_tope_diario.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_config
  -- NUMERIC y no INT: "dos llenados y medio" es una política razonable para
  -- un equipo que a veces sale con el tanque a la mitad.
  ADD COLUMN IF NOT EXISTS llenados_por_dia_max NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS tope_diario_sin_capacidad_l NUMERIC(12,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_llenados_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_llenados_check
      -- Mínimo 0.1: cero no significa "estricto" acá (a diferencia de los
      -- umbrales de %), significa "ningún equipo puede recibir nada", que
      -- alertaría cada vale y volvería inútil el control. Máximo 50: un
      -- techo más alto que eso no es un techo.
      CHECK (llenados_por_dia_max IS NULL OR llenados_por_dia_max BETWEEN 0.1 AND 50);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_tope_sin_capacidad_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_tope_sin_capacidad_check
      CHECK (tope_diario_sin_capacidad_l IS NULL OR tope_diario_sin_capacidad_l > 0);
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
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido'
  ));

-- El acumulado de 24 h se consulta en CADA despacho a un equipo, y el filtro
-- real es (tenant, equipo, ventana de tiempo). El índice de 0062 sobre
-- equipo_id solo no alcanza cuando un equipo tiene meses de historial.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_actor_fecha
  ON combustible_despachos(tenant_id, equipo_id, despachado_en)
  WHERE anulada_en IS NULL;

-- El mismo acumulado para los destinos sin equipo (planta / reserva).
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_destino_fecha
  ON combustible_despachos(tenant_id, tipo_destino, despachado_en)
  WHERE anulada_en IS NULL AND equipo_id IS NULL;
