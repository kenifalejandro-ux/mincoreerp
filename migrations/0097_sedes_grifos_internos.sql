-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: SEDES y GRIFOS INTERNOS (entrega 1 de
-- docs/architecture/combustible-sedes-grifos-surtidores.md)
--
-- Hasta acá un tanque ERA el punto de abastecimiento completo, y nada agrupaba
-- los tanques de una planta. Esta migración agrega los dos niveles de arriba:
--
--   Empresa → Sede → Grifo interno → Tanques y equipos
--
-- Tres ideas sostienen todo lo que sigue:
--
-- 1. CADA HECHO GUARDA DÓNDE OCURRIÓ. Un vale, una varilla, una recepción, un
--    precinto y una alerta COPIAN su grifo al registrarse, y esa copia no se
--    recalcula nunca -- mismo criterio que el conductor del vale (0083). Mover
--    un tanque o un equipo no reescribe el pasado.
--
-- 2. MOVER DEJA RASTRO SIEMPRE. `movimientos_grifo` guarda cada cambio de
--    grifo, y un trigger lo escribe: la base RECHAZA cambiar el grifo de un
--    tanque o un equipo sin motivo, venga de la API, de un script o de un
--    UPDATE a mano. El grifo de algo en un instante T es el ORIGEN del primer
--    movimiento posterior a T; si no hubo ninguno, el grifo actual.
--
-- 3. CERO FRICCIÓN PARA EL CASO SIMPLE. Una empresa con un solo grifo no ve
--    nada nuevo: un trigger asigna ese grifo a todo tanque y equipo que llegue
--    sin él. Si la empresa no tiene NINGUNO (restaurar un backup anterior a
--    esta migración, la prueba de backup), lo crea en ese momento.
--
-- Todas las referencias a una sede o a un grifo son claves foráneas
-- COMPUESTAS (tenant_id, id): en Postgres la verificación de una clave
-- foránea no pasa por RLS, así que una clave simple dejaría a un tanque de la
-- empresa A apuntar a un grifo de la empresa B.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Sedes ─────────────────────────────────────────────────────────────
-- De la EMPRESA, no de Combustible: los otros módulos podrán colgarse de acá.
CREATE TABLE IF NOT EXISTS sedes (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre       VARCHAR(80) NOT NULL CHECK (length(trim(nombre)) > 0),
  activo       BOOLEAN NOT NULL DEFAULT true,
  -- El motivo de la ÚLTIMA baja. La historia completa está en la bitácora.
  motivo_baja  TEXT,
  creado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sedes_nombre
  ON sedes (tenant_id, lower(trim(nombre)));
CREATE INDEX IF NOT EXISTS idx_sedes_creado_por
  ON sedes (creado_por) WHERE creado_por IS NOT NULL;

-- ── 2. Grifos internos ──────────────────────────────────────────────────
-- Los puntos PROPIOS de abastecimiento. No confundir con `combustible_grifos`,
-- que son los proveedores externos (PRIMAX, Velásquez) y que en pantalla
-- pasan a llamarse "Proveedores".
--
-- La sede de un grifo NO se cambia: la sede de un hecho se deduce del grifo
-- que copió, así que moverlo de sede reescribiría la sede de todo su pasado.
-- Para reorganizar se crea un grifo nuevo y se mueven tanques y equipos.
CREATE TABLE IF NOT EXISTS grifos_internos (
  id           SERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sede_id      INTEGER NOT NULL,
  nombre       VARCHAR(80) NOT NULL CHECK (length(trim(nombre)) > 0),
  activo       BOOLEAN NOT NULL DEFAULT true,
  motivo_baja  TEXT,
  creado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, sede_id) REFERENCES sedes (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_grifos_internos_nombre
  ON grifos_internos (tenant_id, sede_id, lower(trim(nombre)));
CREATE INDEX IF NOT EXISTS idx_grifos_internos_sede
  ON grifos_internos (tenant_id, sede_id);
CREATE INDEX IF NOT EXISTS idx_grifos_internos_creado_por
  ON grifos_internos (creado_por) WHERE creado_por IS NOT NULL;

-- ── 3. La pertenencia de tanques y equipos ─────────────────────────────
ALTER TABLE combustible ADD COLUMN IF NOT EXISTS grifo_interno_id INTEGER;
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS grifo_interno_id INTEGER;

-- ── 4. Los movimientos ──────────────────────────────────────────────────
-- Una fila SOLO por movimiento (no por alta): el alta ya está en la ficha, y
-- una fila de "alta" escrita por trigger se duplicaría al restaurar un backup.
-- Claves foráneas reales a cada entidad, y no un `entidad_id` genérico: el
-- clonado de backups remapea ids columna por tabla, y uno genérico quedaría
-- apuntando a la empresa de origen.
--
-- CASCADE desde el tanque y el equipo: en la app nunca se borran (baja
-- lógica); el borrado real solo ocurre al vaciar una empresa entera.
CREATE TABLE IF NOT EXISTS movimientos_grifo (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  combustible_id    INTEGER REFERENCES combustible(id) ON DELETE CASCADE,
  equipo_id         INTEGER REFERENCES equipos(id) ON DELETE CASCADE,
  -- NULL solo para un equipo que no tenía grifo (empresa con varios grifos
  -- que lo dio de alta sin asignarlo).
  grifo_origen_id   INTEGER,
  grifo_destino_id  INTEGER NOT NULL,
  movido_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo            TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  usuario_id        UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  CHECK ((combustible_id IS NULL) <> (equipo_id IS NULL)),
  FOREIGN KEY (tenant_id, grifo_origen_id) REFERENCES grifos_internos (tenant_id, id),
  FOREIGN KEY (tenant_id, grifo_destino_id) REFERENCES grifos_internos (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_movimientos_grifo_tanque
  ON movimientos_grifo (combustible_id, movido_en) WHERE combustible_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movimientos_grifo_equipo
  ON movimientos_grifo (equipo_id, movido_en) WHERE equipo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movimientos_grifo_tenant
  ON movimientos_grifo (tenant_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_grifo_usuario
  ON movimientos_grifo (usuario_id) WHERE usuario_id IS NOT NULL;

-- ── 5. La copia en cada hecho ───────────────────────────────────────────
-- Nullable: una compra externa a un equipo sin grifo, una alerta de urea (la
-- urea es por empresa) o un hueco de talonario no tienen grifo.
ALTER TABLE combustible_despachos
  ADD COLUMN IF NOT EXISTS grifo_interno_id INTEGER,
  -- El grifo DEL EQUIPO al cargar. Con el anterior, es lo que dispara la
  -- alerta de equipo de otro grifo (entrega 4).
  ADD COLUMN IF NOT EXISTS equipo_grifo_interno_id INTEGER;
ALTER TABLE combustible_lecturas ADD COLUMN IF NOT EXISTS grifo_interno_id INTEGER;
ALTER TABLE combustible_recepciones ADD COLUMN IF NOT EXISTS grifo_interno_id INTEGER;
ALTER TABLE combustible_precintos ADD COLUMN IF NOT EXISTS grifo_interno_id INTEGER;
ALTER TABLE combustible_alertas ADD COLUMN IF NOT EXISTS grifo_interno_id INTEGER;
ALTER TABLE combustible_anomalias ADD COLUMN IF NOT EXISTS grifo_interno_id INTEGER;

-- ── 6. Backfill: todo a "Principal" ─────────────────────────────────────
-- Hoy cada empresa tiene un solo punto, así que no hay ninguna ambigüedad.
-- Toca filas de TODAS las empresas a la vez: se apaga FORCE RLS para el dueño
-- solo durante el backfill y se vuelve a prender antes de terminar, en la
-- misma transacción -- mismo mecanismo que 0057.
ALTER TABLE combustible NO FORCE ROW LEVEL SECURITY;
ALTER TABLE equipos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lecturas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_precintos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_precinto_puntos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_alertas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_anomalias NO FORCE ROW LEVEL SECURITY;
-- Las dos nuevas todavía no tienen RLS en una base limpia; en una que ya
-- corrió esta migración sí. Así el archivo aguanta correr dos veces.
ALTER TABLE sedes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE grifos_internos NO FORCE ROW LEVEL SECURITY;

-- Las claves foráneas compuestas, una por columna. Van ACÁ, con FORCE apagado:
-- al agregar una clave, Postgres verifica las filas que ya existen con una
-- consulta que sí pasa por RLS, y sin `app.tenant_id` de sesión falla.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('combustible', 'grifo_interno_id'),
      ('equipos', 'grifo_interno_id'),
      ('combustible_despachos', 'grifo_interno_id'),
      ('combustible_despachos', 'equipo_grifo_interno_id'),
      ('combustible_lecturas', 'grifo_interno_id'),
      ('combustible_recepciones', 'grifo_interno_id'),
      ('combustible_precintos', 'grifo_interno_id'),
      ('combustible_alertas', 'grifo_interno_id'),
      ('combustible_anomalias', 'grifo_interno_id')
    ) AS t(tabla, columna)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = r.tabla || '_' || r.columna || '_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I)
           REFERENCES grifos_internos (tenant_id, id)',
        r.tabla, r.tabla || '_' || r.columna || '_fk', r.columna
      );
    END IF;
  END LOOP;
END $$;


INSERT INTO sedes (tenant_id, nombre)
SELECT t.id, 'Principal' FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM sedes s WHERE s.tenant_id = t.id);

INSERT INTO grifos_internos (tenant_id, sede_id, nombre)
SELECT s.tenant_id, s.id, 'Principal' FROM sedes s
WHERE NOT EXISTS (SELECT 1 FROM grifos_internos g WHERE g.tenant_id = s.tenant_id);

-- El único grifo de cada empresa (recién creado arriba).
CREATE TEMP TABLE _principal ON COMMIT DROP AS
SELECT DISTINCT ON (tenant_id) tenant_id, id AS grifo_id
FROM grifos_internos ORDER BY tenant_id, id;

UPDATE combustible c SET grifo_interno_id = p.grifo_id
  FROM _principal p WHERE p.tenant_id = c.tenant_id AND c.grifo_interno_id IS NULL;
UPDATE equipos e SET grifo_interno_id = p.grifo_id
  FROM _principal p WHERE p.tenant_id = e.tenant_id AND e.grifo_interno_id IS NULL;

UPDATE combustible_despachos d SET
    grifo_interno_id = CASE
      WHEN d.combustible_id IS NOT NULL OR d.equipo_id IS NOT NULL THEN p.grifo_id
    END,
    equipo_grifo_interno_id = CASE WHEN d.equipo_id IS NOT NULL THEN p.grifo_id END
  FROM _principal p
  WHERE p.tenant_id = d.tenant_id AND d.grifo_interno_id IS NULL;
UPDATE combustible_lecturas l SET grifo_interno_id = p.grifo_id
  FROM _principal p WHERE p.tenant_id = l.tenant_id AND l.grifo_interno_id IS NULL;
UPDATE combustible_recepciones r SET grifo_interno_id = p.grifo_id
  FROM _principal p
  WHERE p.tenant_id = r.tenant_id AND r.combustible_id IS NOT NULL AND r.grifo_interno_id IS NULL;
UPDATE combustible_precintos x SET grifo_interno_id = p.grifo_id
  FROM _principal p WHERE p.tenant_id = x.tenant_id AND x.grifo_interno_id IS NULL;
-- Las alertas y anomalías de urea quedan sin grifo: la urea es por empresa.
-- Las de un hueco de talonario (solo serie y número) también: no hay de dónde
-- sacarlo.
UPDATE combustible_alertas a SET grifo_interno_id = p.grifo_id
  FROM _principal p
  WHERE p.tenant_id = a.tenant_id AND a.grifo_interno_id IS NULL
    AND COALESCE(a.producto, 'combustible') <> 'urea'
    AND (a.despacho_id IS NOT NULL OR a.lectura_id IS NOT NULL
         OR a.recepcion_id IS NOT NULL OR a.combustible_id IS NOT NULL);
UPDATE combustible_anomalias a SET grifo_interno_id = p.grifo_id
  FROM _principal p
  WHERE p.tenant_id = a.tenant_id AND a.grifo_interno_id IS NULL
    AND COALESCE(a.producto, 'combustible') <> 'urea'
    AND (a.despacho_id IS NOT NULL OR a.lectura_id IS NOT NULL
         OR a.recepcion_id IS NOT NULL OR a.combustible_id IS NOT NULL);

ALTER TABLE combustible FORCE ROW LEVEL SECURITY;
ALTER TABLE equipos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lecturas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_precintos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_precinto_puntos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_alertas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_anomalias FORCE ROW LEVEL SECURITY;

-- Todo tanque tiene grifo desde acá. El trigger de la sección 8 garantiza que
-- el código que todavía no lo manda (el viejo, durante el despliegue) no
-- choque con esto.
ALTER TABLE combustible ALTER COLUMN grifo_interno_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_grifo_interno
  ON combustible (tenant_id, grifo_interno_id);
CREATE INDEX IF NOT EXISTS idx_equipos_grifo_interno
  ON equipos (tenant_id, grifo_interno_id) WHERE grifo_interno_id IS NOT NULL;

-- Una por copia: toda clave foránea tiene su índice (tests/db-index-coverage),
-- y son los que va a usar el filtro por grifo de la entrega 3. Parciales: la
-- mayoría de las filas de urea y de huecos de talonario no tienen grifo.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_grifo_interno
  ON combustible_despachos (tenant_id, grifo_interno_id) WHERE grifo_interno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_equipo_grifo_interno
  ON combustible_despachos (tenant_id, equipo_grifo_interno_id)
  WHERE equipo_grifo_interno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_lecturas_grifo_interno
  ON combustible_lecturas (tenant_id, grifo_interno_id) WHERE grifo_interno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_grifo_interno
  ON combustible_recepciones (tenant_id, grifo_interno_id) WHERE grifo_interno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_precintos_grifo_interno
  ON combustible_precintos (tenant_id, grifo_interno_id) WHERE grifo_interno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_grifo_interno
  ON combustible_alertas (tenant_id, grifo_interno_id) WHERE grifo_interno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_grifo_interno
  ON combustible_anomalias (tenant_id, grifo_interno_id) WHERE grifo_interno_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movimientos_grifo_origen
  ON movimientos_grifo (tenant_id, grifo_origen_id) WHERE grifo_origen_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movimientos_grifo_destino
  ON movimientos_grifo (tenant_id, grifo_destino_id);

-- ── 7. RLS de las tablas nuevas ─────────────────────────────────────────
-- Después del backfill: las filas "Principal" se insertaron para todas las
-- empresas sin `app.tenant_id` de sesión.
ALTER TABLE sedes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sedes FORCE ROW LEVEL SECURITY;
ALTER TABLE grifos_internos ENABLE ROW LEVEL SECURITY;
ALTER TABLE grifos_internos FORCE ROW LEVEL SECURITY;
ALTER TABLE movimientos_grifo ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos_grifo FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sedes', 'grifos_internos', 'movimientos_grifo'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I
           USING (tenant_id = current_setting(''app.tenant_id'')::uuid)
           WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ── 8. El grifo de algo en un instante ──────────────────────────────────
-- El ORIGEN del primer movimiento posterior al instante; si no hubo ninguno,
-- el grifo actual. Es lo que le da a un vale offline que llega tarde el grifo
-- donde se cargó, no el de hoy. SECURITY INVOKER (el default): corre con la
-- empresa de la sesión, así que RLS sigue aplicando.
CREATE OR REPLACE FUNCTION grifo_de_tanque_en(p_combustible_id INTEGER, p_instante TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_origen INTEGER;
BEGIN
  IF p_combustible_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT m.grifo_origen_id INTO v_origen
    FROM movimientos_grifo m
   WHERE m.combustible_id = p_combustible_id AND m.movido_en > p_instante
   ORDER BY m.movido_en, m.id
   LIMIT 1;
  IF FOUND THEN
    RETURN v_origen;
  END IF;
  RETURN (SELECT c.grifo_interno_id FROM combustible c WHERE c.id = p_combustible_id);
END $$;

CREATE OR REPLACE FUNCTION grifo_de_equipo_en(p_equipo_id INTEGER, p_instante TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_origen INTEGER;
BEGIN
  IF p_equipo_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT m.grifo_origen_id INTO v_origen
    FROM movimientos_grifo m
   WHERE m.equipo_id = p_equipo_id AND m.movido_en > p_instante
   ORDER BY m.movido_en, m.id
   LIMIT 1;
  IF FOUND THEN
    RETURN v_origen;
  END IF;
  RETURN (SELECT e.grifo_interno_id FROM equipos e WHERE e.id = p_equipo_id);
END $$;

-- ── 9. Asignación por defecto (caso simple) ─────────────────────────────
-- Tanque o equipo que llega sin grifo:
--   - un solo grifo activo en la empresa  → ese;
--   - ningún grifo en absoluto            → se crea "Principal" y se usa
--     (backup anterior a esta migración, prueba de backup);
--   - más de uno                          → tanque: se rechaza; equipo: queda
--     sin grifo (el servicio lo exige cuando hace falta).
CREATE OR REPLACE FUNCTION asignar_grifo_por_defecto()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_activos INTEGER;
  v_grifo INTEGER;
  v_sede INTEGER;
BEGIN
  IF NEW.grifo_interno_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*), min(g.id) INTO v_activos, v_grifo
    FROM grifos_internos g WHERE g.tenant_id = NEW.tenant_id AND g.activo;

  IF v_activos = 1 THEN
    NEW.grifo_interno_id := v_grifo;
    RETURN NEW;
  END IF;

  IF v_activos = 0 AND NOT EXISTS (
    SELECT 1 FROM grifos_internos g WHERE g.tenant_id = NEW.tenant_id
  ) THEN
    SELECT s.id INTO v_sede FROM sedes s
     WHERE s.tenant_id = NEW.tenant_id ORDER BY s.activo DESC, s.id LIMIT 1;
    IF v_sede IS NULL THEN
      INSERT INTO sedes (tenant_id, nombre) VALUES (NEW.tenant_id, 'Principal')
      RETURNING id INTO v_sede;
    END IF;
    INSERT INTO grifos_internos (tenant_id, sede_id, nombre)
    VALUES (NEW.tenant_id, v_sede, 'Principal')
    RETURNING id INTO v_grifo;
    NEW.grifo_interno_id := v_grifo;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'combustible' THEN
    RAISE EXCEPTION 'el tanque necesita un grifo interno: la empresa tiene más de uno'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_combustible_grifo_por_defecto ON combustible;
CREATE TRIGGER trg_combustible_grifo_por_defecto
  BEFORE INSERT ON combustible
  FOR EACH ROW EXECUTE FUNCTION asignar_grifo_por_defecto();
DROP TRIGGER IF EXISTS trg_equipos_grifo_por_defecto ON equipos;
CREATE TRIGGER trg_equipos_grifo_por_defecto
  BEFORE INSERT ON equipos
  FOR EACH ROW EXECUTE FUNCTION asignar_grifo_por_defecto();

-- ── 10. Mover deja rastro ───────────────────────────────────────────────
-- El motivo y quién llegan por variables de SESIÓN de la transacción
-- (set_config(..., true)), que pone el único servicio que mueve. Sin motivo
-- se rechaza: ni un script ni un UPDATE a mano pueden mover sin rastro.
CREATE OR REPLACE FUNCTION registrar_movimiento_grifo()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_motivo TEXT := current_setting('app.motivo_movimiento_grifo', true);
  v_usuario TEXT := current_setting('app.usuario_id', true);
BEGIN
  IF v_motivo IS NULL OR length(trim(v_motivo)) = 0 THEN
    RAISE EXCEPTION 'mover de grifo exige un motivo'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.grifo_interno_id IS NULL THEN
    RAISE EXCEPTION 'no se puede dejar sin grifo algo que ya tenía uno'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM grifos_internos g
     WHERE g.id = NEW.grifo_interno_id AND g.tenant_id = NEW.tenant_id AND g.activo
  ) THEN
    RAISE EXCEPTION 'el grifo de destino no existe o está dado de baja'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO movimientos_grifo
    (tenant_id, combustible_id, equipo_id, grifo_origen_id, grifo_destino_id, motivo, usuario_id)
  VALUES (
    NEW.tenant_id,
    CASE WHEN TG_TABLE_NAME = 'combustible' THEN NEW.id END,
    CASE WHEN TG_TABLE_NAME = 'equipos' THEN NEW.id END,
    OLD.grifo_interno_id,
    NEW.grifo_interno_id,
    trim(v_motivo),
    NULLIF(v_usuario, '')::uuid
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_combustible_movimiento_grifo ON combustible;
CREATE TRIGGER trg_combustible_movimiento_grifo
  BEFORE UPDATE OF grifo_interno_id ON combustible
  FOR EACH ROW WHEN (OLD.grifo_interno_id IS DISTINCT FROM NEW.grifo_interno_id)
  EXECUTE FUNCTION registrar_movimiento_grifo();
DROP TRIGGER IF EXISTS trg_equipos_movimiento_grifo ON equipos;
CREATE TRIGGER trg_equipos_movimiento_grifo
  BEFORE UPDATE OF grifo_interno_id ON equipos
  FOR EACH ROW WHEN (OLD.grifo_interno_id IS DISTINCT FROM NEW.grifo_interno_id)
  EXECUTE FUNCTION registrar_movimiento_grifo();

-- ── 11. La copia en cada hecho, al insertarlo ───────────────────────────
-- Solo si viene NULL: un restore de un backup nuevo trae la copia (remapeada)
-- y se respeta. Cubre todos los caminos de inserción -- la API, la cola
-- offline, los scripts y los tests que insertan por SQL -- sin tocar a
-- ninguno. Se calcula A LA FECHA DEL HECHO, no la de hoy.
CREATE OR REPLACE FUNCTION copiar_grifo_despacho()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.equipo_grifo_interno_id IS NULL AND NEW.equipo_id IS NOT NULL THEN
    NEW.equipo_grifo_interno_id := grifo_de_equipo_en(NEW.equipo_id, NEW.despachado_en);
  END IF;
  IF NEW.grifo_interno_id IS NULL THEN
    -- Del tanque propio: el grifo de donde salió el combustible. Compra
    -- externa y urea no salen de ningún grifo propio: quedan en el del equipo.
    IF NEW.origen = 'tanque_propio' AND NEW.combustible_id IS NOT NULL THEN
      NEW.grifo_interno_id := grifo_de_tanque_en(NEW.combustible_id, NEW.despachado_en);
    ELSE
      NEW.grifo_interno_id := NEW.equipo_grifo_interno_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION copiar_grifo_lectura()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grifo_interno_id IS NULL THEN
    NEW.grifo_interno_id := grifo_de_tanque_en(NEW.combustible_id, NEW.leido_en);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION copiar_grifo_recepcion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grifo_interno_id IS NULL AND NEW.combustible_id IS NOT NULL THEN
    NEW.grifo_interno_id := grifo_de_tanque_en(NEW.combustible_id, NEW.recibido_en);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION copiar_grifo_precinto()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grifo_interno_id IS NULL THEN
    NEW.grifo_interno_id := grifo_de_tanque_en(
      (SELECT p.combustible_id FROM combustible_precinto_puntos p WHERE p.id = NEW.punto_id),
      NEW.colocado_en
    );
  END IF;
  RETURN NEW;
END $$;

-- La alerta copia la del hecho que la disparó. Urea y hueco de talonario
-- quedan sin grifo.
CREATE OR REPLACE FUNCTION copiar_grifo_alerta()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grifo_interno_id IS NOT NULL OR COALESCE(NEW.producto, 'combustible') = 'urea' THEN
    RETURN NEW;
  END IF;
  IF NEW.despacho_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT d.grifo_interno_id FROM combustible_despachos d
                              WHERE d.id = NEW.despacho_id);
  ELSIF NEW.lectura_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT l.grifo_interno_id FROM combustible_lecturas l
                              WHERE l.id = NEW.lectura_id);
  ELSIF NEW.recepcion_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT r.grifo_interno_id FROM combustible_recepciones r
                              WHERE r.id = NEW.recepcion_id);
  ELSIF NEW.combustible_id IS NOT NULL THEN
    NEW.grifo_interno_id := grifo_de_tanque_en(NEW.combustible_id, COALESCE(NEW.creado_en, now()));
  END IF;
  RETURN NEW;
