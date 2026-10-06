-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: las presentaciones de urea dejan de ser una constante del código
--
-- Ver docs/architecture/urea-industrial.md (decisión 3). Primera de las cuatro
-- entregas del panel de urea.
--
-- ── El problema ─────────────────────────────────────────────────────────────
--
-- Desde 0092 los litros por bulto viven en una constante de TypeScript
-- (`FACTOR_LITROS_UREA` en combustible.schema.ts: bolsa 4, caja 16, balde 20)
-- y la columna `presentacion` tiene un CHECK con esos tres valores fijos.
--
-- Eso aguantó veinte días. El cliente ahora dice que la caja es de 20 L, no de
-- 16, y ya mencionó un "galón" sin dato. Con el modelo de hoy, cada envase
-- nuevo o corregido es una migración, un deploy y una ventana de espera --
-- para un dato que la empresa conoce mejor que nosotros y que puede cambiar
-- cuando cambie de proveedor.
--
-- ── Por qué una tabla y no tres columnas en combustible_config ──────────────
--
-- Tres columnas (factor_bolsa_l, factor_caja_l, factor_balde_l) resolvían el
-- caso de HOY con menos trabajo. Se descartó por una razón concreta: no
-- admiten un envase que no esté previsto. La primera vez que el cliente compre
-- en bidón de 10 L o en IBC, habría que migrar otra vez. Con tabla, lo da de
-- alta él y sigue trabajando.
--
-- ── Lo que esta migración NO hace: cambiar el 16 por 20 ─────────────────────
--
-- Se siembran los valores VIGENTES (16 para la caja), no los nuevos. Corregir
-- el número es una decisión del cliente desde la pantalla, con su motivo y su
-- registro en bitácora -- no un efecto colateral de un deploy. Si la migración
-- lo cambiara sola, todos los vales cargados el día del despliegue saldrían con
-- otra cantidad de litros sin que nadie lo hubiera decidido, y el responsable
-- del cambio no quedaría registrado en ningún lado.
--
-- ── El histórico no se mueve, y eso ya estaba resuelto ──────────────────────
--
-- `combustible_despachos.factor_litros` y `combustible_recepciones.factor_litros`
-- existen desde 0092 justamente para esto: cada fila guarda el factor que
-- estaba vigente cuando se creó. Cambiar la tabla afecta a los movimientos
-- NUEVOS y a ninguno viejo. Es el mismo principio que bloquea el cambio de
-- unidad de un tanque con historial (validarCambioDeUnidad): una conversión
-- que se recalcula reinterpreta el pasado, y un módulo anti-fraude no reescribe
-- el pasado.
--
-- ── Por qué la FK es COMPUESTA y por qué hay una ventana NO FORCE ───────────
--
-- `FOREIGN KEY (tenant_id, presentacion) REFERENCES ... (tenant_id, codigo)`,
-- no una FK simple contra el código: la verificación de una FK NO pasa por RLS,
-- así que una clave que no lleve el tenant adentro dejaría que una empresa
-- referenciara la presentación de otra. Mismo criterio y mismo patrón que las
-- FK compuestas de 0097 (sedes/grifos internos).
--
-- Y por el mismo motivo hace falta apagar FORCE mientras se crean: al agregar
-- la clave, Postgres valida las filas que ya existen con una consulta que SÍ
-- pasa por RLS, y sin `app.tenant_id` de sesión esa consulta no ve nada y
-- falla. Se apaga y se vuelve a prender dentro de la misma transacción que
-- migrate.ts abre para todo el archivo.
--
-- ── Las filas de combustible no se ven afectadas ────────────────────────────
--
-- `presentacion` es NULL en todo despacho/recepción de combustible. Una FK
-- MATCH SIMPLE (el default) se satisface automáticamente cuando alguna de sus
-- columnas es NULL, así que esas filas no se verifican contra nada. La FK solo
-- aplica a las de urea, que es exactamente lo que se busca.
--
-- EJECUTAR (después de 0115):
--   psql -d mincoreerp -f migrations/0116_combustible_urea_presentaciones.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. El catálogo de presentaciones, por empresa ───────────────────────────
CREATE TABLE IF NOT EXISTS combustible_urea_presentaciones (
  id            SERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- El valor que se guarda en `combustible_despachos.presentacion` y en
  -- `combustible_recepciones.presentacion`. Es la clave real del catálogo: el
  -- movimiento guarda el código, no el id, porque así las filas de 0092 (que
  -- ya dicen 'bolsa'/'caja'/'balde') siguen siendo válidas sin tocarlas.
  codigo        VARCHAR(20) NOT NULL,

  -- Lo que se ve en el desplegable. SIN los litros adentro: la pantalla arma
  -- "Caja (20 L)" juntando nombre + litros. Si el nombre los llevara escritos,
  -- cambiar el factor dejaría la etiqueta mintiendo hasta que alguien se
  -- acuerde de editarla también.
  nombre        VARCHAR(60) NOT NULL,

  litros        NUMERIC(8, 2) NOT NULL,

  -- En qué unidad se expresa el stock en pantalla ("≈ 18 cajas"). Una sola por
  -- empresa, garantizado por el índice único parcial de más abajo.
  es_referencia BOOLEAN NOT NULL DEFAULT false,

  -- Baja LÓGICA, nunca DELETE: una presentación que ya se usó en un vale no se
  -- puede borrar (la FK lo impediría igual), y desactivarla es lo que
  -- corresponde -- mismo criterio que `activo` en tanques y grifos. Desactivada
  -- = no aparece en los desplegables, pero el historial que la usó sigue
  -- siendo legible.
  activa        BOOLEAN NOT NULL DEFAULT true,

  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Nullable a propósito: un usuario borrado no debe borrar el catálogo --
  -- mismo criterio que combustible_grifos.usuario_id.
  actualizado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_urea_presentaciones_litros_check'
  ) THEN
    ALTER TABLE combustible_urea_presentaciones
      ADD CONSTRAINT combustible_urea_presentaciones_litros_check
      -- Techo de 2.000 L: un IBC industrial son 1.000 L, así que el doble cubre
      -- cualquier envase real con margen. Sin techo, un dedo de más al tipear
      -- (200 en vez de 20) multiplica por diez todo el stock declarado.
      CHECK (litros > 0 AND litros <= 2000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_urea_presentaciones_codigo_check'
  ) THEN
    ALTER TABLE combustible_urea_presentaciones
      ADD CONSTRAINT combustible_urea_presentaciones_codigo_check
      -- Minúsculas, sin espacios: el código viaja en el body de la API y en el
      -- CHECK viejo ya era así. Que sea estable importa porque es lo que queda
      -- escrito en cada movimiento.
      CHECK (codigo ~ '^[a-z0-9_]{2,20}$');
  END IF;
