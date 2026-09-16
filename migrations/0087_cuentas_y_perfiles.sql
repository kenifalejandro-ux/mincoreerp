-- migrations/0087_cuentas_y_perfiles.sql
--
-- Cuentas (la persona) y perfiles (su lugar en cada empresa).
-- Diseño completo: docs/architecture/cuentas-perfiles-y-administracion.md
--
-- Hasta acá cada usuario vivía DENTRO de una empresa: correo único por empresa
-- (0001) y el login necesitaba saber la empresa de antemano. Desde esta
-- migración, una persona tiene UNA cuenta (correo + clave) y un perfil por
-- cada empresa donde trabaja. `usuarios` pasa a ser ese perfil.
--
-- ── Compatibilidad hacia atrás ──────────────────────────────────────────
--
-- Esta migración SOLO AGREGA: una tabla, columnas nulables, una política de
-- lectura, y relaja dos NOT NULL. No borra ni endurece nada que el código
-- anterior use. El hash de clave se COPIA a la cuenta y queda también en
-- usuarios.password_hash: una migración posterior de "contract", cuando todo
-- corra con el código nuevo, lo limpia y agrega el CHECK de forma.
--
-- ── Por qué la copia de datos recorre empresa por empresa ───────────────
--
-- `usuarios` tiene FORCE ROW LEVEL SECURITY (0010), y las migraciones corren
-- como el dueño de las tablas, que NO es superusuario (ver ci.yml). Un
-- `SELECT ... FROM usuarios` sin app.tenant_id no ve ninguna fila -- peor:
-- la política usa current_setting sin missing_ok y falla. Así que la copia
-- fija app.tenant_id para cada empresa, igual que hace la app con
-- withTenant(). RLS nunca se apaga.

-- ── 1. Cuentas ──────────────────────────────────────────────────────────
--
-- Sin tenant_id y sin RLS, igual que `tenants` y `platform_admins`: la persona
-- es anterior a cualquier empresa. Solo la lee y escribe el servicio de
-- autenticación.

CREATE TABLE IF NOT EXISTS cuentas (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Único en TODA la plataforma. Se guarda en minúsculas (CHECK) para que la
  -- unicidad sea un índice simple y ON CONFLICT (email) funcione directo.
  email                  VARCHAR(150) NOT NULL UNIQUE,
  -- NULL mientras la persona no definió su clave: una invitación pendiente
  -- (entrega 3) o una cuenta creada solo para entrar por SSO.
  password_hash          VARCHAR(255),
  debe_cambiar_password  BOOLEAN NOT NULL DEFAULT false,
  -- Desactivar la cuenta entera: solo MINCORE, desde plataforma. Una empresa
  -- desactiva su PERFIL, nunca la cuenta.
  activo                 BOOLEAN NOT NULL DEFAULT true,
  -- La última empresa que eligió, para preseleccionarla al volver a entrar.
  ultimo_tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  creado_en              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cuentas_email_minusculas CHECK (email = lower(email))
);

-- `ultimo_tenant_id` es una FK, y toda FK necesita su índice: sin él, borrar
-- un tenant obliga a un Seq Scan de `cuentas` para resolver el ON DELETE SET
-- NULL (ver docs/architecture/database-performance-guidelines.md; lo verifica
-- tests/db-index-coverage.test.ts). Parcial porque la enorme mayoría de las
-- filas lo tienen en NULL hasta que la persona elige empresa por primera vez.
CREATE INDEX IF NOT EXISTS idx_cuentas_ultimo_tenant
  ON cuentas(ultimo_tenant_id)
  WHERE ultimo_tenant_id IS NOT NULL;

-- ── 2. El perfil apunta a su cuenta ─────────────────────────────────────
--
-- NULL = operativo que entra por DNI (grifero, conductor). Todo lo que hoy
-- cuelga de usuarios.id -- sesiones, módulos, auditoría, la cola offline --
-- sigue colgando del PERFIL, a propósito (ver el documento, sección 4).

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS cuenta_id UUID REFERENCES cuentas(id);

-- Una persona tiene UN perfil por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_tenant_cuenta
  ON usuarios(tenant_id, cuenta_id)
  WHERE cuenta_id IS NOT NULL;

