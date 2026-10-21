-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: historial de asignaciones de tanqueta a unidad, CON su vale
--
-- Kenif (2026-10-21): una tanqueta puede pasar días en planta sin asignar, así
-- que el vale de su salida a una unidad se escribe al ASIGNARLA desde la
-- pestaña Tanquetas, no al llenarla. Cada asignación (o reasignación) guarda
-- su serie y n° de vale, quién y cuándo.
--
-- Es un historial (una fila por asignación) y no columnas en la tanqueta: así
-- un vale usado hace meses sigue contando para que no se repita, aunque la
-- tanqueta ya haya pasado a otra unidad. El servicio lo mira junto con los
-- despachos y las líneas de excedente (existeVale).
--
-- Solo las asignaciones hechas desde la pestaña Tanquetas escriben aquí: las
-- de "Reserva en cubeta" (0139) y las del reparto del excedente (0140) ya
-- llevan su propio vale en el despacho o en la línea.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_tanqueta_asignaciones (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tanqueta_id      BIGINT NOT NULL,
  equipo_id        INTEGER NOT NULL REFERENCES equipos(id),
  serie_talonario  VARCHAR(20) NOT NULL CHECK (length(trim(serie_talonario)) > 0),
  n_vale           INTEGER NOT NULL CHECK (n_vale > 0),
  usuario_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, tanqueta_id) REFERENCES combustible_tanquetas (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_tanqueta_asig_tanqueta
  ON combustible_tanqueta_asignaciones (tenant_id, tanqueta_id, creado_en);
CREATE INDEX IF NOT EXISTS idx_tanqueta_asig_equipo
  ON combustible_tanqueta_asignaciones (tenant_id, equipo_id);
CREATE INDEX IF NOT EXISTS idx_tanqueta_asig_vale
  ON combustible_tanqueta_asignaciones (tenant_id, serie_talonario, n_vale);
CREATE INDEX IF NOT EXISTS idx_tanqueta_asig_usuario
  ON combustible_tanqueta_asignaciones (usuario_id) WHERE usuario_id IS NOT NULL;

ALTER TABLE combustible_tanqueta_asignaciones ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_tanqueta_asignaciones'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_tanqueta_asignaciones
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

ALTER TABLE combustible_tanqueta_asignaciones FORCE ROW LEVEL SECURITY;