END $$;

-- La clave que usa la FK compuesta de más abajo. Va como UNIQUE y no como PK
-- para no cambiarle la PK serial a la tabla (el backup/restore de tenant asume
-- que toda tabla de módulo tiene su propia columna `id`, ver ADR-0002 §2).
CREATE UNIQUE INDEX IF NOT EXISTS idx_urea_presentaciones_tenant_codigo
  ON combustible_urea_presentaciones(tenant_id, codigo);

-- UNA sola presentación de referencia por empresa. Un índice único parcial es
-- la única forma de expresar "único entre las que cumplen X" en Postgres --
-- mismo recurso que el índice de vales vigentes de 0067.
CREATE UNIQUE INDEX IF NOT EXISTS idx_urea_presentaciones_referencia
  ON combustible_urea_presentaciones(tenant_id)
  WHERE es_referencia;

CREATE INDEX IF NOT EXISTS idx_urea_presentaciones_tenant
  ON combustible_urea_presentaciones(tenant_id);

CREATE INDEX IF NOT EXISTS idx_urea_presentaciones_actualizado_por
  ON combustible_urea_presentaciones(actualizado_por) WHERE actualizado_por IS NOT NULL;

ALTER TABLE combustible_urea_presentaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_presentaciones FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_urea_presentaciones'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_urea_presentaciones
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── 2. Seed: las tres de hoy, para TODAS las empresas ───────────────────────
-- Toca filas de todos los tenants a la vez, así que no hay un único
-- `app.tenant_id` de sesión que fijar -- se apaga FORCE para el dueño durante
-- el seed, mismo escenario que el backfill de 0057/0097.
--
-- Se siembra para TODA empresa, tenga o no movimientos de urea: así el panel
-- tiene opciones desde el primer día y nadie empieza con un desplegable vacío.
--
-- La ventana NO FORCE incluye a las DOS TABLAS DE MOVIMIENTOS, no solo al
-- catálogo nuevo: el seed de red de seguridad de más abajo las LEE, y una
-- lectura con FORCE puesto y sin `app.tenant_id` de sesión no devuelve cero
-- filas -- revienta con "unrecognized configuration parameter", porque la
-- policy llama a current_setting() sin missing_ok. La ventana se cierra recién
-- después de crear las claves foráneas, que necesitan lo mismo por el mismo
-- motivo.
ALTER TABLE combustible_urea_presentaciones NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones NO FORCE ROW LEVEL SECURITY;