-- Para listar las empresas de una cuenta al entrar.
CREATE INDEX IF NOT EXISTS idx_usuarios_cuenta
  ON usuarios(cuenta_id)
  WHERE cuenta_id IS NOT NULL;

-- Un perfil con cuenta no guarda clave propia: la clave es de la cuenta.
-- Relajar un NOT NULL no rompe al código anterior, que siempre la escribe.
ALTER TABLE usuarios
  ALTER COLUMN password_hash DROP NOT NULL;

-- ── 3. Leer los perfiles de UNA cuenta, en todas sus empresas ───────────
--
-- Hace falta para listar las empresas de una persona al entrar. Es una
-- política SOLO de lectura, que se suma (OR) a tenant_isolation:
--
--   withCuenta() fija app.tenant_id en el uuid nulo -- no coincide con
--   ninguna empresa, y evita que tenant_isolation (sin missing_ok) falle --
--   y app.cuenta_id en la cuenta YA AUTENTICADA. Se ven los perfiles de esa
--   persona y nada más.
--
-- Por qué no una función SECURITY DEFINER: con FORCE ROW LEVEL SECURITY el
-- dueño también está sujeto a RLS, así que no la saltearía; y saltearla es
-- justo lo que no queremos. La política deja el alcance escrito en la base.
-- Las escrituras siguen limitadas a tenant_isolation.

DO $$ BEGIN
  CREATE POLICY perfiles_de_la_cuenta ON usuarios
    FOR SELECT
    USING (cuenta_id = NULLIF(current_setting('app.cuenta_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. Recuperar la clave es de la cuenta ───────────────────────────────
--
-- Un token de recuperación apunta a una cuenta (administrativos) o, como
-- hasta ahora, a un perfil de una empresa. Se relajan los NOT NULL (el
-- código anterior siempre llena los dos) y se exige al menos una de las dos
-- formas: todas las filas existentes ya la cumplen.

ALTER TABLE reset_tokens
  ADD COLUMN IF NOT EXISTS cuenta_id UUID REFERENCES cuentas(id) ON DELETE CASCADE;

ALTER TABLE reset_tokens
  ALTER COLUMN usuario_id DROP NOT NULL,
  ALTER COLUMN tenant_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE reset_tokens
    ADD CONSTRAINT reset_tokens_cuenta_o_perfil_check
    CHECK (cuenta_id IS NOT NULL OR (usuario_id IS NOT NULL AND tenant_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_reset_tokens_cuenta
  ON reset_tokens(cuenta_id)
  WHERE cuenta_id IS NOT NULL;

-- ── 5. Cada perfil con correo pasa a tener su cuenta ────────────────────
--
-- Empresa por empresa (ver el encabezado). Si el mismo correo ya estaba en
-- varias empresas, se une en UNA cuenta, que se queda con la clave del perfil
-- actualizado más recientemente: durante la copia, cuentas.actualizado_en
-- guarda el actualizado_en del perfil que aportó la clave, y un perfil más
-- nuevo la reemplaza.
--
-- Los perfiles sin correo (operativos por DNI) no tienen cuenta.

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    INSERT INTO cuentas (email, password_hash, debe_cambiar_password, creado_en, actualizado_en)
    SELECT DISTINCT ON (lower(u.email))
           lower(u.email), u.password_hash, u.debe_cambiar_password, u.creado_en, u.actualizado_en
      FROM usuarios u
     WHERE u.tenant_id = t.id
       AND u.email IS NOT NULL
       AND u.cuenta_id IS NULL
     ORDER BY lower(u.email), u.actualizado_en DESC
    ON CONFLICT (email) DO UPDATE
       SET password_hash         = EXCLUDED.password_hash,
           debe_cambiar_password = EXCLUDED.debe_cambiar_password,
           actualizado_en        = EXCLUDED.actualizado_en
     WHERE cuentas.actualizado_en < EXCLUDED.actualizado_en;

    UPDATE usuarios u
       SET cuenta_id = c.id
      FROM cuentas c
     WHERE u.tenant_id = t.id
       AND u.email IS NOT NULL
       AND u.cuenta_id IS NULL
       AND c.email = lower(u.email);
  END LOOP;

  -- La copia usó actualizado_en para elegir la clave más reciente; de acá en
  -- más significa lo de siempre.
  UPDATE cuentas SET actualizado_en = now();
END $$;
