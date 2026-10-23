-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el tanque de un retorno al pozo tiene que ser de la MISMA empresa
--
-- Auditoría de #316-#321, hallazgo 10 (defensa en profundidad). 0145 agregó
-- `combustible_id` a combustible_tanqueta_retornos con una FK simple a
-- combustible(id): la base aceptaba un retorno de la empresa A que apuntara al
-- tanque de la empresa B. Hoy ninguna consulta lo hace posible (todas filtran
-- por tenant_id y el servicio busca el tanque dentro de la empresa), pero un
-- error futuro podría abrirlo sin que nada lo frene.
--
-- Se reemplaza por una FK compuesta (tenant_id, combustible_id), como la que ya
-- usa la tanqueta destino (0146). Para poder referenciarla, combustible necesita
-- una restricción UNIQUE (tenant_id, id): es trivialmente cierta (id ya es la
-- clave primaria) y no cambia ningún dato.
-- ═══════════════════════════════════════════════════════════════════════════

-- La FK nueva se valida contra las filas existentes con una consulta que SÍ
-- pasa por RLS, y acá no hay app.tenant_id de sesión: va dentro de la ventana
-- NO FORCE (ver el gotcha de 0097).
ALTER TABLE combustible_tanqueta_retornos NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_tenant_id_id_key'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;

  -- Primero la nueva y después se suelta la vieja: en ningún momento queda sin FK.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tanqueta_retornos_combustible_tenant_fk'
  ) THEN
    ALTER TABLE combustible_tanqueta_retornos
      ADD CONSTRAINT tanqueta_retornos_combustible_tenant_fk
      FOREIGN KEY (tenant_id, combustible_id) REFERENCES combustible (tenant_id, id);
  END IF;

  ALTER TABLE combustible_tanqueta_retornos
    DROP CONSTRAINT IF EXISTS tanqueta_retornos_combustible_fk;
END $$;

ALTER TABLE combustible_tanqueta_retornos FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible FORCE ROW LEVEL SECURITY;
