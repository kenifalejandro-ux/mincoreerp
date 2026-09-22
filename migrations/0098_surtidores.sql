-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: SURTIDORES (entrega 2 de
-- docs/architecture/combustible-sedes-grifos-surtidores.md)
--
-- Hasta acá cada tanque tenía UN surtidor implícito: la casilla del
-- totalizador, su tolerancia y su cadena de comparación vivían en el tanque.
-- Con dos surtidores en un tanque, sus dos contadores se mezclaban en una sola
-- cadena y daban saltos y retrocesos falsos; con un surtidor sobre dos
-- tanques, el avance incluía lo que salió del otro.
--
-- Ahora el surtidor es una entidad del grifo interno:
--
--   Grifo interno → Surtidores ── conectados a uno o más tanques del grifo
--
-- y la cadena del totalizador es POR SURTIDOR.
--
-- Cuatro ideas:
--
-- 1. TODO TANQUE TIENE SU SURTIDOR. El vale de tanque propio guarda de qué
--    surtidor salió, así que un tanque sin surtidor no podría despachar. La
--    migración le crea uno a cada tanque ("Surtidor TQ-01") con la casilla,
--    la tolerancia y el totalizador que tenía el tanque.
--
-- 2. LA CONEXIÓN TIENE HISTORIA. `surtidor_tanques` guarda desde y hasta
--    cuándo un surtidor alimentó a un tanque: un vale cargado sin red que
--    llega tarde se valida contra la conexión de SU fecha, no la de hoy.
--
-- 3. UN SURTIDOR Y SUS TANQUES, SIEMPRE EN EL MISMO GRIFO. Lo garantiza la
--    base: conectar un tanque de otro grifo se rechaza, y mover un tanque de
--    grifo arrastra a los surtidores que alimentan SOLO a ese tanque (uno
--    compartido con otro tanque que se queda hace rechazar el movimiento).
--
-- 4. EL CASO SIMPLE NO CAMBIA. Un vale sin surtidor toma el único del tanque.
--    Si el tanque nunca tuvo uno (insertado por SQL, backup anterior a esta
--    migración, código viejo durante el despliegue), se le crea en ese
--    momento. El servicio crea el surtidor al dar de alta un tanque; no lo
--    hace un trigger de alta porque restaurar un backup lo duplicaría.
--
-- EXPANDIR Y CONTRAER: `combustible.usa_totalizador`, `totalizador_tolerancia`
-- y `totalizador_actual`, y `combustible_lecturas.totalizador_lectura`, NO se
-- borran acá: el código deja de leerlos y se borran en una migración
-- posterior al despliegue. Mientras tanto, lo que el código viejo escriba en
-- `totalizador_lectura` se copia a la tabla nueva (sección 9).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Surtidores ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surtidores (
  id                      SERIAL PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grifo_interno_id        INTEGER NOT NULL,
  nombre                  VARCHAR(80) NOT NULL CHECK (length(trim(nombre)) > 0),
  activo                  BOOLEAN NOT NULL DEFAULT true,
  motivo_baja             TEXT,
  -- El totalizador es del APARATO: cada surtidor puede tenerlo o no, y cada
  -- uno tiene su propia resolución de lectura.
  usa_totalizador         BOOLEAN NOT NULL DEFAULT false,
  totalizador_tolerancia  NUMERIC(8,3) NOT NULL DEFAULT 1 CHECK (totalizador_tolerancia >= 0),
  -- El MAYOR totalizador entre sus vales y varillas vigentes. Se recalcula,
  -- no se acumula: anular el último punto lo devuelve al anterior.
  totalizador_actual      NUMERIC(14,3) NOT NULL DEFAULT 0,
  creado_por              UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, grifo_interno_id) REFERENCES grifos_internos (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_surtidores_nombre
  ON surtidores (tenant_id, grifo_interno_id, lower(trim(nombre)));
CREATE INDEX IF NOT EXISTS idx_surtidores_grifo
  ON surtidores (tenant_id, grifo_interno_id);
CREATE INDEX IF NOT EXISTS idx_surtidores_creado_por
  ON surtidores (creado_por) WHERE creado_por IS NOT NULL;

-- ── 2. Qué tanque alimenta cada surtidor, y desde cuándo ────────────────
CREATE TABLE IF NOT EXISTS surtidor_tanques (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  surtidor_id         INTEGER NOT NULL,
  combustible_id      INTEGER NOT NULL REFERENCES combustible(id) ON DELETE CASCADE,
  -- 1900-01-01 para la conexión inicial de cada tanque ("desde siempre"): un
  -- vale histórico cargado hoy con fecha de 2025 también tiene que encontrar
  -- su surtidor. Una fecha FINITA y no '-infinity': node-pg la convierte en
  -- una fecha inválida, el JSON del backup la guarda como null y el restore
  -- choca con el NOT NULL.
  conectado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  desconectado_en     TIMESTAMPTZ,
  motivo_conexion     TEXT,
  motivo_desconexion  TEXT,
  conectado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  desconectado_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, surtidor_id) REFERENCES surtidores (tenant_id, id) ON DELETE CASCADE,
  CHECK (desconectado_en IS NULL OR desconectado_en >= conectado_en),
  CHECK (desconectado_en IS NULL OR length(trim(coalesce(motivo_desconexion, ''))) > 0)
);

