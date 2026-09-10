-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el conductor, en el equipo Y estampado en el vale
--
-- Kenif, mirando el formulario de Equipos: *"acá debemos dar de alta a cada
-- conductor con su nombre y apellido para tenerlo mapeado la cantidad de
-- combustible que consume"*.
--
-- ── Un dato que el papel SÍ tiene y el sistema perdía ────────────────────
--
-- El vale real del cliente trae la columna CONDUCTOR (ver la planilla de
-- Cushuro: TURNO, UNIDAD, PLACA, CONDUCTOR, H.ABST, OROMETRO, PRODUCTO,
-- GALONES, C.U). El sistema nunca la guardó: se tipeaba en el papel y se
-- perdía al cargar el vale.
--
-- ── Por qué va en los DOS lados ─────────────────────────────────────────
--
-- En el EQUIPO es donde se administra: se da de alta una vez y no hay que
-- tipearlo en cada vale.
--
-- Pero los conductores ROTAN, y el objetivo es saber cuánto consume cada uno.
-- Si el dato viviera solo en el equipo, el día que el VQ-101 pasa de Juan a
-- Pedro, los 8.000 L que Juan cargó en agosto pasarían a figurar como de
-- Pedro. El reporte mentiría, y no habría forma de notarlo.
--
-- Por eso el vale guarda su propia COPIA, tomada en el momento del despacho.
-- Es el mismo criterio que ya usa `combustible_anomalias.ventana_horas`
-- (migración 0072): el hallazgo guarda la ventana que regía CUANDO se
-- congeló, para que siga siendo explicable aunque después alguien la cambie.
-- Un dato histórico no puede depender de una configuración que se edita.
--
-- Nadie tipea esa copia: se toma del equipo al crear el vale.
--
-- ── Por qué texto y no una tabla de conductores ─────────────────────────
--
-- Se propuso una ficha propia (nombre, apellidos, DNI) referenciada desde los
-- dos lados, que además serviría después para el login por DNI. Kenif eligió
-- la versión simple: *"solo agrega los campos de nombre del conductor, dni"*.
--
-- Queda anotado para cuando se encare el acceso de cancha: si el conductor
-- termina teniendo credenciales, va a existir como usuario, y ahí conviene
-- que estos campos apunten a esa persona en vez de repetirla como texto.
-- Migrar de texto a FK después es posible --el DNI es la llave natural-- pero
-- hay que hacerlo antes de que haya miles de vales cargados.
--
-- EJECUTAR (después de 0082):
--   psql -d mincoreerp -f migrations/0083_conductor_en_equipo_y_vale.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE equipos
  -- Nombre completo en un solo campo: es como viene en el vale de papel
  -- ("CONDUCTOR"), y partirlo obligaría a decidir dónde termina el nombre y
  -- empieza el apellido en cada carga.
  ADD COLUMN IF NOT EXISTS conductor_nombre VARCHAR(150),
  ADD COLUMN IF NOT EXISTS conductor_dni    VARCHAR(15);

ALTER TABLE combustible_despachos
  -- La COPIA histórica. No la tipea nadie: se toma del equipo al crear el
  -- vale. Los vales ya cargados quedan en NULL, que es la verdad -- ese dato
  -- nunca se registró y rellenarlo con el conductor de hoy sería inventar
  -- quién manejaba hace tres meses.
  ADD COLUMN IF NOT EXISTS conductor_nombre VARCHAR(150),
  ADD COLUMN IF NOT EXISTS conductor_dni    VARCHAR(15);

-- El reporte que motivó todo: cuánto consume cada conductor. Sin índice, esa
-- consulta escanea la tabla entera de despachos del tenant.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_conductor
  ON combustible_despachos(tenant_id, conductor_dni, despachado_en)
  WHERE conductor_dni IS NOT NULL AND anulada_en IS NULL;