INSERT INTO combustible_urea_presentaciones (tenant_id, codigo, nombre, litros, es_referencia)
SELECT t.id, p.codigo, p.nombre, p.litros, p.es_referencia
FROM tenants t
CROSS JOIN (VALUES
  ('bolsa', 'Bolsa',  4.00, false),
  -- 16 L es el valor VIGENTE, no el que el cliente dijo después. Ver el
  -- encabezado: corregirlo es una decisión suya desde la pantalla.
  ('caja',  'Caja',  16.00, true),
  ('balde', 'Balde', 20.00, false)
) AS p(codigo, nombre, litros, es_referencia)
ON CONFLICT (tenant_id, codigo) DO NOTHING;

-- Red de seguridad: si alguna empresa tiene movimientos de urea con una
-- presentación que no quedó sembrada (imposible hoy -- el CHECK de 0092 solo
-- permitía esas tres -- pero la FK de abajo fallaría en silencio para toda la
-- migración), se crea su fila antes de crear la clave. Mejor una presentación
-- de más que una migración que no entra en producción.
INSERT INTO combustible_urea_presentaciones (tenant_id, codigo, nombre, litros)
SELECT DISTINCT d.tenant_id, d.presentacion, initcap(d.presentacion),
       COALESCE(d.factor_litros, 1)
FROM combustible_despachos d
WHERE d.producto = 'urea' AND d.presentacion IS NOT NULL
ON CONFLICT (tenant_id, codigo) DO NOTHING;

INSERT INTO combustible_urea_presentaciones (tenant_id, codigo, nombre, litros)
SELECT DISTINCT r.tenant_id, r.presentacion, initcap(r.presentacion),
       COALESCE(r.factor_litros, 1)
FROM combustible_recepciones r
WHERE r.producto = 'urea' AND r.presentacion IS NOT NULL
ON CONFLICT (tenant_id, codigo) DO NOTHING;

-- ── 3. El CHECK fijo da paso a la FK compuesta ──────────────────────────────
-- Postgres no deja extender un CHECK: se suelta y se reemplaza por la clave.
-- Sigue dentro de la ventana NO FORCE abierta arriba: al agregar la clave,
-- Postgres valida las filas que ya existen con una consulta que pasa por RLS.
ALTER TABLE combustible_despachos
  DROP CONSTRAINT IF EXISTS combustible_despachos_presentacion_check;
ALTER TABLE combustible_recepciones
  DROP CONSTRAINT IF EXISTS combustible_recepciones_presentacion_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_presentacion_fkey'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_presentacion_fkey
      FOREIGN KEY (tenant_id, presentacion)
      REFERENCES combustible_urea_presentaciones (tenant_id, codigo);
      -- Sin ON DELETE: una presentación usada en un vale no se puede borrar.
      -- Para eso está `activa` (baja lógica), igual que en tanques y grifos.
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_presentacion_fkey'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_presentacion_fkey
      FOREIGN KEY (tenant_id, presentacion)
      REFERENCES combustible_urea_presentaciones (tenant_id, codigo);
  END IF;
END $$;

ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_urea_presentaciones FORCE ROW LEVEL SECURITY;

-- Cobertura de índice para las dos FK nuevas: sin índice, validar un borrado
-- en el catálogo obliga a escanear las dos tablas de movimientos enteras (ver
-- docs/architecture/database-performance-guidelines.md; tests/db-index-coverage
-- lo exige en CI). Parciales porque `presentacion` es NULL en todo lo que no
-- es urea, que es la enorme mayoría de las filas.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_presentacion
  ON combustible_despachos(tenant_id, presentacion) WHERE presentacion IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_presentacion
  ON combustible_recepciones(tenant_id, presentacion) WHERE presentacion IS NOT NULL;
