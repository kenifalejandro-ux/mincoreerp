-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: órdenes administrativas y doble firma (entrega 5)
--
-- Kenif lo pidió con el telebanking de su banco a la vista: *"cuando el
-- usuario da de alta un usuario, elimina, desbloquea etc se genera una orden
-- con correlativo"*, y *"cualquier actividad sea a doble firma"*.
--
-- ── Por qué una ORDEN y no solo una fila de bitácora ────────────────────
--
-- La bitácora dice lo que pasó. Una orden es un documento que existe ANTES de
-- que pase: la pide alguien, la firma otro, y recién ahí se aplica. Esa
-- diferencia es todo el punto de la doble firma -- entre que se pide y se
-- aplica hay una persona distinta mirando.
--
-- Y queda: una orden aplicada es el respaldo de por qué alguien tiene el
-- acceso que tiene. El correlativo (ORD-2026-000123) es para poder nombrarla
-- en un correo o en un papel.
--
-- ── Una sola pendiente por persona ──────────────────────────────────────
--
-- El índice único parcial de abajo: dos órdenes pendientes sobre la misma
-- persona son dos verdades distintas esperando ser firmadas, y aplicarlas en
-- cualquier orden da resultados distintos. La segunda se rechaza con 409, el
-- mismo patrón que las aprobaciones de IPERC.
--
-- ── El correlativo ──────────────────────────────────────────────────────
--
-- Por empresa y por año, sin huecos. No se usa una secuencia de Postgres
-- porque una secuencia es global y no se puede reiniciar por empresa; se toma
-- un advisory lock por (empresa, año) y se calcula el siguiente. El lock es
-- de transacción: se suelta solo al terminar, falle o no.
--
-- EJECUTAR (después de 0090):
--   psql -d mincoreerp -f migrations/0091_ordenes_administrativas.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Apagada por defecto: una empresa chica con un solo administrador no puede
-- tener doble firma sin quedarse trabada. Se enciende desde Administración, y
-- para encenderla hacen falta dos administradores activos.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS doble_firma BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE orden_admin_tipo AS ENUM (
    'alta_usuario',
    'baja_usuario',
    'reactivar_usuario',
    'desbloquear_usuario',
    'resetear_clave',
    'cambiar_permisos',
    'cambiar_doble_firma'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE orden_admin_estado AS ENUM (
    'pendiente',   -- esperando la segunda firma
    'aplicada',    -- firmada y ejecutada
    'rechazada',   -- el segundo firmante dijo que no
    'vencida',     -- pasaron 72 horas sin firma
    'fallida'      -- se aprobó pero al aplicarla algo ya no daba
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ordenes_admin (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  -- Correlativo por empresa y año: 1, 2, 3... El texto que se muestra
  -- (ORD-2026-000123) se arma al leer, no se guarda dos veces.
  anio           SMALLINT NOT NULL,
  numero         INTEGER NOT NULL,
  tipo           orden_admin_tipo NOT NULL,
  estado         orden_admin_estado NOT NULL DEFAULT 'pendiente',
  -- Sobre quién. NULL en un alta (la persona todavía no existe) y en el
  -- encendido/apagado de la doble firma (es sobre la empresa entera).
  usuario_id     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  -- Qué se pidió exactamente. Se guarda entero para poder aplicarlo después
  -- sin depender de que la pantalla lo vuelva a mandar.
  payload        JSONB NOT NULL,
  -- Cómo estaba antes, para que el segundo firmante vea el antes -> después
  -- sin tener que reconstruirlo.
  antes          JSONB,
  motivo         TEXT NOT NULL,
  solicitante_id UUID NOT NULL REFERENCES usuarios(id),
  firmas_requeridas SMALLINT NOT NULL DEFAULT 2,
  -- Quién firmó (o rechazó) y con qué motivo.
  aprobador_id   UUID REFERENCES usuarios(id),
  motivo_resolucion TEXT,
  resuelta_en    TIMESTAMPTZ,
  -- 72 horas desde que se pidió. Una orden vieja se aplica sobre un mundo que
  -- ya cambió: mejor que la vuelvan a pedir.
  expira_en      TIMESTAMPTZ NOT NULL,
  -- El error, si se aprobó y al aplicarla algo ya no daba (la persona se dio
  -- de baja en el medio, el módulo dejó de estar contratado).
  error          TEXT,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ordenes_admin_correlativo_unico UNIQUE (tenant_id, anio, numero)
);

-- Una sola orden pendiente por persona (ver el encabezado). Las órdenes sin
-- usuario_id (alta, doble firma) no entran: no hay a quién duplicarle nada.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ordenes_admin_una_pendiente
  ON ordenes_admin(tenant_id, usuario_id)
  WHERE estado = 'pendiente' AND usuario_id IS NOT NULL;

-- La pantalla lista por fecha y filtra por estado.
CREATE INDEX IF NOT EXISTS idx_ordenes_admin_tenant_creado
  ON ordenes_admin(tenant_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_ordenes_admin_tenant_estado
  ON ordenes_admin(tenant_id, estado);
-- FK sin índice propio: al borrar un usuario, el ON DELETE SET NULL de
-- usuario_id y las lecturas por solicitante/aprobador necesitan cubrirlas.
CREATE INDEX IF NOT EXISTS idx_ordenes_admin_usuario ON ordenes_admin(usuario_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_admin_solicitante ON ordenes_admin(solicitante_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_admin_aprobador ON ordenes_admin(aprobador_id);

-- Mismo aislamiento que el resto del ERP: cada empresa ve sus órdenes.
ALTER TABLE ordenes_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordenes_admin FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON ordenes_admin
    USING (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE ordenes_admin IS
  'Órdenes administrativas con correlativo por empresa/año y doble firma (entrega 5). Una orden aplicada es el respaldo de por qué alguien tiene el acceso que tiene.';
