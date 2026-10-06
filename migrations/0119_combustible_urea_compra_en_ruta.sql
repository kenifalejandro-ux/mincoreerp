-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: la urea también se compra en ruta
--
-- Kenif, 2026-10-05: "también compran urea cuando las unidades van en ruta,
-- osea casi la misma lógica que combustible". Decisiones suyas: formulario
-- aparte, el conductor de ruta la puede registrar, y la boleta/factura con su
-- foto es obligatoria.
--
-- ── El problema de fondo no es la pestaña, es el stock ─────────────────────
--
-- Hasta acá TODO vale de urea bajaba el stock del almacén: el stock teórico
-- es `entradas − vales`, y el conteo físico se compara contra eso. Una
-- compra en ruta NUNCA pasó por el almacén. Si se cargara como un vale más,
-- el stock teórico bajaría por urea que nunca salió del depósito y el
-- primer conteo daría un "sobrante" falso -- y peor, ese sobrante taparía
-- un faltante real del mismo tamaño. El control central de la urea quedaría
-- roto desde la primera compra en ruta.
--
-- Así que hay dos clases de salida de urea, y lo que las separa es si
-- salieron DEL ALMACÉN:
--
--                         almacén (vale)        compra en ruta (boleta)
--   stock / kardex / conteo     sí                     NO
--   tope diario / ratio /       sí                     sí  (es urea que
--   rankings / por tanqueada                                recibió la unidad)
--
-- ── Por qué un origen NUEVO y no "vale vs comprobante" ─────────────────────
--
-- La urea nació (0092) con `origen = 'compra_externa'` aunque saliera del
-- almacén: no había tanque propio y el nombre se heredó. Si la compra en ruta
-- también fuera 'compra_externa', la única forma de distinguirlas sería
-- "tiene vale o tiene comprobante" -- una regla implícita que cada consulta
-- de stock tendría que recordar. La primera que se olvide mezcla las dos
-- cosas en silencio, que es exactamente el bug de los rankings de #174.
--
-- Con un origen explícito el significado queda en la fila:
--
--   'almacen'        -- reparto desde el depósito de la empresa. Talonario
--                       propio, baja el stock. Es el análogo de tanque_propio.
--   'compra_externa' -- compra a un proveedor en ruta. Boleta o factura, NO
--                       toca el stock. Mismo significado que en combustible.
--
-- Las filas de urea que ya existen son TODAS repartos del almacén (era lo
-- único que se podía cargar), así que pasan a 'almacen'. No es inventar un
-- dato: es corregir una etiqueta que siempre significó eso. La cola offline
-- puede traer vales viejos con 'compra_externa' + vale; el schema los
-- normaliza a 'almacen' al entrar (ver crearDespachoCombustibleSchema).
--
-- ── La misma boleta puede traer diésel Y urea ──────────────────────────────
--
-- El índice único del comprobante (0109) es (tenant, proveedor, tipo,
-- número). Sin el producto, la urea comprada en el mismo PRIMAX y en la misma
-- factura que el diésel rebotaría como "boleta duplicada" -- y es el caso
-- más común de todos: la unidad para, carga diésel y compra urea en un solo
-- ticket. Se suma `producto` a la clave. Cargar dos veces la urea de una
-- misma boleta sigue siendo imposible.
--
-- Aplicar: `npm run migrate`.
-- ═══════════════════════════════════════════════════════════════════════════

-- La ventana NO FORCE: el UPDATE de las filas existentes corre sin
-- `app.tenant_id` de sesión (gotcha de 0097/0116), y con FORCE no vería nada
-- -- el UPDATE "funcionaría" afectando cero filas, y el CHECK nuevo de abajo
-- fallaría contra las filas viejas que quedaron sin migrar.
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;

-- ── 1. El origen nuevo ─────────────────────────────────────────────────────
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_origen_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_origen_check
  CHECK (origen IN ('tanque_propio', 'compra_externa', 'excedente_recepcion', 'tanqueta', 'almacen'));

-- ── 2. Las filas de urea existentes son repartos del almacén ──────────────
-- La forma de urea de 0109 exige 'compra_externa': se suelta ANTES del UPDATE
-- y se vuelve a crear después, con las dos formas.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_forma_urea_check;

UPDATE combustible_despachos
   SET origen = 'almacen'
 WHERE producto = 'urea'
   AND origen = 'compra_externa'
   AND comprobante_numero IS NULL;

-- ── 3. La forma de la urea, con sus dos orígenes ──────────────────────────
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_forma_urea_check
  CHECK (
    producto <> 'urea' OR (
      -- Lo común a las dos: siempre a una unidad, siempre de un proveedor de
      -- urea, siempre en bultos con su factor congelado, nunca nada de
      -- combustible.
      tipo_destino = 'equipo'
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
      AND (
        -- Reparto del almacén: el talonario propio, sin comprobante.
        (origen = 'almacen'
          AND serie_talonario IS NOT NULL
          AND n_vale IS NOT NULL
          AND comprobante_tipo IS NULL
          AND comprobante_numero IS NULL
          AND comprobante_key IS NULL)
        OR
        -- Compra en ruta: el comprobante del proveedor, sin vale. La foto
        -- (comprobante_key) NO se exige acá: llega en una segunda petición,
        -- y la cola offline puede traerla minutos después que la compra. La
        -- obligatoriedad la impone el formulario; acá solo la coherencia.
        (origen = 'compra_externa'
          AND comprobante_tipo IS NOT NULL
          AND comprobante_numero IS NOT NULL
          AND serie_talonario IS NULL
          AND n_vale IS NULL)
      )
    )
  );

-- 'almacen' es solo de la urea: el combustible tiene tanque_propio.
ALTER TABLE combustible_despachos DROP CONSTRAINT IF EXISTS combustible_despachos_almacen_solo_urea_check;
ALTER TABLE combustible_despachos
  ADD CONSTRAINT combustible_despachos_almacen_solo_urea_check
  CHECK (origen <> 'almacen' OR producto = 'urea');

ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;

-- ── 4. La misma boleta, un renglón por producto ───────────────────────────
DROP INDEX IF EXISTS idx_combustible_despachos_comprobante_vigente;
CREATE UNIQUE INDEX idx_combustible_despachos_comprobante_vigente
  ON combustible_despachos(
    tenant_id, producto, grifo_id, comprobante_tipo,
    combustible_comprobante_canonico(comprobante_numero)
  )
  WHERE comprobante_numero IS NOT NULL AND anulada_en IS NULL;

-- ── 5. El stock de urea mira solo el almacén ──────────────────────────────
-- findStockTeoricoUrea corre en cada vale, cada entrada y cada conteo.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_urea_almacen
  ON combustible_despachos (tenant_id, despachado_en)
  WHERE producto = 'urea' AND origen = 'almacen' AND anulada_en IS NULL;
