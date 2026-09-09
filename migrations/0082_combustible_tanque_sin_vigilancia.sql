-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el tanque que OPERA ciego
--
-- Kenif, al ver la etiqueta roja "Sin vigilancia" en la simulación: *"sería
-- bueno que el sistema pida como requisito que estén cargados los umbrales,
-- sin ello que no se cree el tanque"*.
--
-- ── Por qué NO se bloquea el alta ───────────────────────────────────────
--
-- Porque el número correcto no existe el día uno. El umbral bueno sale del
-- historial del propio tanque --cuánto ruido tiene su varilla, qué tan largos
-- son sus ciclos-- y por eso el asistente de calibración exige 10 mediciones
-- antes de sugerir nada. Obligar a poner un número para poder crear el tanque
-- obliga a INVENTARLO, y un umbral inventado termina en uno de dos lugares:
--
--   · muy ajustado -> alerta con el trabajo normal -> a la semana nadie mira
--     las alertas, y ahí se pierde también el día que importaba;
--   · muy holgado -> no atrapa nada, pero el tanque FIGURA como configurado.
--
-- El segundo es peor que la etiqueta roja. La etiqueta dice la verdad ("esto
-- todavía no se vigila"); un 2 % inventado es una mentira que parece
-- seguridad. Y en la carga masiva por Excel, pedir tres porcentajes por fila
-- garantiza que se llenen con cualquier cosa.
--
-- ── Dónde estaba el hueco de verdad ─────────────────────────────────────
--
-- No en el alta: el alta ya OBLIGA a elegir entre Recomendado, Personalizado
-- y Sin vigilar (sin preselección), y desde 0081 crear uno ciego le avisa por
-- correo a todos los admins.
--
-- El hueco es que después nadie insiste. Un tanque puede despachar miles de
-- litros durante meses con los tres umbrales en NULL, y lo único que lo dice
-- es una etiqueta pasiva que hay que ir a mirar.
--
-- Esta alerta convierte ese estado permanente en algo que molesta hasta que
-- alguien lo arregla. Y para cuando salta, el tanque YA TIENE historial: el
-- asistente puede sugerir el número de verdad, en vez de uno inventado.
--
-- ── Cuándo salta, con precisión ─────────────────────────────────────────
--
-- Los TRES umbrales de descuadre en NULL (tramo, ciclo y ventana). Ese es el
-- estado en que ningún faltante es detectable. Con uno solo configurado el
-- tanque ya no es ciego --detecta menos, y para eso está la etiqueta ámbar de
-- "vigilancia parcial", que no necesita alerta.
--
-- `umbral_diferencia_pct` queda afuera a propósito: vigila la factura del
-- proveedor contra lo descargado, no el faltante del tanque. Un tanque sin él
-- no es ciego al robo.
--
-- Y solo si el tanque ESTÁ OPERANDO: tiene que haber despachos reales en la
-- ventana. Un tanque recién dado de alta que todavía no despachó nada no
-- tiene por qué alertar -- no hay nada que vigilar aún, y sería ruido el
-- primer día.
--
-- EJECUTAR (después de 0081):
--   psql -d mincoreerp -f migrations/0082_combustible_tanque_sin_vigilancia.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_config
  -- Cuántos días puede un tanque despachar sin umbrales antes de que el
  -- sistema empiece a insistir. Default 7: una semana da tiempo a poner el
  -- tanque en marcha y juntar las primeras mediciones, sin que un tanque
  -- ciego pase un mes entero despachando en silencio.
  ADD COLUMN IF NOT EXISTS dias_sin_vigilancia INT NOT NULL DEFAULT 7;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_sin_vigilancia_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_sin_vigilancia_check
      -- Mínimo 1 día: alertar el mismo día del alta sería ruido, todavía no
      -- hay con qué calibrar. Máximo 90: más que eso no es "dar tiempo", es
      -- aceptar que el tanque no se vigile.
      CHECK (dias_sin_vigilancia BETWEEN 1 AND 90);
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
    'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
    'tanque_sin_vigilancia'
  ));
