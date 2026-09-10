-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: entrar con DNI, para la gente que no tiene correo
--
-- Pedido del cliente en la reunión del 2026-09-09: *"en vez de crearle un
-- usuario con correo... solamente con DNI y contraseña. O sea, no sería un
-- usuario, sino un acceso donde ellos puedan registrar"*.
--
-- El grifero y los conductores de ruta no tienen correo corporativo. Exigirles
-- uno para entrar al sistema significa inventarlo --y un correo inventado no
-- recibe nada, así que la recuperación de contraseña tampoco funcionaría, solo
-- lo parecería.
--
-- ── El obstáculo real ───────────────────────────────────────────────────
--
-- `usuarios.email` era NOT NULL desde la migración 0001. Un grifero sin correo
-- no entraba en la tabla. Pasa a ser OPCIONAL, con un CHECK que exige al menos
-- uno de los dos: sin correo NI DNI un usuario no podría entrar nunca, y una
-- fila así solo puede ser un error de carga.
--
-- El UNIQUE (tenant_id, email) de 0001 no se toca: Postgres permite varios
-- NULL en un UNIQUE, así que todos los usuarios sin correo conviven sin
-- chocar entre sí.
--
-- ── Por qué el DNI es único por TENANT y no global ──────────────────────
--
-- Mismo criterio que el email (0001): el ERP es SaaS y la misma persona puede
-- trabajar para dos empresas distintas. El DNI la identifica dentro de SU
-- empresa, no en el mundo.
--
-- ── Lo que esto NO resuelve, y hay que construir aparte ─────────────────
--
-- Sin correo NO HAY "olvidé mi contraseña": no hay a dónde mandar el enlace.
-- La salida es que un admin del tenant le genere una clave temporal, que es el
-- mecanismo que ya existe (`debe_cambiar_password`, migración de clave
-- temporal). Sin esa pantalla, un grifero que olvida la contraseña queda
-- afuera hasta que alguien toque la base a mano.
--
-- EJECUTAR (después de 0083):
--   psql -d mincoreerp -f migrations/0084_usuarios_acceso_por_dni.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS dni VARCHAR(15);

ALTER TABLE usuarios
  ALTER COLUMN email DROP NOT NULL;

-- Único por tenant, y PARCIAL: los usuarios sin DNI (todos los actuales) no
-- chocan entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_tenant_dni
  ON usuarios(tenant_id, dni)
  WHERE dni IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_email_o_dni_check'
  ) THEN
    ALTER TABLE usuarios
      ADD CONSTRAINT usuarios_email_o_dni_check
      -- A nivel de BASE y no solo de Zod: un INSERT directo (script de
      -- soporte, restore de backup) tiene que respetarlo igual. Un usuario sin
      -- ninguno de los dos no puede entrar nunca -- solo puede ser un error.
      CHECK (email IS NOT NULL OR dni IS NOT NULL);
  END IF;
END $$;