END $$;

-- La anomalía es la alerta congelada: hereda su copia.
CREATE OR REPLACE FUNCTION copiar_grifo_anomalia()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grifo_interno_id IS NULL AND NEW.alerta_id IS NOT NULL THEN
    NEW.grifo_interno_id := (SELECT a.grifo_interno_id FROM combustible_alertas a
                              WHERE a.id = NEW.alerta_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_despachos_copia_grifo ON combustible_despachos;
CREATE TRIGGER trg_despachos_copia_grifo BEFORE INSERT ON combustible_despachos
  FOR EACH ROW EXECUTE FUNCTION copiar_grifo_despacho();
DROP TRIGGER IF EXISTS trg_lecturas_copia_grifo ON combustible_lecturas;
CREATE TRIGGER trg_lecturas_copia_grifo BEFORE INSERT ON combustible_lecturas
  FOR EACH ROW EXECUTE FUNCTION copiar_grifo_lectura();
DROP TRIGGER IF EXISTS trg_recepciones_copia_grifo ON combustible_recepciones;
CREATE TRIGGER trg_recepciones_copia_grifo BEFORE INSERT ON combustible_recepciones
  FOR EACH ROW EXECUTE FUNCTION copiar_grifo_recepcion();
DROP TRIGGER IF EXISTS trg_precintos_copia_grifo ON combustible_precintos;
CREATE TRIGGER trg_precintos_copia_grifo BEFORE INSERT ON combustible_precintos
  FOR EACH ROW EXECUTE FUNCTION copiar_grifo_precinto();
DROP TRIGGER IF EXISTS trg_alertas_copia_grifo ON combustible_alertas;
CREATE TRIGGER trg_alertas_copia_grifo BEFORE INSERT ON combustible_alertas
  FOR EACH ROW EXECUTE FUNCTION copiar_grifo_alerta();
DROP TRIGGER IF EXISTS trg_anomalias_copia_grifo ON combustible_anomalias;
CREATE TRIGGER trg_anomalias_copia_grifo BEFORE INSERT ON combustible_anomalias
  FOR EACH ROW EXECUTE FUNCTION copiar_grifo_anomalia();
