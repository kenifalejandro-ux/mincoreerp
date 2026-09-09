-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el vale que llega tarde y el vale que se vuelve a cargar
--
-- Hallazgos 2 y 3 del red team de OPERACIÓN (nueve días simulados con el robo
-- escondido entre tráfico normal).
--
-- Ninguno de los dos se ataca bloqueando. Los dos mecanismos que explotan son
-- deliberados y correctos; lo que faltaba era la señal.
--
-- ── 2. EL VALE RETRO-FECHADO ────────────────────────────────────────────
--
-- `despachado_en` lo escribe quien carga; el evento de auditoría lo estampa
-- el servidor. Fechando el vale ANTES de un aflojamiento de umbrales, sale de
-- la cuenta de "lo que se movió con la vigilancia baja" del reporte de
-- controles. El arreglo de #155 ya tapó el daño de fondo --la varilla no se
-- puede retro-fechar contra la física-- pero el acto de retro-fechar en sí
-- seguía sin dejar señal.
--
-- La distancia entre CUÁNDO PASÓ (`despachado_en`) y CUÁNDO ENTRÓ
-- (`creado_en`) es el dato. La cola offline produce horas, a veces un par de
-- días: un tanque sin señal sincroniza cuando el operador vuelve a base. Un
-- vale cargado tres semanas después de su fecha no es sincronización, es
-- alguien eligiendo una fecha.
--
-- ALERTA Y NO BLOQUEA, por el mismo motivo de siempre: perder un vale real de
-- cancha es peor que marcar uno sospechoso. El módulo entero está construido
-- sobre la premisa de que un despacho SIN registrar es el peor resultado
-- posible.
--
-- ── 3. EL VALE QUE SE VUELVE A CARGAR ───────────────────────────────────
--
-- La migración 0067 hizo la unicidad PARCIAL a propósito, y ahí quedó escrito
-- por qué: si anular el vale 00022 impidiera volver a cargarlo, corregir un
-- tipeo BORRARÍA del sistema un despacho que sí ocurrió -- la fuga que este
-- módulo existe para detectar, causada por el propio mecanismo de corrección.
--
-- Esa misma migración anticipó el hallazgo con estas palabras: "un número con
-- tres anulaciones y una vigente queda visible como tal, y ese patrón, si se
-- repite, es en sí mismo señal para la conciliación". El detector nunca se
-- escribió. Esto es ese detector.
--
-- Lo que importa no es que el número se reutilice --eso es la corrección
-- funcionando-- sino QUE LA CANTIDAD CAMBIE. Cargar 900 L, anular con "error
-- de tipeo" y volver a cargar 240 deja el talonario impecable y 660 L fuera
-- del sistema. El faltante igual aparece en la varilla, así que no es una
-- fuga invisible; pero es una explicación lista, y el detalle de la alerta
-- ahora dice exactamente cuánto se movió el número.
--
-- EJECUTAR (después de 0080):
--   psql -d mincoreerp -f migrations/0081_combustible_vale_retroactivo_y_recargado.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_config
  -- Días de distancia tolerados entre la fecha del vale y su carga. Default 3:
  -- cubre el fin de semana de un operador que quedó sin señal en cancha. A
  -- diferencia de los umbrales de descuadre --que NO llevan default porque el
  -- número lo sabe la operación-- acá el límite lo pone la tecnología, no el
  -- negocio: es cuánto puede tardar una cola offline en sincronizar.
  ADD COLUMN IF NOT EXISTS dias_carga_retroactiva INT NOT NULL DEFAULT 3;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_carga_retro_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_carga_retro_check
      -- Mínimo 1 día: con menos, cualquier vale cargado al cierre del turno
      -- siguiente alertaría, y un control que salta con el trabajo normal se
      -- ignora. Máximo 90: más que eso no es tolerancia, es no mirar.
      CHECK (dias_carga_retroactiva BETWEEN 1 AND 90);
  END IF;
END $$;

-- ── Tipos de alerta nuevos ──────────────────────────────────────────────

ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
    'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado'
  ));

-- Buscar las anulaciones previas de un número de vale se hace en CADA
-- despacho. El índice parcial de 0067 solo cubre las VIGENTES.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_vale_anulado
  ON combustible_despachos(tenant_id, serie_talonario, n_vale)
  WHERE anulada_en IS NOT NULL;