-- Una sola conexión VIGENTE por par surtidor-tanque.
CREATE UNIQUE INDEX IF NOT EXISTS idx_surtidor_tanques_vigente
  ON surtidor_tanques (surtidor_id, combustible_id) WHERE desconectado_en IS NULL;
CREATE INDEX IF NOT EXISTS idx_surtidor_tanques_tanque
  ON surtidor_tanques (combustible_id, conectado_en);
CREATE INDEX IF NOT EXISTS idx_surtidor_tanques_surtidor
  ON surtidor_tanques (tenant_id, surtidor_id);
CREATE INDEX IF NOT EXISTS idx_surtidor_tanques_conectado_por
  ON surtidor_tanques (conectado_por) WHERE conectado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surtidor_tanques_desconectado_por
  ON surtidor_tanques (desconectado_por) WHERE desconectado_por IS NOT NULL;

-- ── 3. Lo que la varilla leyó en cada surtidor ─────────────────────────
-- Reemplaza a `combustible_lecturas.totalizador_lectura` (0096): el tanque
-- puede tener más de un surtidor, y la varilla los lee a todos.
CREATE TABLE IF NOT EXISTS combustible_lectura_totalizadores (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lectura_id   BIGINT NOT NULL REFERENCES combustible_lecturas(id) ON DELETE CASCADE,
  surtidor_id  INTEGER NOT NULL,
  valor        NUMERIC(14,3) NOT NULL CHECK (valor >= 0),
  FOREIGN KEY (tenant_id, surtidor_id) REFERENCES surtidores (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (lectura_id, surtidor_id)
);

-- Los vecinos por valor en la cadena de un surtidor (misma idea que 0094).
CREATE INDEX IF NOT EXISTS idx_lectura_totalizadores_cadena
  ON combustible_lectura_totalizadores (tenant_id, surtidor_id, valor);

-- ── 4. El surtidor del vale y del movimiento ───────────────────────────
ALTER TABLE combustible_despachos ADD COLUMN IF NOT EXISTS surtidor_id INTEGER;
ALTER TABLE movimientos_grifo ADD COLUMN IF NOT EXISTS surtidor_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_surtidor_forma_check'
  ) THEN
    -- Solo el vale de combustible del tanque propio sale de un surtidor.
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_surtidor_forma_check
      CHECK (surtidor_id IS NULL OR (origen = 'tanque_propio' AND producto = 'combustible'));
  END IF;
END $$;

-- El movimiento ahora puede ser de un tanque, un equipo o un surtidor.
ALTER TABLE movimientos_grifo DROP CONSTRAINT IF EXISTS movimientos_grifo_check;
ALTER TABLE movimientos_grifo DROP CONSTRAINT IF EXISTS movimientos_grifo_entidad_check;
ALTER TABLE movimientos_grifo
  ADD CONSTRAINT movimientos_grifo_entidad_check
  CHECK (num_nonnulls(combustible_id, equipo_id, surtidor_id) = 1);

