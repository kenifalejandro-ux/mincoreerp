-- Permisos granulares de navegación por usuario. Solo guarda overrides; las
-- pestañas sin fila usan el valor predeterminado definido por el rol.
--
-- id BIGSERIAL propio (y no solo la PK compuesta natural) porque el backup
-- self-service de un tenant (platformBackup.service.ts) asume una columna
-- `id` en toda tabla declarada en el registry -- ver tests/
-- backup-tablas-registradas.test.ts.
CREATE TABLE IF NOT EXISTS usuario_permisos_pestana (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo TEXT NOT NULL,
  pestana TEXT NOT NULL,
  permitido BOOLEAN NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, modulo, pestana)
);

CREATE INDEX IF NOT EXISTS usuario_permisos_pestana_tenant_usuario_idx
  ON usuario_permisos_pestana (tenant_id, usuario_id);

ALTER TABLE usuario_permisos_pestana ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_permisos_pestana FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'usuario_permisos_pestana'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON usuario_permisos_pestana
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;