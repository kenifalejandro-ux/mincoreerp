-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: UREA AUTOMOTRIZ (Green 32 / AdBlue) -- pestaña propia, mismas
-- tablas de Combustible
--
-- Ver docs/architecture/control-de-combustible.md y la memoria de diseño
-- (combustible_urea_alcance, preguntas_cliente_urea). Decisión de Kenif
-- (2026-09-10/16), confirmada con respuestas del cliente:
--
--   1. Pestaña DENTRO de Combustible, no módulo nuevo -- mismas tablas.
--   2. El stock va en LITROS, con el factor de conversión GUARDADO en cada
--      movimiento (nunca recalculado -- mismo criterio que la unidad del
--      tanque, ver validarCambioDeUnidad).
--   3. La entrada la registra el grifero "por ahora" -- reversible.
--   4. Todos los controles anti-robo del combustible, adaptados: talonario
--      (el cliente SÍ aceptó uno propio para urea), tope diario, y dos
--      nuevos que la urea permite y el combustible no (equipo habilitado,
--      ratio urea/diésel) + el reemplazo de la varilla (conteo físico).
--
-- ── Por qué NO se toca el enum tipo_combustible ──────────────────────────
--
-- Decisión explícita de Kenif: la urea no es un combustible más en ese
-- enum. Se agrega `producto` como discriminador nuevo, ortogonal a
-- `tipo_combustible` (que para las filas de urea queda NULL -- no hay
-- "tipo" de urea que declarar, a diferencia de diésel/gasolina/glp).
--
-- ── Por qué `producto` entra en la unicidad del talonario ────────────────
--
-- El cliente aceptó un talonario PROPIO para urea (pregunta 4). Sin agregar
-- `producto` al índice único parcial de 0067, una serie de urea que por
-- casualidad se llame igual que una serie de combustible (ej. las dos
-- arrancan un talonario "2026-01") pisaría la numeración de la otra --
-- exactamente el mismo problema que resuelve `serie_talonario` para dos
-- talonarios de combustible en paralelo. `producto` pasa a ser parte del
-- espacio de nombres del talonario, no una etiqueta después.
--
-- ── Por qué el factor de conversión se CONGELA en la fila ────────────────
--
-- Mismo principio que costo_unitario (0063) y la unidad del tanque
-- (validarCambioDeUnidad en el service): si mañana alguien corrige "caja =
-- 16 L" a otra cosa, un historial que recalcula se reinterpreta solo. Hoy
-- el cliente confirmó que la caja SIEMPRE trae 4 bolsas de 4 L (sin el "por
-- lo general" de la respuesta de agosto), pero el dato se guarda igual --
-- congelarlo cuesta una columna y evita que un cambio de política futuro
-- reescriba en silencio litros ya declarados.
--
-- ── Por qué compra_externa y no un tercer valor de `origen` ──────────────
--
-- El cliente confirmó que la urea SIEMPRE viene de un proveedor externo
-- (no hay tanque propio de urea que descontar) -- encaja tal cual en el
-- origen que ya existe. Lo que cambia es la FORMA del vale: sin
-- horómetro/odómetro/horas_abastecidas (el cliente los descartó
-- explícitamente para urea), con presentación/factor/bultos en su lugar.
--
-- ── Por qué las recepciones se relajan (combustible_id nullable) ─────────
--
-- Una recepción de combustible es "el tanque X recibió Y" -- sin tanque no
-- existe (0064: combustible_id NOT NULL). La urea no tiene tanque, así que
-- esa NOT NULL tiene que aflojarse. La alternativa (una tabla de entradas
-- aparte) hubiera duplicado todo el aparato ya construido: catálogo de
-- grifos, anulación con motivo, auditoría, el propio findRecepciones con su
-- `diferencia_litros` -- que para una fila de urea (combustible_id NULL) da
-- NULL solo, sin tocar la consulta: no hay varilla que comparar, así que no
-- hay diferencia que calcular. Es el comportamiento correcto, no un caso
-- sin cubrir.
--
-- ── El costo unitario de urea NO se pondera (a propósito) ────────────────
--
-- La Fase C pondera el costo del TANQUE porque el combustible que ya había
-- adentro se mezcla físicamente con el que entra. La urea no se mezcla en
-- ningún depósito común -- son cajas discretas -- así que cada recepción
-- guarda su propio costo (igual que hoy) y el service, al armar el vale de
-- salida, promedia las recepciones vigentes al momento del despacho para
-- sugerir un costo, sin inventar una columna de estado mutable (ver 0059:
-- no guardar lo que se puede derivar).
--
-- ── El reemplazo de la varilla: conteo físico de envases ─────────────────
--
-- El nivel de un tanque es MEDIDO (varilla) y por eso existe el descuadre:
-- declarado contra medido. Sin eso, la urea sería un stock que solo sale de
-- restar movimientos -- el que roba sin registrar la salida deja el
-- sistema perfectamente cuadrado. `combustible_conteos_urea` es la
-- contraparte física: alguien cuenta las cajas/bolsas que quedan, se
-- convierte a litros con el mismo criterio congelado, y se compara contra
-- el stock teórico (entradas − salidas vigentes hasta esa fecha).
--
-- Kenif confirmó (2026-09-16) que la MISMA persona recibe, reparte Y
-- cuenta -- cero segregación de funciones. No se bloquea (ver
-- combustible_auditoria_adversaria: "si el admin es el dueño nadie lo
-- vigila"): se expone la autorrevisión, mismo mecanismo que
-- resolverAlertaManual.
--
-- EJECUTAR (después de 0091):
--   psql -d mincoreerp -f migrations/0092_combustible_urea.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. equipos: qué unidades usan urea ───────────────────────────────────
-- Default TRUE porque la mayoría de la flota (Euro V/SCR) sí consume urea;
-- el cliente confirmó que camionetas y maquinaria amarilla NO (pregunta
-- 15) -- esas se marcan en FALSE al cargar/editar el equipo. Es el control
-- gratis que salió de esa respuesta: un vale de urea a un equipo marcado
-- en FALSE es sospechoso por definición, sin ningún dato nuevo.
ALTER TABLE equipos
  ADD COLUMN IF NOT EXISTS usa_urea BOOLEAN NOT NULL DEFAULT true;

-- ── 2. combustible_grifos: el proveedor de urea es "aparte" ──────────────
-- El cliente confirmó (pregunta 9) que compran la urea a un proveedor
-- DISTINTO de los grifos de combustible (PRIMAX, VELASQUEZ). Mismo patrón
-- que abastece_ruta/abastece_tanque (0065): un proveedor puede vender las
-- tres cosas y sigue siendo UNA ficha, pero hoy en Santa Isabel será una
-- fila nueva con solo este flag en true.
ALTER TABLE combustible_grifos
  ADD COLUMN IF NOT EXISTS abastece_urea BOOLEAN NOT NULL DEFAULT false;

-- ── 3. combustible_despachos: el discriminador + las columnas de urea ────
-- `tipo_combustible` era NOT NULL desde 0057 -- pero urea no es ninguno de
-- los tres valores del enum (diesel_b5/gasolina_90/glp) y Kenif fue
-- explícito: la urea NO entra en ese enum. Se afloja la columna; los CHECK
-- de forma de más abajo vuelven a exigirla NOT NULL para producto=
-- 'combustible' y la prohíben (debe ser NULL) para producto='urea'.
ALTER TABLE combustible_despachos
  ALTER COLUMN tipo_combustible DROP NOT NULL;

ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS producto VARCHAR(20) NOT NULL DEFAULT 'combustible',
  -- Cómo se dispensó -- de la planilla real del cliente y su respuesta:
  -- bolsa (4 L), caja (16 L, siempre 4 bolsas), balde (20 L). Nullable:
  -- solo aplica a producto='urea'.
  ADD COLUMN IF NOT EXISTS presentacion VARCHAR(20),
  -- Litros por unidad de presentación, CONGELADO en cada fila -- ver el
  -- encabezado. No es una constante del código: si el cliente confirma
  -- otro tamaño de envase el día de mañana, las filas viejas no cambian.
  ADD COLUMN IF NOT EXISTS factor_litros NUMERIC(6, 2),
  -- Cuántas unidades de esa presentación se despacharon -- lo que el
  -- grifero realmente cuenta y tipea. `cantidad` (ya existe) sigue siendo
  -- la fuente de verdad en litros = cantidad_bultos × factor_litros,
  -- calculado por el SERVICE al crear la fila, nunca recalculado después.
  ADD COLUMN IF NOT EXISTS cantidad_bultos INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_producto_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_producto_check
      CHECK (producto IN ('combustible', 'urea'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_presentacion_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_presentacion_check
      CHECK (presentacion IS NULL OR presentacion IN ('bolsa', 'caja', 'balde'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_factor_litros_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_factor_litros_check
      CHECK (factor_litros IS NULL OR factor_litros > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_cantidad_bultos_check'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_cantidad_bultos_check
      CHECK (cantidad_bultos IS NULL OR cantidad_bultos > 0);
  END IF;
END $$;

-- Los dos CHECK de "forma completa" de 0062/0063/0088 solo miran `origen`
-- -- y la urea SIEMPRE usa origen='compra_externa' (no hay tanque propio),
-- así que `..._forma_compra_externa_check` los rechazaría a todos (exige
-- horas_abastecidas + horómetro-u-odómetro, que el cliente descartó para
-- urea). Se envuelven los dos con "producto <> 'combustible' OR" para que
-- solo apliquen a las filas de combustible, y se agrega un tercer CHECK
-- con la forma propia de urea.
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_tanque_propio_check;
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_compra_externa_check;

ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_tanque_propio_check
  CHECK (
    producto <> 'combustible' OR origen <> 'tanque_propio' OR (
      combustible_id IS NOT NULL
      AND tipo_combustible IS NOT NULL
      AND lectura_contometro IS NOT NULL
      AND grifo_id IS NULL
      AND horas_abastecidas IS NULL
      AND (lectura_horometro IS NULL OR lectura_odometro IS NULL)
      AND (tipo_destino = 'equipo' OR (lectura_horometro IS NULL AND lectura_odometro IS NULL))
    )
  );

ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_compra_externa_check
  CHECK (
    producto <> 'combustible' OR origen <> 'compra_externa' OR (
      combustible_id IS NULL
      AND tipo_combustible IS NOT NULL
      AND lectura_contometro IS NULL
      AND grifo_id IS NOT NULL
      AND horas_abastecidas IS NOT NULL
      AND (
        (lectura_horometro IS NOT NULL AND lectura_odometro IS NULL)
        OR (lectura_horometro IS NULL AND lectura_odometro IS NOT NULL)
      )
    )
  );

-- Forma completa de urea: siempre compra_externa, siempre a un equipo
-- (planta/reserva quedan afuera -- el cliente nunca los mencionó, y un
-- vale de urea sin equipo no tiene con qué cruzar el control de ratio
-- urea/diésel ni el de "equipo habilitado"), con proveedor + presentación
-- + factor + bultos, y NINGUNO de los campos de combustible (tanque,
-- contómetro, horómetro, odómetro, horas).
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_forma_urea_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_urea_check
  CHECK (
    producto <> 'urea' OR (
      origen = 'compra_externa'
      AND tipo_destino = 'equipo'
      AND equipo_id IS NOT NULL
      AND grifo_id IS NOT NULL
      AND combustible_id IS NULL
      AND tipo_combustible IS NULL
      AND lectura_contometro IS NULL
      AND lectura_horometro IS NULL
      AND lectura_odometro IS NULL
      AND horas_abastecidas IS NULL
      AND presentacion IS NOT NULL
      AND factor_litros IS NOT NULL
      AND cantidad_bultos IS NOT NULL
      AND cantidad = cantidad_bultos * factor_litros
    )
  );

-- ── El talonario de urea es un espacio de nombres PROPIO ─────────────────
-- Ver el encabezado. Se reemplaza el índice único parcial de 0067 por uno
-- que también separa por producto -- así "UREA-2026-01" y un futuro
-- talonario de combustible con el mismo nombre nunca compiten por el mismo
-- número.
DROP INDEX IF EXISTS idx_combustible_despachos_vale_vigente;
CREATE UNIQUE INDEX IF NOT EXISTS idx_combustible_despachos_vale_vigente
  ON combustible_despachos(tenant_id, producto, serie_talonario, n_vale)
  WHERE anulada_en IS NULL;

-- Listado/tope diario/kardex de urea filtran por producto constantemente.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_producto
  ON combustible_despachos(tenant_id, producto, despachado_en)
  WHERE anulada_en IS NULL;

-- ── 4. combustible_recepciones: mismo discriminador, combustible_id se
--      relaja ───────────────────────────────────────────────────────────
ALTER TABLE combustible_recepciones
  ADD COLUMN IF NOT EXISTS producto VARCHAR(20) NOT NULL DEFAULT 'combustible',
  ADD COLUMN IF NOT EXISTS presentacion VARCHAR(20),
  ADD COLUMN IF NOT EXISTS factor_litros NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS cantidad_bultos INTEGER;

-- Una recepción de combustible sin tanque no existe (0064) -- pero una de
-- urea nunca tiene tanque. Se afloja la NOT NULL original; el CHECK de
-- forma de abajo la vuelve a exigir para producto='combustible'.
ALTER TABLE combustible_recepciones
  ALTER COLUMN combustible_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_producto_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_producto_check
      CHECK (producto IN ('combustible', 'urea'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_presentacion_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_presentacion_check
      CHECK (presentacion IS NULL OR presentacion IN ('bolsa', 'caja', 'balde'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_factor_litros_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_factor_litros_check
      CHECK (factor_litros IS NULL OR factor_litros > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_cantidad_bultos_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_cantidad_bultos_check
      CHECK (cantidad_bultos IS NULL OR cantidad_bultos > 0);
  END IF;

  -- Forma completa por producto: combustible exige tanque y nada de urea;
  -- urea exige presentación/factor/bultos y NUNCA tanque (no tiene uno que
  -- descontar). grifo_id sigue NOT NULL para los dos -- el proveedor de
  -- urea es una fila más del mismo catálogo (con abastece_urea=true).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_forma_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_forma_check
      CHECK (
        (
          producto = 'combustible'
          AND combustible_id IS NOT NULL
          AND presentacion IS NULL
          AND factor_litros IS NULL
          AND cantidad_bultos IS NULL
        ) OR (
          producto = 'urea'
          AND combustible_id IS NULL
          AND presentacion IS NOT NULL
          AND factor_litros IS NOT NULL
          AND cantidad_bultos IS NOT NULL
          AND cantidad = cantidad_bultos * factor_litros
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_producto
  ON combustible_recepciones(tenant_id, producto, recibido_en)
  WHERE anulada_en IS NULL;

-- ── 5. combustible_alertas / combustible_anomalias: discriminador +
--      3 tipos nuevos ────────────────────────────────────────────────────
-- El resto de los tipos (hueco_detectado, vale_anulado, vale_fuera_de_orden,
-- vale_recargado, tope_diario_excedido...) se REUSAN tal cual para urea --
-- son el mismo evento, solo que ahora puede venir de un vale de urea. Se
-- distingue leyendo `producto`, no inventando "urea_hueco_detectado" y
-- duplicando cada tipo que ya existe.
ALTER TABLE combustible_alertas
  ADD COLUMN IF NOT EXISTS producto VARCHAR(20) NOT NULL DEFAULT 'combustible';

ALTER TABLE combustible_anomalias
  ADD COLUMN IF NOT EXISTS producto VARCHAR(20) NOT NULL DEFAULT 'combustible';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_alertas_producto_check'
  ) THEN
    ALTER TABLE combustible_alertas
      ADD CONSTRAINT combustible_alertas_producto_check
      CHECK (producto IN ('combustible', 'urea'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_anomalias_producto_check'
  ) THEN
    ALTER TABLE combustible_anomalias
      ADD CONSTRAINT combustible_anomalias_producto_check
      CHECK (producto IN ('combustible', 'urea'));
  END IF;
END $$;

-- El índice de auto-resolución de hueco (0068) buscaba por
-- (tenant_id, serie_talonario, n_vale) -- con dos talonarios que pueden
-- compartir nombre entre productos (ver el punto 3), necesita `producto`
-- para no resolver el hueco de un producto con el vale del otro.
DROP INDEX IF EXISTS idx_combustible_alertas_serie_vale;
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_serie_vale
  ON combustible_alertas(tenant_id, producto, serie_talonario, n_vale);

-- Los 3 controles genuinamente NUEVOS que la urea permite y el combustible
-- no (ver el encabezado y docs de diseño):
--   · urea_equipo_no_habilitado: un vale de urea a un equipo marcado con
--     usa_urea=false (respuesta 15 del cliente).
--   · urea_ratio_excedido: litros de urea / litros de diésel de un mismo
--     equipo, por encima del techo configurado -- arranca en NULL.
--   · urea_descuadre_conteo: el conteo físico no cuadra contra el stock
--     teórico (entradas − salidas). Es el reemplazo de la varilla.
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
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo'
  ));

-- OJO -- este CHECK es MÁS ANGOSTO que el de combustible_alertas a propósito
-- (ver TIPOS_ESTADO/TIPOS_CONGELABLES en combustible.repository.ts): los
-- ESTADOS (nivel_bajo, tanque_sin_medir, tanque_sin_vigilancia,
-- recepcion_sin_validar, varilla_sin_control) se resuelven solos y nunca se
-- congelan como anomalía -- congelarlos convertiría un aviso operativo en
-- un hallazgo permanente. Los 3 de urea SÍ entran acá: son hallazgos, no
-- estados.
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
    'urea_equipo_no_habilitado', 'urea_ratio_excedido', 'urea_descuadre_conteo'
  ));

-- ── 6. combustible_config: los umbrales de urea, todos NULL de entrada ──
-- Misma semántica que el resto del módulo desde 0075/0079: NULL = sin
-- configurar = no alerta. No se les inventa un número -- el cliente
-- respondió "un aproximado de 4 bolsas" y "según la distancia recorrida",
-- ninguno de los dos es un umbral operativo real todavía.
ALTER TABLE combustible_config
  -- Litros de urea por equipo en una ventana móvil de 24 h -- mismo motor
  -- que tope_diario_sin_capacidad_l (0079), reutilizado con su propio
  -- techo: la urea no tiene "capacidad de tanque" por equipo de la que
  -- derivar un múltiplo, así que es siempre el valor absoluto.
  ADD COLUMN IF NOT EXISTS tope_diario_urea_l NUMERIC(10, 2),
  -- % de litros de urea sobre litros de diésel del MISMO equipo, en la
  -- misma ventana. Un motor SCR consume urea en proporción más o menos
  -- estable al diésel -- ver docs de diseño. Compara PRODUCTOS DISTINTOS
  -- del mismo equipo, no existe un control análogo en combustible solo.
  ADD COLUMN IF NOT EXISTS ratio_urea_diesel_max_pct NUMERIC(5, 2),
  -- Días tolerados sin un conteo físico de urea -- mismo criterio que
  -- dias_sin_medir (0076), pero éste SÍ tiene default: a diferencia de la
  -- varilla del tanque (que ya era la práctica antes del sistema), el
  -- conteo físico de urea es un control nuevo que el sistema introduce, y
  -- dejarlo en NULL lo dejaría apagado desde el día uno sin que nadie lo
  -- decidiera. 30 días es el punto de partida, ajustable como el resto.
  ADD COLUMN IF NOT EXISTS dias_sin_conteo_urea INT NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_tope_urea_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_tope_urea_check
      CHECK (tope_diario_urea_l IS NULL OR tope_diario_urea_l > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_ratio_urea_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_ratio_urea_check
      CHECK (ratio_urea_diesel_max_pct IS NULL OR ratio_urea_diesel_max_pct BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_dias_conteo_urea_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_dias_conteo_urea_check
      CHECK (dias_sin_conteo_urea BETWEEN 1 AND 365);
  END IF;
END $$;

-- ── 7. combustible_conteos_urea: el reemplazo de la varilla ─────────────
-- Es a la urea lo que combustible_lecturas es al tanque: la medición física
-- independiente contra la que se contrasta el stock TEÓRICO derivado de
-- movimientos (entradas de combustible_recepciones − salidas vigentes de
-- combustible_despachos, ambas con producto='urea'). Append-only, mismo
-- mecanismo de anulación con motivo que el resto del módulo.
CREATE TABLE IF NOT EXISTS combustible_conteos_urea (
  id               BIGSERIAL PRIMARY KEY,
  -- ON DELETE CASCADE, a diferencia de despachos/recepciones/grifos: esta
  -- tabla no tiene ningún FK que dependa de ella (nadie la referencia por
  -- id), así que borrar el tenant puede llevársela sola -- mismo criterio
  -- que combustible_alertas/anomalias/config (0068/0071/0072).
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Convertido a litros por quien carga el conteo (bultos × factor de cada
  -- presentación que cuenta) -- se guarda solo el total en litros, mismo
  -- criterio que nivel_actual del tanque: lo que importa para comparar
  -- contra el stock teórico es el número final, no el desglose físico.
  cantidad_litros  NUMERIC(12, 2) NOT NULL,
  contado_en       TIMESTAMPTZ NOT NULL,
  -- Nullable a propósito: un usuario borrado no debe borrar el historial
  -- -- mismo criterio que combustible_lecturas.usuario_id.
  usuario_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  observaciones    TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Anulación con motivo obligatorio -- mismo patrón que despachos (0067) y
  -- recepciones (0064).
  anulada_en       TIMESTAMPTZ,
  anulada_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_anulacion TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_conteos_urea_cantidad_check'
  ) THEN
    ALTER TABLE combustible_conteos_urea
      ADD CONSTRAINT combustible_conteos_urea_cantidad_check
      CHECK (cantidad_litros >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_conteos_urea_anulacion_check'
  ) THEN
    ALTER TABLE combustible_conteos_urea
      ADD CONSTRAINT combustible_conteos_urea_anulacion_check
      CHECK (
        (anulada_en IS NULL AND anulada_por IS NULL AND motivo_anulacion IS NULL)
        OR (anulada_en IS NOT NULL AND length(trim(motivo_anulacion)) > 0)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_combustible_conteos_urea_tenant
  ON combustible_conteos_urea(tenant_id);

-- El más reciente vigente es el que se compara contra el stock teórico.
CREATE INDEX IF NOT EXISTS idx_combustible_conteos_urea_vigentes
  ON combustible_conteos_urea(tenant_id, contado_en DESC)
  WHERE anulada_en IS NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_conteos_urea_usuario
  ON combustible_conteos_urea(usuario_id) WHERE usuario_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_conteos_urea_anulada_por
  ON combustible_conteos_urea(anulada_por) WHERE anulada_por IS NOT NULL;

ALTER TABLE combustible_conteos_urea ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_conteos_urea FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_conteos_urea'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_conteos_urea
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;


-- ── 8. El ancla de una alerta de conteo de urea ──────────────────────────
-- El CHECK `combustible_alertas_ancla_check` (0073) exige que TODA alerta
-- pueda responder "¿sobre qué es?": un vale (serie+n_vale), un tanque
-- (combustible_id) o una recepción. `urea_descuadre_conteo` no es ninguna
-- de las tres -- es sobre un CONTEO, que hasta acá no existía como ancla.
-- Se agrega la cuarta, igual que 0086 sumó lectura_id.
ALTER TABLE combustible_alertas
  ADD COLUMN IF NOT EXISTS urea_conteo_id BIGINT
    REFERENCES combustible_conteos_urea(id) ON DELETE CASCADE;
ALTER TABLE combustible_anomalias
  ADD COLUMN IF NOT EXISTS urea_conteo_id BIGINT
    REFERENCES combustible_conteos_urea(id) ON DELETE CASCADE;

DO $$
BEGIN
  ALTER TABLE combustible_alertas DROP CONSTRAINT IF EXISTS combustible_alertas_ancla_check;
  ALTER TABLE combustible_alertas
    ADD CONSTRAINT combustible_alertas_ancla_check
    CHECK (
      (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
      OR combustible_id IS NOT NULL
      OR recepcion_id IS NOT NULL
      OR urea_conteo_id IS NOT NULL
    );

  ALTER TABLE combustible_anomalias DROP CONSTRAINT IF EXISTS combustible_anomalias_ancla_check;
  ALTER TABLE combustible_anomalias
    ADD CONSTRAINT combustible_anomalias_ancla_check
    CHECK (
      (serie_talonario IS NOT NULL AND n_vale IS NOT NULL)
      OR combustible_id IS NOT NULL
      OR recepcion_id IS NOT NULL
      OR urea_conteo_id IS NOT NULL
    );
END $$;

CREATE INDEX IF NOT EXISTS idx_combustible_alertas_urea_conteo
  ON combustible_alertas(urea_conteo_id) WHERE urea_conteo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_urea_conteo
  ON combustible_anomalias(urea_conteo_id) WHERE urea_conteo_id IS NOT NULL;