CREATE INDEX IF NOT EXISTS idx_movimientos_grifo_surtidor
  ON movimientos_grifo (surtidor_id, movido_en) WHERE surtidor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_surtidor
  ON combustible_despachos (tenant_id, surtidor_id) WHERE surtidor_id IS NOT NULL;
-- Los vecinos por valor en la cadena de un surtidor, del lado de los vales.
CREATE INDEX IF NOT EXISTS idx_combustible_despachos_cadena_surtidor
  ON combustible_despachos (tenant_id, surtidor_id, totalizador_lectura)
  WHERE surtidor_id IS NOT NULL AND totalizador_lectura IS NOT NULL AND anulada_en IS NULL;

-- ── 5. Backfill: un surtidor por tanque ────────────────────────────────
-- Toca filas de TODAS las empresas: FORCE apagado solo durante el backfill,
-- en la misma transacción (mecanismo de 0057). Las claves foráneas nuevas
-- van ACÁ adentro: su validación inicial sí pasa por RLS.
ALTER TABLE combustible NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lecturas NO FORCE ROW LEVEL SECURITY;
ALTER TABLE movimientos_grifo NO FORCE ROW LEVEL SECURITY;
ALTER TABLE grifos_internos NO FORCE ROW LEVEL SECURITY;
-- Las nuevas todavía no tienen RLS en una base limpia; en una que ya corrió
-- esta migración sí. Así el archivo aguanta correr dos veces.
ALTER TABLE surtidores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE surtidor_tanques NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lectura_totalizadores NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_despachos_surtidor_id_fk'
  ) THEN
    ALTER TABLE combustible_despachos
      ADD CONSTRAINT combustible_despachos_surtidor_id_fk
      FOREIGN KEY (tenant_id, surtidor_id) REFERENCES surtidores (tenant_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'movimientos_grifo_surtidor_id_fk'
  ) THEN
    ALTER TABLE movimientos_grifo
      ADD CONSTRAINT movimientos_grifo_surtidor_id_fk
      FOREIGN KEY (tenant_id, surtidor_id) REFERENCES surtidores (tenant_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- El nombre "Surtidor <código>" es único dentro de la empresa porque el código
-- del tanque lo es, y es lo que permite volver a encontrar qué surtidor se
-- creó para qué tanque sin una columna auxiliar.
INSERT INTO surtidores
  (tenant_id, grifo_interno_id, nombre, usa_totalizador, totalizador_tolerancia, totalizador_actual)
SELECT c.tenant_id, c.grifo_interno_id, 'Surtidor ' || c.codigo,
       c.usa_totalizador, c.totalizador_tolerancia, c.totalizador_actual
  FROM combustible c
 WHERE NOT EXISTS (SELECT 1 FROM surtidor_tanques st WHERE st.combustible_id = c.id);

INSERT INTO surtidor_tanques (tenant_id, surtidor_id, combustible_id, conectado_en, motivo_conexion)
SELECT c.tenant_id, s.id, c.id, '1900-01-01T00:00:00Z', 'Migración inicial: el surtidor del tanque'
  FROM combustible c
  JOIN surtidores s ON s.tenant_id = c.tenant_id
                   AND s.grifo_interno_id = c.grifo_interno_id
                   AND s.nombre = 'Surtidor ' || c.codigo
 WHERE NOT EXISTS (SELECT 1 FROM surtidor_tanques st WHERE st.combustible_id = c.id);

UPDATE combustible_despachos d SET surtidor_id = st.surtidor_id
  FROM surtidor_tanques st
 WHERE st.combustible_id = d.combustible_id
   AND d.origen = 'tanque_propio' AND d.producto = 'combustible'
   AND d.surtidor_id IS NULL;

INSERT INTO combustible_lectura_totalizadores (tenant_id, lectura_id, surtidor_id, valor)
SELECT l.tenant_id, l.id, st.surtidor_id, l.totalizador_lectura
  FROM combustible_lecturas l
  JOIN surtidor_tanques st ON st.combustible_id = l.combustible_id
 WHERE l.totalizador_lectura IS NOT NULL
ON CONFLICT (lectura_id, surtidor_id) DO NOTHING;

-- La columna vieja queda vacía: la tabla nueva es la fuente. Si conservara el
-- valor, restaurar un backup lo copiaría dos veces (la sección 9 copia lo que
-- llegue a esa columna, y además se restaura la tabla nueva).
UPDATE combustible_lecturas SET totalizador_lectura = NULL WHERE totalizador_lectura IS NOT NULL;

ALTER TABLE combustible FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_despachos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lecturas FORCE ROW LEVEL SECURITY;
ALTER TABLE movimientos_grifo FORCE ROW LEVEL SECURITY;
ALTER TABLE grifos_internos FORCE ROW LEVEL SECURITY;

-- ── 6. RLS de las tablas nuevas ─────────────────────────────────────────
ALTER TABLE surtidores ENABLE ROW LEVEL SECURITY;
ALTER TABLE surtidores FORCE ROW LEVEL SECURITY;
ALTER TABLE surtidor_tanques ENABLE ROW LEVEL SECURITY;
ALTER TABLE surtidor_tanques FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lectura_totalizadores ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_lectura_totalizadores FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['surtidores', 'surtidor_tanques', 'combustible_lectura_totalizadores']
  LOOP
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

-- ── 7. Un surtidor y sus tanques, siempre en el mismo grifo ────────────
-- Conectar: el tanque tiene que estar en el grifo del surtidor, y el
-- surtidor, activo.
CREATE OR REPLACE FUNCTION validar_conexion_surtidor()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_grifo_surtidor INTEGER;
  v_activo BOOLEAN;
  v_grifo_tanque INTEGER;
BEGIN
  SELECT s.grifo_interno_id, s.activo INTO v_grifo_surtidor, v_activo
    FROM surtidores s WHERE s.id = NEW.surtidor_id AND s.tenant_id = NEW.tenant_id;
  SELECT c.grifo_interno_id INTO v_grifo_tanque
    FROM combustible c WHERE c.id = NEW.combustible_id AND c.tenant_id = NEW.tenant_id;
  IF v_grifo_tanque IS NULL THEN
    RAISE EXCEPTION 'el tanque indicado no existe' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_activo THEN
    RAISE EXCEPTION 'el surtidor está dado de baja: reactívalo antes de conectarlo'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_grifo_surtidor <> v_grifo_tanque THEN
    RAISE EXCEPTION 'el surtidor y el tanque están en grifos internos distintos'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_surtidor_tanques_validar ON surtidor_tanques;
CREATE TRIGGER trg_surtidor_tanques_validar BEFORE INSERT ON surtidor_tanques
  FOR EACH ROW EXECUTE FUNCTION validar_conexion_surtidor();

-- El movimiento de grifo (0097) ahora también registra surtidores. Mismo
-- contrato: motivo y usuario por variables de sesión, y sin motivo no hay
-- cambio.
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
  -- Un surtidor solo se mueve junto con sus tanques (sección siguiente): si
  -- alguno de sus tanques conectados sigue en otro grifo, se rechaza.
  IF TG_TABLE_NAME = 'surtidores' AND EXISTS (
    SELECT 1 FROM surtidor_tanques st
      JOIN combustible c ON c.id = st.combustible_id
     WHERE st.surtidor_id = NEW.id AND st.desconectado_en IS NULL
       AND c.grifo_interno_id <> NEW.grifo_interno_id
  ) THEN
    RAISE EXCEPTION 'un surtidor se mueve con sus tanques: muévelos o desconéctalos primero'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO movimientos_grifo
    (tenant_id, combustible_id, equipo_id, surtidor_id, grifo_origen_id, grifo_destino_id,
     motivo, usuario_id)
  VALUES (
    NEW.tenant_id,
    CASE WHEN TG_TABLE_NAME = 'combustible' THEN NEW.id END,
    CASE WHEN TG_TABLE_NAME = 'equipos' THEN NEW.id END,
    CASE WHEN TG_TABLE_NAME = 'surtidores' THEN NEW.id END,
    OLD.grifo_interno_id,
    NEW.grifo_interno_id,
    trim(v_motivo),
    NULLIF(v_usuario, '')::uuid
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_surtidores_movimiento_grifo ON surtidores;
CREATE TRIGGER trg_surtidores_movimiento_grifo
  BEFORE UPDATE OF grifo_interno_id ON surtidores
  FOR EACH ROW WHEN (OLD.grifo_interno_id IS DISTINCT FROM NEW.grifo_interno_id)
  EXECUTE FUNCTION registrar_movimiento_grifo();

-- Mover un tanque arrastra a los surtidores que lo alimentan SOLO a él. AFTER
-- y no BEFORE: el surtidor verifica que sus tanques ya estén en el grifo de
-- destino, y eso recién es cierto con el tanque ya actualizado.
CREATE OR REPLACE FUNCTION arrastrar_surtidores_del_tanque()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_compartido TEXT;
BEGIN
  SELECT s.nombre INTO v_compartido
    FROM surtidor_tanques st
    JOIN surtidores s ON s.id = st.surtidor_id
   WHERE st.combustible_id = NEW.id AND st.desconectado_en IS NULL
     AND EXISTS (
       SELECT 1 FROM surtidor_tanques otro
        WHERE otro.surtidor_id = st.surtidor_id AND otro.desconectado_en IS NULL
          AND otro.combustible_id <> NEW.id
     )
   LIMIT 1;
  IF v_compartido IS NOT NULL THEN
    RAISE EXCEPTION 'el surtidor "%" también alimenta a otro tanque: desconéctalo antes de mover este',
      v_compartido USING ERRCODE = 'check_violation';
  END IF;

  UPDATE surtidores s SET grifo_interno_id = NEW.grifo_interno_id
    FROM surtidor_tanques st
   WHERE st.surtidor_id = s.id AND st.combustible_id = NEW.id AND st.desconectado_en IS NULL
     AND s.grifo_interno_id <> NEW.grifo_interno_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_combustible_arrastrar_surtidores ON combustible;
CREATE TRIGGER trg_combustible_arrastrar_surtidores
  AFTER UPDATE OF grifo_interno_id ON combustible
  FOR EACH ROW WHEN (OLD.grifo_interno_id IS DISTINCT FROM NEW.grifo_interno_id)
  EXECUTE FUNCTION arrastrar_surtidores_del_tanque();

-- ── 8. El surtidor del vale ─────────────────────────────────────────────
-- Los surtidores que alimentaban un tanque EN UN INSTANTE.
CREATE OR REPLACE FUNCTION surtidores_del_tanque_en(p_combustible_id INTEGER, p_instante TIMESTAMPTZ)
RETURNS SETOF INTEGER LANGUAGE sql STABLE AS $$
  SELECT st.surtidor_id FROM surtidor_tanques st
   WHERE st.combustible_id = p_combustible_id
     AND st.conectado_en <= p_instante
     AND (st.desconectado_en IS NULL OR st.desconectado_en > p_instante)
$$;

-- El surtidor de un tanque que nunca tuvo ninguno: se crea con la casilla y
-- la tolerancia del tanque, conectado desde siempre. Devuelve su id.
CREATE OR REPLACE FUNCTION crear_surtidor_del_tanque(p_combustible_id INTEGER)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_surtidor INTEGER;
  t RECORD;
BEGIN
  SELECT c.tenant_id, c.grifo_interno_id, c.codigo, c.usa_totalizador, c.totalizador_tolerancia
    INTO t FROM combustible c WHERE c.id = p_combustible_id;
  INSERT INTO surtidores (tenant_id, grifo_interno_id, nombre, usa_totalizador, totalizador_tolerancia)
  VALUES (t.tenant_id, t.grifo_interno_id, 'Surtidor ' || t.codigo, t.usa_totalizador,
          t.totalizador_tolerancia)
  RETURNING id INTO v_surtidor;
  INSERT INTO surtidor_tanques (tenant_id, surtidor_id, combustible_id, conectado_en, motivo_conexion)
  VALUES (t.tenant_id, v_surtidor, p_combustible_id, '1900-01-01T00:00:00Z', 'El surtidor del tanque');
  RETURN v_surtidor;
END $$;

-- Vale de tanque propio: sin surtidor, el único que tenía el tanque a la
-- fecha del vale; con surtidor, que realmente alimentara a ese tanque a esa
-- fecha.
CREATE OR REPLACE FUNCTION asignar_surtidor_del_vale()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_cantidad INTEGER;
  v_surtidor INTEGER;
  v_codigo TEXT;
BEGIN
  IF NEW.origen <> 'tanque_propio' OR NEW.producto <> 'combustible' OR NEW.combustible_id IS NULL
  THEN
    RETURN NEW;
  END IF;
  SELECT c.codigo INTO v_codigo FROM combustible c WHERE c.id = NEW.combustible_id;

  IF NEW.surtidor_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM surtidores_del_tanque_en(NEW.combustible_id, NEW.despachado_en) s
       WHERE s = NEW.surtidor_id
    ) THEN
      RAISE EXCEPTION 'el surtidor indicado no alimentaba al tanque % en la fecha del vale', v_codigo
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*), min(s) INTO v_cantidad, v_surtidor
    FROM surtidores_del_tanque_en(NEW.combustible_id, NEW.despachado_en) s;
  IF v_cantidad = 1 THEN
    NEW.surtidor_id := v_surtidor;
    RETURN NEW;
  END IF;
  IF v_cantidad = 0 AND NOT EXISTS (
    SELECT 1 FROM surtidor_tanques st WHERE st.combustible_id = NEW.combustible_id
  ) THEN
    NEW.surtidor_id := crear_surtidor_del_tanque(NEW.combustible_id);
    RETURN NEW;
  END IF;
  IF v_cantidad = 0 THEN
    RAISE EXCEPTION 'el tanque % no tenía ningún surtidor conectado en la fecha del vale', v_codigo
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'el tanque % tiene más de un surtidor: indicá de cuál salió el vale', v_codigo
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS trg_despachos_asignar_surtidor ON combustible_despachos;
CREATE TRIGGER trg_despachos_asignar_surtidor BEFORE INSERT ON combustible_despachos
  FOR EACH ROW EXECUTE FUNCTION asignar_surtidor_del_vale();

