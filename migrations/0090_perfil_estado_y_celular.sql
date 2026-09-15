-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: estado del perfil y celular (entrega 4)
--
-- La pantalla "Administración → Administración de usuarios" que pidió Kenif
-- muestra, por cada persona: nombre, id, correo, CELULAR, tipo de usuario y
-- ESTADO (activo, inactivo, bloqueado). Las dos últimas columnas son las que
-- no existían.
--
-- ── Por qué tres estados y no el booleano de hoy ────────────────────────
--
--   activo     entra normalmente.
--   inactivo   lo dio de baja un administrador. Es una DECISIÓN de alguien,
--              con motivo y con orden (entrega 5).
--   bloqueado  lo bloqueó el sistema por intentos fallidos. No es decisión de
--              nadie y se resuelve con un desbloqueo, no con un alta.
--
-- Mezclar los dos últimos en "inactivo" hace que nadie sepa, mirando la
-- pantalla, si a esa persona la dieron de baja o si simplemente se le trabó
-- la clave un lunes a la mañana.
--
-- ── Por qué `activo` sigue existiendo ───────────────────────────────────
--
-- Es un expand/contract. `usuarios.activo` lo leen hoy el login, el listado y
-- --lo que importa-- `findAdminsConModulo` (shared/utils/adminsDeModulo.ts),
-- de donde sale a quién se le avisa TODO lo anti-fraude de combustible:
-- umbrales aflojados, tanques sin medir, descuadres. Si esa consulta dejara de
-- encontrar admins, los correos no fallarían: dejarían de salir, en silencio.
--
-- Por eso las dos columnas conviven y un TRIGGER las mantiene coherentes en
-- los dos sentidos: el código viejo puede seguir escribiendo `activo` y el
-- nuevo escribe `estado`, y nunca quedan diciendo cosas distintas. El
-- contract --borrar `activo`-- es un paso aparte, cuando ya no quede ningún
-- lector.
--
-- ── El celular es del PERFIL, no de la cuenta ───────────────────────────
--
-- La misma persona puede tener distinto contacto en cada empresa (el teléfono
-- de la obra, el corporativo), y es la empresa la que lo mantiene. Va en
-- `usuarios`, que está bajo RLS, así que ninguna empresa ve el celular que esa
-- persona cargó en otra.
--
-- EJECUTAR (después de 0001):
--   psql -d mincoreerp -f migrations/0090_perfil_estado_y_celular.sql
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE estado_perfil AS ENUM ('activo', 'inactivo', 'bloqueado');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS estado estado_perfil NOT NULL DEFAULT 'activo',
  -- Sin formato fijo: un número de Perú, uno con prefijo de país, una
  -- extensión. Validar "9 dígitos" dejaría afuera contactos reales.
  ADD COLUMN IF NOT EXISTS celular VARCHAR(30),
  -- Cuántas veces seguidas erró la clave. Solo cuenta para el personal que
  -- entra por DNI: la clave de quien entra con correo es de su CUENTA, no de
  -- este perfil, y bloquearle el perfil de una empresa por errores que son de
  -- la persona sería castigar a la empresa equivocada.
  ADD COLUMN IF NOT EXISTS intentos_fallidos SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bloqueado_en TIMESTAMPTZ;

-- Los perfiles que ya estaban dados de baja arrancan como 'inactivo', no como
-- 'bloqueado': los desactivó alguien, que es la definición de inactivo.
--
-- Empresa por empresa con set_config, igual que la 0087: `usuarios` está bajo
-- FORCE ROW LEVEL SECURITY y su política de 0010 llama a
-- current_setting('app.tenant_id') SIN missing_ok, así que un UPDATE suelto
-- falla con "unrecognized configuration parameter" antes de tocar una fila.
-- Las migraciones corren como DUEÑO de la tabla, no como superusuario: FORCE
-- RLS también se les aplica.
DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE usuarios
       SET estado = 'inactivo'
     WHERE tenant_id = t.id AND activo = false AND estado = 'activo';
  END LOOP;
END $$;

-- ── El puente entre las dos columnas ───────────────────────────────────
--
-- Escriba quien escriba (código viejo o nuevo), las dos terminan diciendo lo
-- mismo. Si el UPDATE toca las DOS a la vez, manda `estado`: es la que tiene
-- más información (distingue inactivo de bloqueado).
CREATE OR REPLACE FUNCTION sincronizar_estado_perfil() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'activo' THEN
      NEW.activo := (NEW.estado = 'activo');
    ELSIF NEW.activo = false THEN
      NEW.estado := 'inactivo';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    NEW.activo := (NEW.estado = 'activo');
  ELSIF NEW.activo IS DISTINCT FROM OLD.activo THEN
    NEW.estado := CASE WHEN NEW.activo THEN 'activo' ELSE 'inactivo' END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sincronizar_estado_perfil ON usuarios;
CREATE TRIGGER trg_sincronizar_estado_perfil
  BEFORE INSERT OR UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION sincronizar_estado_perfil();

-- El listado de Administración filtra y ordena por estado.
CREATE INDEX IF NOT EXISTS idx_usuarios_tenant_estado ON usuarios(tenant_id, estado);

COMMENT ON COLUMN usuarios.estado IS
  'activo / inactivo (lo dio de baja un admin) / bloqueado (intentos fallidos). `activo` es la copia booleana que mantiene el trigger.';
