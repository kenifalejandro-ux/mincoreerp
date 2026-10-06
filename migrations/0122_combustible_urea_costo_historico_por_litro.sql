-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el costo histórico de urea pasa de "por bulto" a "por litro"
--
-- ── El bug ─────────────────────────────────────────────────────────────────
--
-- El cliente cotiza la urea POR CAJA (respuesta 11 del cuestionario de Santa
-- Isabel: "por caja"), y el formulario pedía ese número tal cual. Pero
-- `costo_unitario` significa precio POR LITRO en todo el módulo: la
-- valorización es `cantidad * costo_unitario` y `cantidad` está en litros
-- (ver `(cantidad * costo_unitario) AS costo_total` en findDespachos y
-- findRecepciones, y los tres rankings que suman `d.cantidad * d.costo_unitario`).
--
-- El código viejo guardaba el número tipeado sin convertirlo, así que una caja
-- de 16 L a S/ 80 quedaba valorizada en 16 * 80 = S/ 1.280 en vez de S/ 80:
-- inflada por el factor de la presentación (×4 la bolsa, ×16 la caja, ×20 el
-- balde).
--
-- El código ya quedó arreglado -- `costoPorLitroUrea` en combustible.service.ts,
-- aplicado al vale del almacén y a la entrada. Esta migración arregla las filas
-- que se cargaron ANTES de ese arreglo.
--
-- ── Por qué dividir por `factor_litros` de la propia fila ──────────────────
--
-- La regla del módulo es que la conversión se GUARDA en cada movimiento y no
-- se recalcula (0092). Esa decisión es justamente la que hace reparable este
-- bug: cada fila lleva el factor con el que se cargó, así que el valor por
-- litro se recupera sin suponer nada sobre la presentación de hoy. Si el
-- factor se hubiera leído de una tabla de configuración, un cambio de envase
-- posterior habría vuelto la corrección imposible.
--
-- ── Cómo se distingue una fila vieja de una ya correcta ────────────────────
--
-- Por la FORMA no se puede: una fila que escribió el código viejo y una que
-- escribió el nuevo son idénticas columna por columna, solo difiere la escala
-- del número. Hace falta un corte en el tiempo.
--
-- El corte es `applied_at` de 0119 en `schema_migrations`. El arreglo de
-- `costoPorLitroUrea` viaja en la MISMA rama que 0119, y el runner aplica las
-- migraciones en el arranque, antes de atender tráfico (bootstrap.ts): el
-- momento en que esta base aplicó 0119 es el momento en que empezó a correr
-- el código arreglado. Entonces:
--
--   creado_en <  applied_at(0119)  -> la escribió el código viejo -> corregir
--   creado_en >= applied_at(0119)  -> ya nació en litros          -> no tocar
--
-- En producción 0119 y 0122 se aplican en el mismo deploy, segundos aparte y
-- sin tráfico en el medio, así que toda fila preexistente cae del lado viejo
-- y se corrige. En una base de desarrollo donde el código nuevo ya venía
-- usándose desde 0119, las filas nuevas quedan intactas. En CI la base arranca
-- vacía y las filas que crean los tests nacen después del corte.
--
-- Se usa `creado_en` (cuándo entró la fila), NO `despachado_en`/`recibido_en`,
-- que son la fecha del HECHO y pueden venir atrasadas de la cola offline o de
-- una carga histórica.
--
-- El runner además registra cada archivo en `schema_migrations` (PK por
-- filename) bajo advisory lock, así que el archivo corre una sola vez por base.
--
-- ── Alcance: las dos tablas, y por qué también las derivadas ───────────────
--
-- `combustible_recepciones`: el costo lo tipea quien carga la entrada, por
-- bulto. Afectadas todas.
--
-- `combustible_despachos`: el vale del almacén toma `costo_unitario` tipeado,
-- o si no viene lo deriva con `resolverCostoUrea`, que promedia las
-- recepciones vigentes. Como esas recepciones estaban ELLAS MISMAS en por
-- bulto, el valor derivado quedó igual de inflado. Por eso se corrigen todas
-- las filas, no solo las de costo tipeado.
--
-- Límite honesto: para un vale cuyo costo salió del promedio, dividir por el
-- factor de SU presentación es el inverso exacto solo si las recepciones
-- promediadas tenían la misma presentación. Con presentaciones mezcladas queda
-- una aproximación -- la mejor disponible, y del orden de magnitud correcto
-- frente al ×16 que corrige. Kenif confirmó (2026-10-05) que no hay urea real
-- cargada en producción, así que en prod esto corre sobre cero filas y el caso
-- mezclado es teórico; la migración existe para dejar coherente cualquier base
-- (dev, test, el tenant de la simulación de Santa Isabel).
--
-- No hay nada más que recalcular: la urea no pondera costo promedio (eso es un
-- concepto del TANQUE, Fase C -- la urea no se mezcla físicamente), y
-- `costo_total` se calcula al vuelo en el SELECT, no está guardado.
--
-- Los renglones de 0120 (`combustible_despacho_urea_lineas.costo_por_bulto`)
-- NO se tocan: esa columna SÍ significa por bulto, y su backfill salió de
-- filas que escribió el código nuevo.
--
-- ── La ventana NO FORCE ────────────────────────────────────────────────────
--
-- Sin `app.tenant_id` de sesión y con FORCE puesto, el UPDATE no vería ninguna
-- fila: "funcionaría" afectando cero filas y la corrección se perdería en
-- silencio. Mismo gotcha que 0097/0116/0119/0120.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_despachos   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  corte         TIMESTAMPTZ;
  n_despachos   INTEGER;
  n_recepciones INTEGER;