-- ── 9. Lo que el código viejo escriba en la columna vieja ──────────────
-- Durante el despliegue, o al restaurar un backup anterior a esta migración,
-- una varilla puede llegar con `totalizador_lectura`: se copia al único
-- surtidor del tanque con totalizador y la columna se vacía. Con más de uno
-- no se puede saber de cuál es, y queda como vino. Se retira junto con la
-- columna.
CREATE OR REPLACE FUNCTION copiar_totalizador_viejo_de_lectura()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_cantidad INTEGER;
  v_surtidor INTEGER;
BEGIN
  IF NEW.totalizador_lectura IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM surtidor_tanques st WHERE st.combustible_id = NEW.combustible_id) THEN
    PERFORM crear_surtidor_del_tanque(NEW.combustible_id);
  END IF;
  SELECT count(*), min(s.id) INTO v_cantidad, v_surtidor
    FROM surtidores s
   WHERE s.usa_totalizador
     AND s.id IN (SELECT surtidores_del_tanque_en(NEW.combustible_id, NEW.leido_en));
  IF v_cantidad <> 1 THEN
    RETURN NEW;
  END IF;
  INSERT INTO combustible_lectura_totalizadores (tenant_id, lectura_id, surtidor_id, valor)
  VALUES (NEW.tenant_id, NEW.id, v_surtidor, NEW.totalizador_lectura)
  ON CONFLICT (lectura_id, surtidor_id) DO NOTHING;
  UPDATE combustible_lecturas SET totalizador_lectura = NULL WHERE id = NEW.id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lecturas_totalizador_viejo ON combustible_lecturas;
CREATE TRIGGER trg_lecturas_totalizador_viejo AFTER INSERT ON combustible_lecturas
  FOR EACH ROW EXECUTE FUNCTION copiar_totalizador_viejo_de_lectura();
