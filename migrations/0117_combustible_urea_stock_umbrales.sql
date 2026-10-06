-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: mínimo y máximo de stock de urea, con sus dos alertas
--
-- Segunda de las cuatro entregas del panel de urea. Ver
-- docs/architecture/urea-industrial.md (decisiones 4 y 5).
--
-- ── Qué pidió el cliente, y cómo se modeló ─────────────────────────────────
--
-- Kenif, 2026-10-04: "podemos poner un mínimo de urea para que genere alertas
-- y diga pocas ureas se necesita abastecer además claro un tope máximo para
-- que la empresa no compre más de lo que consume".
--
-- Son dos pedidos distintos y se resuelven con dos números, los dos GLOBALES
-- por empresa (no por equipo: el depósito de urea es uno, y el tope diario
-- por unidad ya existe desde 0092 para la otra mitad del problema).
--
-- El MÍNIMO es directo: stock por debajo de X litros, avisá.
--
-- El MÁXIMO necesita una decisión. "Que no compre más de lo que consume" se
-- puede modelar como un tope de COMPRA por período o como un techo de
-- ALMACÉN. Se eligió el techo de almacén por tres razones:
--
--   1. El tope por período obliga a definir el período, a decidir qué pasa
--      con una compra grande y legítima antes de un pico de obra, y a
--      mantener un acumulado nuevo que hay que sincronizar con cada
--      anulación -- el problema que 0059 vino a cerrar.
--   2. El techo de almacén da la misma protección con UN número y CERO
--      estado: al registrar una entrada se proyecta `stock actual + lo que
--      entra`, y si pasa el techo, alerta.
--   3. Y cubre un caso que el tope por período NO ve: comprar de a poco,
--      varias veces, hasta llenar el depósito. El acumulado por período se
--      reinicia; el stock proyectado no.
--
-- ── Ninguno de los dos bloquea ─────────────────────────────────────────────
--
-- A diferencia del tope de capacidad del tanque (0102), que SÍ bloquea
-- porque es físicamente imposible meter más litros de los que caben, acá no
-- hay imposibilidad física: siempre se puede apilar una caja más en el
-- depósito. Rechazar la entrada haría que no se registre -- y una compra sin
-- registrar es peor que una compra de más registrada. Alerta, no bloquea.
--
-- ── Los dos arrancan en NULL ───────────────────────────────────────────────
--
-- NULL = sin configurar = no alerta, la regla del módulo desde 0075. No se
-- inventa un número: un umbral inventado o alerta por trabajo normal --y
-- entonces se ignora, como ya enseñó "marcar todas leídas"-- o queda tan
-- alto que no atrapa nada. El asistente de umbrales (misma entrega) los
-- sugiere desde el historial cuando haya historial.
--
-- ── Por qué `urea_stock_bajo` NO es congelable y `urea_stock_excedido` SÍ ──
--
-- Es la distinción de TIPOS_ESTADO vs TIPOS_CONGELABLES
-- (combustible.repository.ts), y acá cae una de cada lado:
--
--   `urea_stock_bajo` es un ESTADO, igual que `nivel_bajo` del tanque: "queda
--   poca urea" deja de ser verdad en cuanto llega una compra. Congelarlo
--   dejaría una anomalía permanente de algo que ya se resolvió. Se
--   auto-resuelve cuando el stock vuelve a subir, y mientras está abierto no
--   se duplica -- mismo mecanismo exacto que nivel_bajo.
--
--   `urea_stock_excedido` es un HALLAZGO: una entrada concreta, en un momento
--   concreto, dejó el depósito por encima del techo. Eso sigue siendo cierto
--   para siempre, aunque el stock baje después. Se congela como anomalía si
--   nadie lo explica dentro de la ventana de gracia, igual que
--   `recepcion_discrepante`.
--
-- Por eso el CHECK de `combustible_anomalias` suma SOLO el segundo. Si se
-- sumaran los dos "por simetría", el worker de congelado convertiría en
-- anomalía permanente cada vez que la empresa se queda corta de urea antes de
-- la compra del mes -- ruido garantizado en el único lugar del módulo que no
-- puede tener ruido.
--
-- ── Las anclas ya existen, no hace falta tocar el CHECK ────────────────────
--
-- `combustible_alertas_ancla_check` (0073, extendido en 0092 y 0109) acepta
-- cinco anclas. Las dos alertas nuevas usan dos que ya están:
--
--   urea_stock_bajo      → `despacho_id`: el vale que dejó el stock por
--                          debajo del mínimo. Es la única ancla disponible
--                          (la urea no tiene fila de tanque) y además es la
--                          útil: desde la alerta se llega al movimiento que
--                          cruzó la línea.
--   urea_stock_excedido  → `recepcion_id`: la entrada que pasó el techo.
--
-- Se verificó a mano antes de escribir esto. La lección es de la entrega
-- anterior: en 0092 una alerta nueva no entraba en el CHECK de anclas y el
-- INSERT fallaba dentro de un try/catch best-effort -- la alerta se perdía en
-- silencio y el log decía "no se pudo evaluar". Un CHECK de anclas que no
-- contempla un tipo nuevo no da error visible: da una alerta que nunca nace.
--
-- Aplicar:
--   psql -d mincoreerp -f migrations/0117_combustible_urea_stock_umbrales.sql
-- (o `npm run migrate`, que la toma por orden de nombre)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Los dos números, en la config de la empresa ─────────────────────────
ALTER TABLE combustible_config
  -- Litros de urea por debajo de los cuales hay que reabastecer. NULL = no
  -- alerta.
  ADD COLUMN IF NOT EXISTS stock_minimo_urea_l NUMERIC(12, 2),
  -- Techo de litros en el depósito. Al registrar una entrada se compara
  -- contra `stock + lo que entra`, no contra la entrada sola. NULL = no
  -- alerta.
  ADD COLUMN IF NOT EXISTS stock_maximo_urea_l NUMERIC(12, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_stock_min_urea_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_stock_min_urea_check
      -- Mayor que 0, no mayor o igual: "avisame cuando el stock baje de 0 L"
      -- no es un pedido que alguien vaya a hacer, y aceptarlo dejaría un
      -- control que parece configurado y nunca dispara. Mismo criterio que
      -- los topes de 0079.
      CHECK (stock_minimo_urea_l IS NULL OR stock_minimo_urea_l > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_stock_max_urea_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_stock_max_urea_check
      CHECK (stock_maximo_urea_l IS NULL OR stock_maximo_urea_l > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_stock_urea_orden_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_stock_urea_orden_check
      -- Un mínimo por encima del máximo es una configuración que se
      -- contradice a sí misma: el stock estaría siempre en falta Y siempre
      -- excedido a la vez, y las dos alertas dispararían juntas en cada
      -- movimiento. Es el único caso de esta migración que SÍ se bloquea,
      -- por la misma razón que se bloquea un cambio de unidad con historial:
      -- no es una política de la empresa, es un dato imposible.
      --
      -- Se permite que falte cualquiera de los dos (es el estado normal:
      -- NULL = ese control apagado).
      CHECK (
        stock_minimo_urea_l IS NULL
        OR stock_maximo_urea_l IS NULL
        OR stock_minimo_urea_l < stock_maximo_urea_l
      );
  END IF;
END $$;

-- ── 2. Los dos tipos de alerta nuevos ──────────────────────────────────────
-- La lista se reescribe entera (no hay ADD VALUE para un CHECK): es la misma
-- de 0114 más los dos de acá. Tiene que seguir espejada con TIPOS_ALERTA en
-- combustible.repository.ts -- si las dos listas se separan, el INSERT falla
-- con un CHECK violation dentro de un try/catch best-effort y la alerta se
-- pierde sin que nadie lo note.
DO $$
BEGIN
  ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;
  ALTER TABLE combustible_alertas
    ADD CONSTRAINT combustible_alertas_tipo_check
    CHECK (tipo IN (
      'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
      'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
      'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
      'vale_fuera_de_orden', 'lectura_retroactiva', 'tope_diario_excedido',
      'tanque_sin_vigilancia', 'recepcion_sin_validar', 'varilla_sin_control',
      'descuadre_ventana', 'despacho_retroactivo', 'vale_recargado',
      'recepcion_anulada', 'recepcion_discrepante', 'recepcion_retroactiva',
      'consumo_excedido', 'varilla_exacta',
      'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo',
      -- 0117: los dos del stock de urea.
      'urea_stock_bajo', 'urea_stock_excedido',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada'
    ));

  -- Las ANOMALÍAS (lo que se congela) suman SOLO urea_stock_excedido. Ver el
  -- encabezado: el stock bajo es un ESTADO, se resuelve solo cuando llega la
  -- compra, y congelarlo dejaría una anomalía permanente de algo arreglado.
  ALTER TABLE combustible_anomalias DROP CONSTRAINT IF EXISTS combustible_anomalias_tipo_check;
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
      'urea_stock_excedido',
      'historial_sin_contrastar',
      'totalizador_salto', 'totalizador_retroceso',
      'precinto_alterado', 'precinto_reemplazado',
      'equipo_de_otro_grifo', 'sobrestock_recepcion', 'lectura_anulada',
      'tanqueta_sobregirada'
    ));
END $$;

-- ── 3. Índice para el "¿ya hay una alerta de stock bajo abierta?" ──────────
-- La consulta corre en CADA vale de urea (es lo que evita duplicar la alerta
-- mientras el stock sigue bajo), así que no puede ser un scan de la tabla de
-- alertas. Parcial sobre las abiertas: son las únicas que se preguntan, y así
-- el índice queda chico aunque la tabla crezca.
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_urea_stock_abierta
  ON combustible_alertas (tenant_id, tipo)
  WHERE resuelta_en IS NULL AND tipo IN ('urea_stock_bajo', 'urea_stock_excedido');