BEGIN
  SELECT applied_at INTO corte
    FROM schema_migrations
   WHERE filename = '0119_combustible_urea_compra_en_ruta.sql';

  IF corte IS NULL THEN
    -- No debería pasar: el runner aplica en orden y 0119 va antes que este
    -- archivo. Si falta, no hay forma de saber qué filas son viejas, y dividir
    -- a ciegas arruina las que ya están bien. Se prefiere no tocar nada.
    RAISE NOTICE 'Urea: sin applied_at de 0119, no se corrige ningún costo historico';
    RETURN;
  END IF;

  -- `factor_litros IS NOT NULL` no es un guardia de más: es la forma que deja
  -- el reparto desde almacén (presentación en la propia fila). Una compra en
  -- ruta de 0120 tiene el factor en NULL -- su detalle vive en
  -- combustible_despacho_urea_lineas -- y queda afuera sola, que es lo correcto
  -- porque su costo lo calculó el código nuevo. `> 0` cubre la división.
  UPDATE combustible_despachos
     SET costo_unitario = ROUND(costo_unitario / factor_litros, 4)
   WHERE producto = 'urea'
     AND costo_unitario IS NOT NULL
     AND factor_litros IS NOT NULL
     AND factor_litros > 0
     AND creado_en < corte;
  GET DIAGNOSTICS n_despachos = ROW_COUNT;

  UPDATE combustible_recepciones
     SET costo_unitario = ROUND(costo_unitario / factor_litros, 4)
   WHERE producto = 'urea'
     AND costo_unitario IS NOT NULL
     AND factor_litros IS NOT NULL
     AND factor_litros > 0
     AND creado_en < corte;
  GET DIAGNOSTICS n_recepciones = ROW_COUNT;

  -- Queda en el log del deploy: en producción se espera 0 y 0.
  RAISE NOTICE 'Urea, costo por bulto -> por litro (corte %): % despacho(s), % recepcion(es)',
    corte, n_despachos, n_recepciones;
END $$;

ALTER TABLE combustible_despachos   FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones FORCE ROW LEVEL SECURITY;
