-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: entrar con DNI desde el portal único, sin decir la empresa
--
-- El portal (portalempresas) es el mismo para todas las empresas. Con correo
-- ya funcionaba: la cuenta sabe en qué empresas está (0087). Con DNI no había
-- cómo ubicar el perfil sin la empresa, porque `usuarios` está bajo FORCE RLS
-- y el DNI no es único entre empresas.
--
-- Política SOLO de lectura, que se suma (OR) a tenant_isolation, igual que
-- perfiles_de_la_cuenta: withDniLogin() fija app.tenant_id en el uuid nulo y
-- app.dni_login en el DNI escrito, y se ven los perfiles de ESE DNI que no
-- tienen cuenta (los de cuenta entran por su correo). Nada más: no hay forma
-- de listar DNIs, y quién entra lo decide la clave, comparada en el servidor.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE POLICY perfiles_por_dni_login ON usuarios
    FOR SELECT
    USING (
      cuenta_id IS NULL
      AND dni IS NOT NULL
      AND dni = NULLIF(current_setting('app.dni_login', true), '')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_usuarios_dni_sin_cuenta
  ON usuarios(dni)
  WHERE cuenta_id IS NULL AND dni IS NOT NULL;
